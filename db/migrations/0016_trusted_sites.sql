-- Receiving sites the sysop trusts from Instance admin. A trusted site counts for Tier A beside the sites in
-- FIRST_PARTY_SITES (the configuration's preset list): only a frame that site's own receiver heard directly,
-- delivered by an ingest box, is attested. Default-deny: no row, no trust.

-- A station the sysop adds by its site call, such as their own box on the shared INGEST_SECRET.
CREATE TABLE trusted_sites (
  site       TEXT PRIMARY KEY,                     -- the receiving site call, upper-case, with SSID
  trusted_by TEXT NOT NULL,                        -- the sysop's account id, or 'operator' (OPERATOR_SECRET)
  trusted_at INTEGER NOT NULL
);

-- "Trust this station's hearings" on an enrolled box: a ham lends their own receiver to this instance. The
-- sites count for as long as the box stays enrolled, and a box enrolled for a callsign is trusted only for
-- sites of that base call. Turning trust off or revoking the box deletes its rows.
CREATE TABLE box_trusted_sites (
  box_id     TEXT NOT NULL,                        -- the enrolled box (box_keys.box_id)
  site       TEXT NOT NULL,                        -- the receiving site call it attests, upper-case, with SSID
  trusted_by TEXT NOT NULL,
  trusted_at INTEGER NOT NULL,
  PRIMARY KEY (box_id, site)
);
