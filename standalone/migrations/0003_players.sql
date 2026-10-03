CREATE TABLE players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  normalized_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  merged_into TEXT REFERENCES players(id),
  review_required INTEGER NOT NULL DEFAULT 0 CHECK(review_required IN (0,1)),
  creation_payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES scorers(email),
  reason TEXT NOT NULL,
  CHECK(merged_into IS NULL OR (merged_into != id AND active = 0))
);
CREATE INDEX players_name ON players(normalized_name);
CREATE TABLE player_aliases (
  player_id TEXT NOT NULL REFERENCES players(id),
  name TEXT NOT NULL,
  nickname TEXT NOT NULL,
  PRIMARY KEY(player_id, name, nickname)
);
CREATE TABLE player_audit (
  id INTEGER PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  revision INTEGER NOT NULL,
  actor_email TEXT NOT NULL REFERENCES scorers(email),
  reason TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(player_id, revision)
);
CREATE TRIGGER player_created AFTER INSERT ON players
BEGIN
  INSERT INTO player_aliases VALUES(NEW.id, NEW.name, NEW.nickname);
  INSERT INTO player_audit(player_id,revision,actor_email,reason,before_json,after_json,created_at)
  VALUES(NEW.id,NEW.revision,NEW.updated_by,NEW.reason,NULL,
    json_object('name',NEW.name,'nickname',NEW.nickname,'active',NEW.active,'mergedInto',NEW.merged_into,'reviewRequired',NEW.review_required),NEW.updated_at);
END;
CREATE TRIGGER player_updated AFTER UPDATE ON players
BEGIN
  INSERT OR IGNORE INTO player_aliases VALUES(NEW.id, NEW.name, NEW.nickname);
  INSERT INTO player_audit(player_id,revision,actor_email,reason,before_json,after_json,created_at)
  VALUES(NEW.id,NEW.revision,NEW.updated_by,NEW.reason,
    json_object('name',OLD.name,'nickname',OLD.nickname,'active',OLD.active,'mergedInto',OLD.merged_into,'reviewRequired',OLD.review_required),
    json_object('name',NEW.name,'nickname',NEW.nickname,'active',NEW.active,'mergedInto',NEW.merged_into,'reviewRequired',NEW.review_required),NEW.updated_at);
END;
