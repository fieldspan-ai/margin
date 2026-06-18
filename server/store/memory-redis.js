// In-memory, Redis-compatible client — exactly the ops backend-kv.js uses
// (get/set/mget/zadd/zrange/incr/expire), backed by plain Maps.
//
// It lets `STORE=memory` run the *real* KV code path locally and in tests with
// zero infrastructure (no Upstash, no Docker). It is NOT persistent across
// process restarts — use the JSON backend (the default) for durable local data.
export function createMemoryRedis() {
  const kv = new Map();
  const z = new Map(); // key -> Map(member -> score)
  return {
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async set(k, v) { kv.set(k, v); },
    async mget(...keys) { return keys.map((k) => (kv.has(k) ? kv.get(k) : null)); },
    async zadd(k, { score, member }) { if (!z.has(k)) z.set(k, new Map()); z.get(k).set(member, score); },
    async zrange(k, start, stop, opts) {
      const m = z.get(k);
      if (!m) return [];
      let arr = [...m.entries()].sort((a, b) => a[1] - b[1]);
      if (opts && opts.rev) arr.reverse();
      return arr.map((e) => e[0]);
    },
    async incr(k) { const n = (Number(kv.get(k)) || 0) + 1; kv.set(k, String(n)); return n; },
    async expire(k, sec) { const t = setTimeout(() => kv.delete(k), sec * 1000); if (t.unref) t.unref(); return 1; },
  };
}
