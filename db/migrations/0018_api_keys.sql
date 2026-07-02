-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Public read API (docs/design/11 §6, ADR-4a): free, per-IP rate-limited; free api_keys raise the limit
-- (recognition model — keys are never paywalled). Read-only; keys carry no scopes beyond the
-- public read surface today.
CREATE TABLE IF NOT EXISTS api_keys (
  key          TEXT PRIMARY KEY,
  owner_call   TEXT,
  label        TEXT,
  rate_tier    TEXT NOT NULL DEFAULT 'free',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys (owner_call);
