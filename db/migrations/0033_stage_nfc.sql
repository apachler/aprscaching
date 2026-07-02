-- SPDX-License-Identifier: AGPL-3.0-or-later
-- NFC stage unlock (docs/design/26 F-2): the original APRSCaching hid stage-2 coordinates behind an NFC tag.
-- A stage with unlock='nfc' carries a secret (the tag's text/serial); the finder reveals the stage by
-- presenting it — tapped in-browser via WebNFC (Android Chromium) or typed as a manual-code fallback.
-- The secret is never exposed by the read endpoints (those select explicit columns). All runtimes.
ALTER TABLE cache_stages ADD COLUMN unlock_secret TEXT;
