-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Weather TX. Per-PWS opt-in flags (off by default,
-- gated on a control-verified callsign) and a beacon throttle, plus an outbox target so the ingest
-- box routes a queued WX report to standard APRS-IS (W2) or to CWOP/NOAA (W3).
ALTER TABLE wx_keys ADD COLUMN tx_is       INTEGER NOT NULL DEFAULT 0;  -- W2: beacon to APRS-IS
ALTER TABLE wx_keys ADD COLUMN tx_cwop     INTEGER NOT NULL DEFAULT 0;  -- W3: relay to CWOP (NOAA)
ALTER TABLE wx_keys ADD COLUMN last_beacon INTEGER;                     -- throttle (epoch s)

ALTER TABLE aprs_outbox ADD COLUMN target TEXT NOT NULL DEFAULT 'is';   -- is | cwop  (drain routing)
