export interface Env {
  BOT_TOKEN: string;           // Telegram bot token (from @BotFather)
  TG_WEBHOOK_SECRET: string;   // Secret token to validate webhook (X-Telegram-Bot-Api-Secret-Token)
  HMAC_SECRET: string;         // Secret used to sign download tokens
  API_ID: string;              // MTProto api_id (my.telegram.org/apps)
  API_HASH: string;            // MTProto api_hash (my.telegram.org/apps)
  SHARDS?: string;             // number of DO shards for parallel ranges (default 16)
  STREAMER: DurableObjectNamespace;
}

export type TokenPayloadV1 = {
  v: 1;
  chatId: number;     // Bot API chat.id
  msgId: number;      // Bot API message_id
  exp: number;        // unix seconds
  inline?: 1;         // optional: force Content-Disposition inline
};
