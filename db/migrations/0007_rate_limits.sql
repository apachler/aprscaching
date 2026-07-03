-- SR-SEC-09: durable fixed-window rate-limit counters. The previous limiter was a module-level
-- Map — on Workers it resets per isolate (a fan-out silently multiplies every budget), and on any
-- runtime it forgets on restart. One row per (key), rolled over in place; the nightly job prunes
-- expired windows. reset_at is unix MILLISECONDS (matches the callers' Date.now() windows).
CREATE TABLE IF NOT EXISTS rate_limits (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);
