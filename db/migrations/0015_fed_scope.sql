-- 0015_fed_scope.sql — F6/T3.3: owner-controlled federation scope + spoiler protection.
--
-- Owners choose how far a cache travels on the network:
--   public     — federates with description (the default); the hint is NEVER federated (spoiler).
--   unlisted   — federates location/title only; description is withheld (visit the home instance).
--   local-only — never leaves this instance (excluded from /federation/caches entirely).
-- Enforced at the feed (federation.ts:cacheData drops hint always, description when unlisted;
-- CACHE_FEED filters local-only), so redaction happens before anything is signed and sent.
ALTER TABLE caches ADD COLUMN fed_scope TEXT NOT NULL DEFAULT 'public'; -- public | unlisted | local-only
