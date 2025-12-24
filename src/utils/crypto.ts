import { b64urlEncode, b64urlDecodeToBytes } from "./base64url";

const te = new TextEncoder();

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signToken(payloadJson: string, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const data = te.encode(payloadJson);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  return `${b64urlEncode(data)}.${b64urlEncode(sig)}`;
}

export async function verifyToken(token: string, secret: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const data = b64urlDecodeToBytes(parts[0]);
  const sig = b64urlDecodeToBytes(parts[1]);
  const key = await importHmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, sig, data);
  if (!ok) return null;
  return new TextDecoder().decode(data);
}

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}
