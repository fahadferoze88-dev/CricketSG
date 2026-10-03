CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL REFERENCES scorers(email),
  owner_device TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL CHECK(revision > 0),
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS match_handoffs (
  id INTEGER PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  from_email TEXT NOT NULL,
  to_email TEXT NOT NULL,
  generation INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_match_handoff AFTER UPDATE OF generation ON matches
WHEN NEW.generation != OLD.generation
BEGIN
  INSERT INTO match_handoffs(match_id, from_email, to_email, generation, revision, created_at)
  VALUES(NEW.id, OLD.owner_email, NEW.owner_email, NEW.generation, NEW.revision, NEW.updated_at);
END;
