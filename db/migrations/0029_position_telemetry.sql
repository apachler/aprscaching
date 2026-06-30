-- Telemetry history (docs/26 Stage 0.1): the station table keeps only the *latest* speed/altitude/
-- course, so a track had no motion history to graph. Carry the per-fix telemetry onto positions too,
-- so the workbench can chart speed/altitude/course over time alongside the weather series. Back-data
-- stays NULL; new fixes fill it. Cheap, additive, all three runtimes (D1 / better-sqlite3 / bun).
ALTER TABLE positions ADD COLUMN speed_kn    REAL;
ALTER TABLE positions ADD COLUMN altitude_m  REAL;
ALTER TABLE positions ADD COLUMN course      INTEGER;
