-- A new account shares nothing it did not choose to: the watch-alert email digest and the public profile both
-- start off. SQLite cannot change a column default in place, so the table is rebuilt with the same columns,
-- rows and indexes. Every other per-account setting already starts off (announce_is, near_radio) or empty.
CREATE TABLE accounts_new (
  callsign       TEXT PRIMARY KEY,                 -- the active operating call (may carry an SSID)
  account_id     TEXT NOT NULL,                    -- durable identity; every account row carries one
  email          TEXT,                             -- recovery / magic-link address (never shown)
  created_at     INTEGER NOT NULL,
  -- a session names the account and this generation; bumping it ends every session the account holds
  -- (sign out everywhere, active-call change)
  session_gen    INTEGER NOT NULL DEFAULT 0,
  -- opt-in profile, self-curated
  display_name   TEXT,
  home_grid      TEXT,                             -- Maidenhead locator
  avatar_url     TEXT,
  bio            TEXT,                             -- short plain text, length-capped + tag-stripped server-side
  links          TEXT,                             -- JSON [{label,url}], http(s) only, capped count
  public_contact TEXT,                             -- opt-in public email; NULL = not shown
  profile_public INTEGER NOT NULL DEFAULT 0,       -- master show/hide of the fields above; off until the owner shows them
  -- APRS-IS announce of the user's finds: opt-in, gated on callsign control-verification
  announce_is    INTEGER NOT NULL DEFAULT 0,
  announce_tocall TEXT DEFAULT 'APZACG',           -- experimental tocall until one is registered
  -- the watch-alert email digest, the fallback for devices without push: off until the user turns it on
  notify_digest  INTEGER NOT NULL DEFAULT 0,
  -- supporter recognition: a thank-you level and the hidden support prompt. Recognition only; no
  -- handler reads these to restrict anything.
  tier           TEXT    NOT NULL DEFAULT 'free',  -- free | supporter
  hide_nag       INTEGER NOT NULL DEFAULT 0,
  near_radio     INTEGER NOT NULL DEFAULT 0,       -- the service call messages the user's stations near a cache
  pending_email  TEXT                              -- an address given at registration, unconfirmed
);
INSERT INTO accounts_new (callsign, account_id, email, created_at, session_gen, display_name, home_grid, avatar_url,
  bio, links, public_contact, profile_public, announce_is, announce_tocall, notify_digest, tier, hide_nag,
  near_radio, pending_email)
SELECT callsign, account_id, email, created_at, session_gen, display_name, home_grid, avatar_url,
  bio, links, public_contact, profile_public, announce_is, announce_tocall, notify_digest, tier, hide_nag,
  near_radio, pending_email
FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;
CREATE UNIQUE INDEX idx_accounts_account_id ON accounts (account_id);
CREATE INDEX idx_accounts_email ON accounts (email);
CREATE UNIQUE INDEX idx_accounts_email_unique ON accounts (lower(email)) WHERE email IS NOT NULL;
