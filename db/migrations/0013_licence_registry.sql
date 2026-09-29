-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Callsign validity from public licence registers (FCC ULS, ISED, ACMA, the Austrian and German
-- callsign lists). A row says only that a national register lists the call, whether that listing is
-- current, and until when; it is validity, never control-verification, and nothing is refused because a
-- call is missing (many countries publish no register).
--
-- The rows hold public-register facts about callsigns, not user data, and deliberately nothing else: no
-- name, address, email or licence class. The importer reads those fields out of the source files on the
-- operator's machine and drops them there. Each import of a source replaces that source's rows; a call
-- missing from the new import is deleted when the import completes.
--
--   callsign    the home call, uppercase, no SSID
--   source      the register it came from: fcc | ised | acma | at | de | …
--   status      licensed | expired  (a register listing that is no longer current reads as expired)
--   expires_at  unix seconds when the register gives an expiry, else NULL
--   updated_at  unix seconds of the import run that wrote the row (the import date)
CREATE TABLE IF NOT EXISTS licence_registry (
  callsign    TEXT NOT NULL,
  source      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('licensed', 'expired')),
  expires_at  INTEGER,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (callsign, source)
);
-- import bookkeeping: count this run's rows, then delete the rows an older run wrote
CREATE INDEX IF NOT EXISTS idx_licence_registry_source ON licence_registry (source, updated_at);
