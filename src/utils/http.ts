export type ByteRange = { start: number; end: number; isRange: boolean };

export function parseRange(rangeHeader: string | null, size: number): ByteRange | null {
  if (!rangeHeader) return { start: 0, end: size - 1, isRange: false };
  const m = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!m) return null;

  let startStr = m[1];
  let endStr = m[2];

  // bytes=-500 (suffix)
  if (startStr === "" && endStr !== "") {
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1, isRange: true };
  }

  const start = Number(startStr);
  if (!Number.isFinite(start) || start < 0) return null;

  // bytes=500- (to end)
  let end = endStr === "" ? size - 1 : Number(endStr);
  if (!Number.isFinite(end) || end < start) return null;

  if (start >= size) return null;
  end = Math.min(end, size - 1);

  return { start, end, isRange: true };
}

export function formatContentDisposition(filename: string, inline: boolean): string {
  // basic filename (ASCII-safe-ish)
  const fallback = filename
    .replace(/[\r\n"]/g, "")
    .replace(/[/\\]/g, "_")
    .slice(0, 180) || "file";

  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, "%2A");
  const type = inline ? "inline" : "attachment";
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function sanitizeFilename(name: string): string {
  const trimmed = (name || "").trim();
  if (!trimmed) return "file";
  return trimmed
    .replace(/[\r\n\0]/g, "")
    .replace(/[/\\]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

export function guessExtFromMime(mime: string | undefined): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("pdf")) return "pdf";
  if (m.includes("zip")) return "zip";
  if (m.includes("rar")) return "rar";
  if (m.includes("7z")) return "7z";
  if (m.includes("json")) return "json";
  if (m.includes("gzip")) return "gz";
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("mpeg")) return "mpg";
  if (m.includes("mp3")) return "mp3";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("wav")) return "wav";
  if (m.includes("flac")) return "flac";
  if (m.includes("text")) return "txt";
  return "";
}

export function humanSize(bytes: number | undefined): string {
  if (!bytes || bytes < 0) return "نامشخص";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
