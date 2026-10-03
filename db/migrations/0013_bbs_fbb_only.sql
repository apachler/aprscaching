-- The BBS moves mail the F6FBB way only: it never delivers over APRS, so it keeps no APRS delivery state.
DROP INDEX IF EXISTS idx_bbs_delivery_call;
DROP TABLE IF EXISTS bbs_delivery;
