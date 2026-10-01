-- What unlocking an NFC stage reveals, sealed under its tag code (packages/shared stageseal.ts), so an
-- offline pack can carry it and the finder's phone opens it by scanning the tag. JSON; NULL for other unlock
-- kinds and for codes too weak to seal (those stages stay online-only).
ALTER TABLE cache_stages ADD COLUMN sealed TEXT;
