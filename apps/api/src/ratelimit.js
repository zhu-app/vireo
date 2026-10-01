/**
 * 轻量内存限流（无外部依赖）。按 key 滑窗计数，超阈值返回 429。
 * 生产单实例部署够用；多实例横向扩展时应换成 Redis 等集中存储。
 */
export function rateLimit({ windowMs = 60_000, max = 10, keyFn, message = '请求过于频繁，请稍后再试' } = {}) {
  const hits = new Map(); // key -> { count, resetAt }

  // 定期清理过期桶，避免内存随 key 数量无限增长
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, bucket] of hits) if (bucket.resetAt <= now) hits.delete(k);
  }, Math.max(windowMs, 30_000));
  sweeper.unref?.();

  return function limitMiddleware(req, res, next) {
    const key = keyFn ? keyFn(req) : req.ip;
    const now = Date.now();
    let bucket = hits.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      hits.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      return res.status(429).json({ error: message });
    }
    next();
  };
}
