import type { Env, TokenPayloadV1 } from "./types";
import { verifyToken, nowUnix } from "./utils/crypto";
import { parseRange, formatContentDisposition, sanitizeFilename, guessExtFromMime } from "./utils/http";

// IMPORTANT: This implementation uses MTProto to fetch the file bytes (upload.getFile),
// so it is NOT limited by the 20MB Bot API download limit.

type PeerInfo =
  | { kind: "user"; user_id: number; access_hash: string }
  | { kind: "chat"; chat_id: number }
  | { kind: "channel"; channel_id: number; access_hash: string };

type ResolvedFile = {
  location: any; // TL InputFileLocation
  size: number;
  mime: string;
  filename: string;
};

export class StreamerDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  private tgPromise: Promise<any> | null = null;

  // cache peers by Bot API chat.id
  private peers = new Map<number, PeerInfo>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/dl/")) {
      return new Response("not found", { status: 404 });
    }

    const token = decodeURIComponent(url.pathname.slice("/dl/".length));
    const payloadJson = await verifyToken(token, this.env.HMAC_SECRET);
    if (!payloadJson) return new Response("bad token", { status: 401 });

    let payload: TokenPayloadV1;
    try { payload = JSON.parse(payloadJson); } catch { return new Response("bad token", { status: 401 }); }
    if (payload.v !== 1) return new Response("unsupported token", { status: 400 });
    if (payload.exp <= nowUnix()) return new Response("expired", { status: 410 });

    const tg = await this.getClient();

    let resolved: ResolvedFile;
    try {
      resolved = await this.resolveFile(tg, payload.chatId, payload.msgId);
    } catch (e: any) {
      return new Response(`resolve error: ${e?.message || String(e)}`, { status: 502 });
    }

    const range = parseRange(request.headers.get("Range"), resolved.size);
    if (!range) {
      return new Response("invalid range", {
        status: 416,
        headers: { "Content-Range": `bytes */${resolved.size}` },
      });
    }

    const inline = payload.inline === 1 || url.searchParams.get("inline") === "1";
    const headers = new Headers();
    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Type", resolved.mime || "application/octet-stream");
    headers.set("Content-Disposition", formatContentDisposition(resolved.filename, inline));

    const contentLength = range.end - range.start + 1;
    headers.set("Content-Length", String(contentLength));

    if (range.isRange) {
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${resolved.size}`);
    }

    if (request.method === "HEAD") {
      return new Response(null, { status: range.isRange ? 206 : 200, headers });
    }

    const bodyStream = this.streamMtprotoFile(tg, resolved.location, range.start, range.end);

    return new Response(bodyStream, { status: range.isRange ? 206 : 200, headers });
  }

  private async getClient(): Promise<any> {
    if (!this.tgPromise) {
      this.tgPromise = this.createClient();
    }
    return this.tgPromise;
  }

  private async createClient(): Promise<any> {
    // IMPORTANT: In Cloudflare Workers we must explicitly provide storage, transport, crypto and platform
    // to @mtcute/core, otherwise it will throw at runtime.
    const { TelegramClient } = await import("@mtcute/core/client.js");
    const web = await import("@mtcute/web");

    const CryptoCls =
      (web as any).WebCryptoProvider ??
      (web as any).CryptoProvider ??
      (web as any).WasmCryptoProvider;

    const TransportCls =
      (web as any).WebSocketTransport ??
      (web as any).TransportWebSocket;

    const PlatformCls =
      (web as any).WebPlatform ??
      (web as any).PlatformWeb;

    if (!CryptoCls) {
      throw new Error("Could not find a crypto provider in @mtcute/web (expected WebCryptoProvider).");
    }
    if (!TransportCls) {
      throw new Error("Could not find a WebSocket transport in @mtcute/web (expected WebSocketTransport).");
    }
    if (!PlatformCls) {
      throw new Error("Could not find a platform implementation in @mtcute/web (expected WebPlatform).");
    }

    const crypto = new CryptoCls();
    // some providers need async init (safe no-op if missing)
    if (typeof (crypto as any).initialize === "function") {
      await (crypto as any).initialize();
    }

    const transport = new TransportCls();
    const platform = new PlatformCls();

    // We prefer an in-memory storage provider to avoid IndexedDB/SQLite assumptions.
    // This keeps the session within the Durable Object lifetime.
    let storage: any | undefined;
    const storageImportCandidates = [
      "@mtcute/core",
      "@mtcute/core/storage/index.js",
      "@mtcute/core/storage/memory",
      "@mtcute/core/storage/memory.js",
      "@mtcute/core/storage/memory/index.js",
    ] as const;

    for (const spec of storageImportCandidates) {
      try {
        const mod: any = await import(spec as any);
        const StorageCls =
          mod?.MemoryStorage ??
          mod?.InMemoryStorage ??
          mod?.MemoryStorageProvider ??
          mod?.MemorySessionStorage;
        if (StorageCls) {
          storage = new StorageCls();
          break;
        }
      } catch {
        // ignore and try next
      }
    }

    if (!storage) {
      throw new Error(
        "Could not find an in-memory storage provider (MemoryStorage) in @mtcute/core. " +
          "Please update mtcute packages or adjust imports."
      );
    }

    const apiId = Number(this.env.API_ID);
    const apiHash = this.env.API_HASH;

    const tg = new TelegramClient({
      apiId,
      apiHash,
      crypto,
      platform,
      transport,
      storage,
      // we only use MTProto to fetch file bytes, no updates needed
      disableUpdates: true,
    });

    await tg.start({ botToken: this.env.BOT_TOKEN });

    return tg;
  }

  private async resolvePeer(tg: any, botApiChatId: number): Promise<PeerInfo> {
    const cached = this.peers.get(botApiChatId);
    if (cached) return cached;

    // Basic group: Bot API chat id is negative but not -100...
    if (botApiChatId < 0 && !String(botApiChatId).startsWith("-100")) {
      const peer: PeerInfo = { kind: "chat", chat_id: Math.abs(botApiChatId) };
      this.peers.set(botApiChatId, peer);
      return peer;
    }

    // For users and channels/supergroups, we need access_hash -> pull from dialogs
    const dialogs = await tg.call({
      _: "messages.getDialogs",
      offset_date: 0,
      offset_id: 0,
      offset_peer: { _: "inputPeerEmpty" },
      limit: 100,
      hash: 0,
    });

    // users (private chats)
    if (Array.isArray((dialogs as any).users)) {
      for (const u of (dialogs as any).users) {
        if (u && u._ === "user" && typeof u.id === "number" && u.access_hash != null) {
          const chatId = u.id;
          const peer: PeerInfo = { kind: "user", user_id: u.id, access_hash: String(u.access_hash) };
          this.peers.set(chatId, peer);
        }
      }
    }

    // chats (groups and channels)
    if (Array.isArray((dialogs as any).chats)) {
      for (const c of (dialogs as any).chats) {
        if (!c || typeof c.id !== "number") continue;
        if (c._ === "chat") {
          const chatId = -c.id;
          const peer: PeerInfo = { kind: "chat", chat_id: c.id };
          this.peers.set(chatId, peer);
        } else if (c._ === "channel" && c.access_hash != null) {
          const botChatId = -1000000000000 - c.id;
          const peer: PeerInfo = { kind: "channel", channel_id: c.id, access_hash: String(c.access_hash) };
          this.peers.set(botChatId, peer);
        }
      }
    }

    const found = this.peers.get(botApiChatId);
    if (!found) {
      throw new Error("peer not found in dialogs. Send /start to the bot in that chat and try again.");
    }
    return found;
  }

  private toInputPeer(peer: PeerInfo): any {
    if (peer.kind === "chat") return { _: "inputPeerChat", chat_id: peer.chat_id };
    if (peer.kind === "user") return { _: "inputPeerUser", user_id: peer.user_id, access_hash: peer.access_hash };
    return { _: "inputPeerChannel", channel_id: peer.channel_id, access_hash: peer.access_hash };
  }

  private async resolveFile(tg: any, chatId: number, msgId: number): Promise<ResolvedFile> {
    const peerInfo = await this.resolvePeer(tg, chatId);
    const peer = this.toInputPeer(peerInfo);

    const history = await tg.call({
      _: "messages.getHistory",
      peer,
      offset_id: msgId + 1,
      offset_date: 0,
      add_offset: 0,
      limit: 1,
      max_id: 0,
      min_id: 0,
      hash: 0,
    });

    const msg = (history as any).messages?.[0];
    if (!msg) throw new Error("message not found");
    if (msg._ !== "message" && msg._ !== "messageService") throw new Error("unsupported message type");
    if (!msg.media) throw new Error("no media in message");

    // document
    if (msg.media._ === "messageMediaDocument" && msg.media.document && msg.media.document._ === "document") {
      const d = msg.media.document;
      const mime = d.mime_type || "application/octet-stream";
      const size = Number(d.size || 0);
      const attrs = Array.isArray(d.attributes) ? d.attributes : [];
      let filename: string | null = null;
      for (const a of attrs) {
        if (a && a._ === "documentAttributeFilename" && typeof a.file_name === "string") {
          filename = a.file_name;
        }
      }
      if (!filename) {
        const ext = guessExtFromMime(mime);
        filename = `file_${d.id}${ext ? "." + ext : ""}`;
      }
      filename = sanitizeFilename(filename);

      const location = {
        _: "inputDocumentFileLocation",
        id: d.id,
        access_hash: d.access_hash,
        file_reference: d.file_reference,
        thumb_size: "",
      };

      return { location, size, mime, filename };
    }

    // photo
    if (msg.media._ === "messageMediaPhoto" && msg.media.photo && msg.media.photo._ === "photo") {
      const p = msg.media.photo;
      const mime = "image/jpeg";

      const sizes = Array.isArray(p.sizes) ? p.sizes : [];
      let best: any = null;
      let bestSize = -1;

      for (const s of sizes) {
        if (!s) continue;
        if (s._ === "photoSize" && typeof s.size === "number") {
          if (s.size > bestSize) { best = s; bestSize = s.size; }
        } else if (s._ === "photoSizeProgressive" && Array.isArray(s.sizes)) {
          const mx = Math.max(...s.sizes.filter((x: any) => typeof x === "number"));
          if (mx > bestSize) { best = s; bestSize = mx; }
        } else if (s._ === "photoCachedSize" && s.bytes) {
          const len = (s.bytes as Uint8Array).byteLength ?? (s.bytes.length ?? 0);
          if (len > bestSize) { best = s; bestSize = len; }
        }
      }

      if (!best) throw new Error("photo size not found");
      const thumb_size = best.type || "w";
      const size = bestSize > 0 ? bestSize : 0;
      const filename = `photo_${p.id}.jpg`;

      const location = {
        _: "inputPhotoFileLocation",
        id: p.id,
        access_hash: p.access_hash,
        file_reference: p.file_reference,
        thumb_size,
      };

      return { location, size, mime, filename };
    }

    // other media types usually wrap document
    throw new Error(`unsupported media: ${msg.media._}`);
  }

  private streamMtprotoFile(tg: any, location: any, start: number, end: number): ReadableStream<Uint8Array> {
    const chunkSize = 512 * 1024; // 512KB per MTProto request (keep memory low)
    let offset = start;

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (offset > end) {
          controller.close();
          return;
        }
        const need = Math.min(chunkSize, end - offset + 1);

        const bytes = await this.downloadChunkWithCdnFallback(tg, location, offset, need);

        if (!bytes || bytes.length === 0) {
          controller.error(new Error("empty chunk"));
          return;
        }

        offset += bytes.length;
        controller.enqueue(bytes);
      },
      cancel: async () => {
        // nothing
      }
    });
  }

  private async downloadChunkWithCdnFallback(tg: any, location: any, offset: number, limit: number): Promise<Uint8Array> {
    // Try with cdn_supported=true first. If Telegram returns a CDN redirect (upload.fileCdnRedirect),
    // bots cannot use upload.getCdnFile (user-only), so we retry without CDN support.
    // Ref: Telegram docs - upload.getCdnFile is only available for users.
    const first = await tg.call({
      _: "upload.getFile",
      location,
      offset,
      limit,
      precise: true,
      cdn_supported: true,
    });

    if (first?._ === "upload.file") {
      return (first.bytes as Uint8Array) || new Uint8Array();
    }

    if (first?._ === "upload.fileCdnRedirect") {
      // retry without cdn_supported
      const second = await tg.call({
        _: "upload.getFile",
        location,
        offset,
        limit,
        precise: true,
      });
      if (second?._ === "upload.file") {
        return (second.bytes as Uint8Array) || new Uint8Array();
      }
      throw new Error(`CDN redirect fallback failed: ${second?._ || "unknown"}`);
    }

    throw new Error(`unexpected upload.getFile result: ${first?._ || "unknown"}`);
  }
}
