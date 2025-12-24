import type { Env, TokenPayloadV1 } from "./types";
import { signToken, nowUnix } from "./utils/crypto";
import { parseRange, sanitizeFilename } from "./utils/http";
import { tgCall } from "./tg/botapi";
import { describeIncomingFile, buildReplyText } from "./tg/format";
import { pickShard } from "./shard";
import { StreamerDO } from "./streamer-do";

export { StreamerDO };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        `OK\n\n- Webhook: POST /tg/webhook\n- Download: GET/HEAD /dl/<token>\n`,
        { headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }

    // Telegram webhook (Bot API)
    if (url.pathname === "/tg/webhook") {
      if (request.method !== "POST") return text("method not allowed", 405);

      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!secret || secret !== env.TG_WEBHOOK_SECRET) {
        return text("unauthorized", 401);
      }

      const update = await request.json<any>();
      const msg = update.message || update.channel_post || update.edited_message || update.edited_channel_post;
      if (!msg) return json({ ok: true });

      const fileInfo = describeIncomingFile(msg);
      if (!fileInfo) {
        // Ignore non-file messages (or reply with help)
        return json({ ok: true });
      }

      const chatId = msg.chat?.id;
      const msgId = msg.message_id;

      if (typeof chatId !== "number" || typeof msgId !== "number") return json({ ok: true });

      const base = `${url.protocol}//${url.host}`;
      const payload: TokenPayloadV1 = {
        v: 1,
        chatId,
        msgId,
        exp: nowUnix() + 6 * 60 * 60, // 6h
      };
      const token = await signToken(JSON.stringify(payload), env.HMAC_SECRET);
      const dlUrl = `${base}/dl/${encodeURIComponent(token)}`;

      const replyText = buildReplyText(sanitizeFilename(fileInfo.filename), fileInfo.size, dlUrl);

      const keyboard = {
        inline_keyboard: [
          [{ text: "⬇️ دانلود", url: dlUrl }],
          [{ text: "📋 کپی لینک", switch_inline_query: dlUrl }],
        ],
      };

      ctx.waitUntil(
        tgCall(env, "sendMessage", {
          chat_id: chatId,
          reply_to_message_id: msgId,
          text: replyText,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: keyboard,
        }).catch(() => {})
      );

      return json({ ok: true });
    }

    // Download path: shard + forward to Durable Object (for parallel range support)
    if (url.pathname.startsWith("/dl/")) {
      const token = url.pathname.slice("/dl/".length);
      const range = request.headers.get("Range");
      let rangeStart = 0;
      if (range) {
        const m = /^bytes=(\d+)-/i.exec(range.trim());
        if (m) rangeStart = Number(m[1]) || 0;
      }
      const shards = Math.max(1, Number(env.SHARDS || "16") || 16);
      const name = pickShard(token, rangeStart, shards);
      const id = env.STREAMER.idFromName(name);
      const stub = env.STREAMER.get(id);

      // Forward request to DO
      return stub.fetch(request);
    }

    return text("not found", 404);
  },
};
