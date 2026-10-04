-- Where each coordinate of a cache stood when the cache took its first find. From then on an owner moves that
-- coordinate at most CACHE_MOVE_LIMIT_M from its pin, so past finds keep pointing to the place the finders
-- visited. `stage_no` -1 is the cache's own coordinates; 0 and up are cache_stages.stage_no, carried along when
-- the owner renumbers the stages. A living cache's own coordinates follow its station and are never pinned.
CREATE TABLE cache_place_pins (
  cache_id  INTEGER NOT NULL,
  stage_no  INTEGER NOT NULL,
  lat       REAL NOT NULL,
  lon       REAL NOT NULL,
  pinned_at INTEGER NOT NULL,
  PRIMARY KEY (cache_id, stage_no)
);
