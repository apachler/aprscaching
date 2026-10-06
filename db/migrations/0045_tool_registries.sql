-- Tool registries the Tools app lists (toolregistries.ts). A row with no account_id is the instance's, managed by
-- the sysop; one with an account_id is that player's own. `authority` is the key the person pinned after
-- comparing its fingerprint: the browser verifies every registry file against it and never takes a key from the
-- file. The project registry bundled with the app is the row `builtin` once the sysop switched it off; it has no
-- row while it is on. TOOL_REGISTRIES in the environment replaces the instance rows.
CREATE TABLE tool_registries (
  id           TEXT PRIMARY KEY,
  account_id   TEXT,
  spec         TEXT NOT NULL,                 -- the address as entered: https URL or github:owner/repo[/path][@ref]
  url          TEXT NOT NULL,                 -- the address fetched
  authority    TEXT NOT NULL,                 -- pinned Ed25519 public key, base64url
  label        TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  confirmed_at INTEGER NOT NULL,              -- when the key was last confirmed
  added_by     TEXT NOT NULL                  -- the call that added it, or OPERATOR for a scripted change
);
CREATE INDEX idx_tool_registries_account ON tool_registries (account_id);

-- The copies the gateway keeps of a registry's files when it fetches them for browsers: the registry file, the
-- manifests its entries name and the scripts those name. `body` is the last good copy, served while a refetch
-- fails; `tried_at` spaces out the attempts. The browser checks every signature; this is only a carrier.
CREATE TABLE tool_registry_files (
  registry_id  TEXT NOT NULL,
  url          TEXT NOT NULL,
  body         TEXT,
  content_type TEXT,
  bytes        INTEGER NOT NULL DEFAULT 0,
  fetched_at   INTEGER,                       -- when the last good copy arrived
  tried_at     INTEGER NOT NULL,              -- the last attempt, good or not
  error        TEXT,                          -- why the last attempt failed
  PRIMARY KEY (registry_id, url)
);
