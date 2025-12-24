import type { Env } from "../types";

export async function tgCall<T>(env: Env, method: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json<any>();
  if (!data.ok) {
    throw new Error(`Telegram Bot API error: ${data.error_code} ${data.description}`);
  }
  return data.result as T;
}
