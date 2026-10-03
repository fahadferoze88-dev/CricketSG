ALTER TABLE matches ADD COLUMN finalized_revision INTEGER;
ALTER TABLE matches ADD COLUMN finalized_at TEXT;
ALTER TABLE matches ADD COLUMN finalized_by TEXT REFERENCES scorers(email);

CREATE TABLE match_actions (
  match_id TEXT NOT NULL REFERENCES matches(id),
  action_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  actor_email TEXT NOT NULL REFERENCES scorers(email),
  device TEXT NOT NULL,
  action_json TEXT NOT NULL CHECK(json_valid(action_json)),
  received_at TEXT NOT NULL,
  PRIMARY KEY(match_id, action_id)
);
CREATE TRIGGER match_actions_created AFTER INSERT ON matches
WHEN json_extract(NEW.snapshot, '$.matchConfig.schemaVersion') = 2
BEGIN
  INSERT INTO match_actions
  SELECT NEW.id, json_extract(value, '$.id'), NEW.revision, NEW.owner_email,
    NEW.owner_device, value, NEW.updated_at FROM json_each(NEW.snapshot, '$.actionLog');
END;
CREATE TRIGGER match_actions_appended AFTER UPDATE OF snapshot ON matches
WHEN NEW.revision != OLD.revision AND json_extract(NEW.snapshot, '$.matchConfig.schemaVersion') = 2
BEGIN
  INSERT INTO match_actions
  SELECT NEW.id, json_extract(value, '$.id'), NEW.revision, NEW.owner_email,
    NEW.owner_device, value, NEW.updated_at FROM json_each(NEW.snapshot, '$.actionLog') entry
  WHERE NOT EXISTS(SELECT 1 FROM match_actions saved
    WHERE saved.match_id = NEW.id AND saved.action_id = json_extract(entry.value, '$.id'));
END;
CREATE TRIGGER match_actions_no_update BEFORE UPDATE ON match_actions
BEGIN SELECT RAISE(ABORT, 'Match audit entries are immutable'); END;
CREATE TRIGGER match_actions_no_delete BEFORE DELETE ON match_actions
BEGIN SELECT RAISE(ABORT, 'Match audit entries are immutable'); END;

CREATE TABLE match_finalizations (
  match_id TEXT NOT NULL REFERENCES matches(id),
  revision INTEGER NOT NULL,
  actor_email TEXT NOT NULL REFERENCES scorers(email),
  device TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(match_id, revision)
);
CREATE TRIGGER match_finalized AFTER UPDATE OF finalized_revision ON matches
WHEN NEW.finalized_revision IS NOT NULL AND NEW.finalized_revision IS NOT OLD.finalized_revision
BEGIN
  INSERT INTO match_finalizations VALUES(NEW.id, NEW.finalized_revision, NEW.finalized_by,
    NEW.owner_device, NEW.snapshot, NEW.content_hash, NEW.finalized_at);
END;
CREATE TRIGGER match_finalizations_no_update BEFORE UPDATE ON match_finalizations
BEGIN SELECT RAISE(ABORT, 'Finalized revisions are immutable'); END;
CREATE TRIGGER match_finalizations_no_delete BEFORE DELETE ON match_finalizations
BEGIN SELECT RAISE(ABORT, 'Finalized revisions are immutable'); END;
