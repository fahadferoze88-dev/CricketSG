CREATE TABLE backup_status (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  attempted_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','verified','failed','deferred')),
  latest_receipt TEXT NOT NULL CHECK(json_valid(latest_receipt)),
  last_verified TEXT CHECK(last_verified IS NULL OR json_valid(last_verified))
);
