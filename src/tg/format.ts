import { humanSize, sanitizeFilename } from "../utils/http";

export function describeIncomingFile(msg: any): { filename: string; size?: number; kind: string } | null {
  // Bot API update message
  // document
  if (msg.document) {
    const fn = sanitizeFilename(msg.document.file_name || "file");
    return { filename: fn, size: msg.document.file_size, kind: "document" };
  }
  // video / audio / voice / animation / video_note / sticker
  const mediaFields = ["video","audio","voice","animation","video_note","sticker","photo"] as const;
  for (const f of mediaFields) {
    if (msg[f]) {
      if (f === "photo") {
        // choose biggest photo size
        const arr = msg.photo;
        const biggest = Array.isArray(arr) ? arr.reduce((a: any, b: any) => (a?.file_size || 0) >= (b?.file_size || 0) ? a : b, null) : null;
        const size = biggest?.file_size;
        return { filename: "photo.jpg", size, kind: "photo" };
      }
      const obj = msg[f];
      const size = obj?.file_size;
      const fn = sanitizeFilename(obj?.file_name || `${f}${obj?.file_unique_id ? "_" + obj.file_unique_id : ""}`);
      return { filename: fn, size, kind: f };
    }
  }
  return null;
}

export function buildReplyText(filename: string, size?: number, url?: string): string {
  const sizeTxt = size ? humanSize(size) : "نامشخص";
  const safe = filename.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const parts = [
    `📦 <b>فایل آماده دانلود شد</b>`,
    `📝 <b>نام:</b> <code>${safe}</code>`,
    `📏 <b>حجم:</b> <b>${sizeTxt}</b>`,
  ];
  if (url) {
    parts.push(`🔗 <b>لینک:</b> <code>${url}</code>`);
  }
  parts.push("", `✅ می‌تونی با Download Manager هم دانلود کنی (پشتیبانی Range/Resume).`);
  return parts.join("\n");
}
