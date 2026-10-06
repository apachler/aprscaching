-- The FED_RESERVE policy the transit feed last re-queued for (fedtransit.ts applyReservePolicy). When the
-- effective policy widens (off → trusted → all), the records of the origins it newly lets out move to the end
-- of the feed once, so followers whose cursor already passed them receive them; this row is what makes that
-- happen once and not on every boot. One row; the schema default is where every instance starts.
CREATE TABLE fed_transit_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  reserve_applied TEXT NOT NULL
);
INSERT INTO fed_transit_state (id, reserve_applied) VALUES (1, 'trusted');
