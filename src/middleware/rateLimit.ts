import type { Request, Response, NextFunction } from "express";

export interface RateLimitOptions {
  /** Rolling window length in ms. */
  windowMs: number;
  /** Max requests per IP per window. */
  max: number;
  /** Max tracked IPs (evicted LRU) to bound the rate-limiter's own memory use. */
  maxTrackedIps?: number;
}

interface Counter {
  count: number;
  windowStart: number;
  lastSeen: number;
}

/**
 * Fixed-window per-IP rate limiter. In-process only — good enough for a DCR
 * flood guard on a single node. For multi-node, back this with Redis or
 * DynamoDB (same shape, swap the Map).
 *
 * Expects Express `trust proxy` to be set when behind an ALB/CloudFront so
 * `req.ip` is the real client IP, not the load balancer.
 */
export function rateLimit(opts: RateLimitOptions) {
  const counters = new Map<string, Counter>();
  const cap = opts.maxTrackedIps ?? 10_000;

  return function (req: Request, res: Response, next: NextFunction) {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    let c = counters.get(ip);

    if (!c || now - c.windowStart >= opts.windowMs) {
      c = { count: 0, windowStart: now, lastSeen: now };
      counters.set(ip, c);
    }
    c.count += 1;
    c.lastSeen = now;

    if (counters.size > cap) evictLru(counters);

    if (c.count > opts.max) {
      const retryAfterSec = Math.ceil((c.windowStart + opts.windowMs - now) / 1000);
      res.setHeader("Retry-After", String(Math.max(1, retryAfterSec)));
      return res.status(429).json({
        error: "rate_limited",
        error_description: `Too many requests. Try again in ${retryAfterSec}s.`
      });
    }

    next();
  };
}

function evictLru(counters: Map<string, Counter>): void {
  let oldestIp: string | null = null;
  let oldestSeen = Infinity;
  for (const [ip, c] of counters) {
    if (c.lastSeen < oldestSeen) {
      oldestSeen = c.lastSeen;
      oldestIp = ip;
    }
  }
  if (oldestIp) counters.delete(oldestIp);
}
