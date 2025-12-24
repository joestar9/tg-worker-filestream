export function pickShard(token: string, rangeStart: number, shardCount: number): string {
  // Spread parallel-range connections across shards by mixing token + range bucket
  const bucketSize = 16 * 1024 * 1024; // 16MB buckets
  const bucket = Math.floor(Math.max(0, rangeStart) / bucketSize);
  const key = `${token}:${bucket}`;
  const h = fnv1a32(key);
  const shard = h % shardCount;
  return `shard-${shard}`;
}

function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
