CREATE TABLE scorers (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  display_name TEXT NOT NULL,
  can_correct INTEGER NOT NULL DEFAULT 0 CHECK (can_correct IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);
