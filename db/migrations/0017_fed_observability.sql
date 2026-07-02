-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0017_fed_observability.sql — F7/T4.3: federation observability.
--
-- Per-peer sync metrics so an operator can see the health of the network: successful/failed sync
-- counts, the last SUCCESSFUL sync time (vs last_sync = last attempt → lag = now - last_ok), the
-- cumulative records mirrored, and the last sync's per-feed breakdown. Extends fed_peers.last_sync/
-- last_error (already present). Feeds the T1.1 reputation loop with measured inputs.
ALTER TABLE fed_peers ADD COLUMN last_ok        INTEGER;                 -- last SUCCESSFUL sync (unix s)
ALTER TABLE fed_peers ADD COLUMN sync_ok        INTEGER NOT NULL DEFAULT 0; -- successful sync count
ALTER TABLE fed_peers ADD COLUMN sync_err       INTEGER NOT NULL DEFAULT 0; -- failed sync count
ALTER TABLE fed_peers ADD COLUMN mirrored_total INTEGER NOT NULL DEFAULT 0; -- cumulative records mirrored
ALTER TABLE fed_peers ADD COLUMN last_counts    TEXT;                    -- JSON per-feed counts of the last sync
