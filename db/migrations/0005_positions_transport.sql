-- SPDX-License-Identifier: AGPL-3.0-or-later
-- How each stored position reached the gateway (the provenance Transport: aprs-is, tnc, browser-rf,
-- axudp, axip, meshcom, meshtastic, …), derived from the ingest port. Recorded for display and statistics;
-- the verify engine never branches on it — Tier A stays gated on first-party attestation alone. Rows
-- stored before this column exist read as NULL and keep the earlier derivation (app or aprs-is).
ALTER TABLE positions ADD COLUMN transport TEXT;
