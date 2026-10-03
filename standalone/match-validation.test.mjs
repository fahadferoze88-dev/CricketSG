import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { recoveryDB } from "./test-db.mjs";
import { matchAPI } from "./matches.mjs";
import { freshScore, applyDelivery, recalculateInnings } from "../testing/scoring.mjs";
import { validateRecovery } from "../testing/recovery.mjs";

const clone = (value) => structuredClone(value);
const action = (snapshot, kind, before = null, after = null) => snapshot.actionLog.push({
  id: randomUUID(), kind, reason: `QA ${kind}`, at: new Date().toISOString(), innings: snapshot.inningsNumber, before, after,
});
function fixture() {
  const { DB, sqlite } = recoveryDB();
  const ids = Array.from({ length: 16 }, () => randomUUID());
  const batters = ids.slice(0, 8), fielders = ids.slice(8);
  const state = freshScore(batters, fielders);
  state.battingPairs = [batters.slice(0, 2)]; state.awaitingPair = false; state.bowler = fielders[0];
  applyDelivery(state, { id: randomUUID(), batterRuns: 1 }, { batters, fielders });
  applyDelivery(state, { id: randomUUID(), batterRuns: 0, extras: 2, extraType: "Leg bye", strikeRuns: 2 }, { batters, fielders });
  const snapshot = { matchConfig: { schemaVersion: 2, matchNumber: 1, date: "2026-09-29", matchName: "Validation QA", battingFirst: "teamA",
    teamA: { name: "A", captain: batters[0], players: batters }, teamB: { name: "B", captain: fielders[0], players: fielders },
    playerNames: Object.fromEntries(ids.map((id, index) => [id, `Player ${index + 1}`])) },
    state, completedInnings: [], undoStack: [], inningsNumber: 1, matchStatus: "playing", actionLog: [] };
  action(snapshot, "create");
  const id = randomUUID(), device = randomUUID();
  const call = (method, suffix = "", body, canCorrect = true, database = DB) => matchAPI(new Request(`https://beta.example/api/matches/${id}${suffix}`, {
    method, headers: { "Content-Type": "application/json", "X-Scoring-Device": device },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), { DB: database }, "first@example.com", canCorrect);
  const put = (value, revision, canCorrect = true, database = DB) => call("PUT", "", { revision, generation: 0, snapshot: value }, canCorrect, database);
  const seed = () => {
    for (const [index, player] of ids.entries()) sqlite.prepare(`INSERT INTO players
      (id,name,normalized_name,creation_payload,created_at,updated_at,updated_by,reason) VALUES(?,?,?,?,?,?,?,?)`)
      .run(player, `Player ${index}`, `player ${index}`, "{}", "2026-09-29", "2026-09-29", "first@example.com", "QA seed");
  };
  return { DB, sqlite, id, ids, snapshot, batters, fielders, call, put, seed };
}

test("server recomputes figures, preserves selected actors, and atomically audits append-only offline corrections", async () => {
  const f = fixture();
  try {
    assert.equal((await f.put(f.snapshot, 3)).status, 200, "offline revisions can arrive together");
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM match_actions").get().n, 1);
    assert.equal((await f.put(f.snapshot, 3)).status, 200);
    const forged = clone(f.snapshot); forged.state.total = 999;
    assert.equal((await f.put(forged, 4)).status, 400, "never trust browser totals");
    const corrected = clone(f.snapshot), before = clone(corrected.state);
    corrected.state.history[0].batterRuns = 2;
    corrected.state = recalculateInnings(corrected.state, f.batters, f.fielders);
    assert.equal(corrected.state.strikerIndex, before.strikerIndex);
    assert.equal(corrected.state.history[1].striker, before.history[1].striker);
    assert.equal(corrected.state.bowlerRuns[f.fielders[0]], 2, "leg byes are excluded from bowler runs");
    assert.equal((await f.put(corrected, 4)).status, 400, "a changed checkpoint needs an audit action");
    action(corrected, "correction", before, clone(corrected.state));
    corrected.actionLog.at(-1).actor = "forged@example.com";
    const alteredAudit = clone(corrected); alteredAudit.actionLog[0].reason = "erase the old reason";
    assert.equal((await f.put(alteredAudit, 4)).status, 400);
    assert.equal((await f.put(corrected, 4)).status, 200);
    assert.equal((await f.put(corrected, 4)).status, 200);
    const audit = f.sqlite.prepare("SELECT * FROM match_actions WHERE action_id = ?").get(corrected.actionLog.at(-1).id);
    assert.equal(audit.actor_email, "first@example.com");
    assert.equal(JSON.parse(audit.action_json).before.total, 3);
    assert.equal(JSON.parse(audit.action_json).after.total, 4);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM match_actions").get().n, 2);
    assert.throws(() => f.sqlite.exec("DELETE FROM match_actions"), /immutable/);
    assert.throws(() => f.sqlite.exec("UPDATE match_actions SET actor_email='second@example.com'"), /immutable/);
    const getter = await (await f.call("GET")).json();
    assert.equal(getter.finalizedRevision, null);
    assert.equal(getter.snapshot.state.total, 4);
    const actorBefore = clone(corrected.state);
    const delivery = corrected.state.history[0];
    [delivery.striker, delivery.nonStriker] = [delivery.nonStriker, delivery.striker];
    delivery.bowler = f.fielders[1];
    corrected.state = recalculateInnings(corrected.state, f.batters, f.fielders);
    action(corrected, "correction", actorBefore, clone(corrected.state));
    assert.equal((await f.put(corrected, 5)).status, 200, "approved wrong-batter and wrong-bowler corrections preserve later recorded actors");
    assert.equal(corrected.state.history[1].striker, before.history[1].striker);
    assert.equal(corrected.state.bowlerRuns[f.fielders[1]], 2);
    // Trigger failure must roll back the checkpoint too.
    f.sqlite.exec("CREATE TRIGGER qa_fail BEFORE INSERT ON match_actions WHEN json_extract(NEW.action_json,'$.kind') = 'fail' BEGIN SELECT RAISE(ABORT,'qa failure'); END");
    action(corrected, "fail");
    await assert.rejects(f.put(corrected, 6), /qa failure/);
    assert.equal(f.sqlite.prepare("SELECT revision FROM matches WHERE id=?").get(f.id).revision, 5);
  } finally { f.sqlite.close(); }
});

test("finalization rejects pending/duplicate identities, preserves each finalized revision, and enforces correction permission", async () => {
  const f = fixture();
  try {
    f.snapshot.matchStatus = "shortened"; action(f.snapshot, "status", "playing", "shortened");
    assert.equal((await f.put(f.snapshot, 2)).status, 200, "unknown or unreviewed players must not block recovery saves");
    const finish = () => f.call("POST", "/finalize", { generation: 0, revision: 2 });
    assert.equal((await finish()).status, 400, "unknown player identities cannot finalize");
    f.seed();
    f.sqlite.prepare("UPDATE players SET review_required=1,revision=revision+1 WHERE id=?").run(f.ids[0]);
    assert.equal((await finish()).status, 400, "possible duplicates require review");
    f.sqlite.prepare("UPDATE players SET review_required=0,revision=revision+1 WHERE id=?").run(f.ids[0]);
    assert.equal((await f.call("POST", "/finalize", { generation: 0, revision: 2 }, false)).status, 403);
    const registryRace = { prepare(sql) {
      if (sql.startsWith("UPDATE matches SET finalized_revision")) {
        f.sqlite.prepare("UPDATE players SET review_required=1,revision=revision+1 WHERE id=?").run(f.ids[0]);
      }
      return f.DB.prepare(sql);
    } };
    assert.equal((await f.call("POST", "/finalize", { generation: 0, revision: 2 }, true, registryRace)).status, 409,
      "player identities cannot change between validation and finalization");
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM match_finalizations").get().n, 0);
    f.sqlite.prepare("UPDATE players SET review_required=0,revision=revision+1 WHERE id=?").run(f.ids[0]);
    assert.equal((await finish()).status, 200);
    assert.equal((await finish()).status, 200);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM match_finalizations").get().n, 1);
    assert.equal((await (await f.call("GET")).json()).finalizedRevision, 2);
    const updated = clone(f.snapshot); updated.matchStatus = "abandoned"; action(updated, "status", "shortened", "abandoned");
    assert.equal((await f.put(updated, 3, false)).status, 403);
    assert.equal((await f.put(updated, 3)).status, 200);
    assert.equal((await (await f.call("GET")).json()).finalizedRevision, 2, "old finalized revision is retained while its correction awaits finalization");
    assert.equal((await f.call("POST", "/finalize", { generation: 0, revision: 3 })).status, 200);
    const revisions = f.sqlite.prepare("SELECT revision,snapshot FROM match_finalizations ORDER BY revision").all();
    assert.deepEqual(revisions.map((row) => row.revision), [2, 3]);
    assert.equal(JSON.parse(revisions[0].snapshot).matchStatus, "shortened");
    assert.equal(JSON.parse(revisions[1].snapshot).state.total, 3, "abandoned matches keep recorded statistics");
    assert.throws(() => f.sqlite.exec("DELETE FROM match_finalizations"), /immutable/);
    f.sqlite.prepare("UPDATE players SET merged_into=?,active=0,revision=revision+1 WHERE id=?").run(f.ids[1], f.ids[0]);
    action(updated, "review");
    assert.equal((await f.put(updated, 4)).status, 200);
    assert.equal((await f.call("POST", "/finalize", { generation: 0, revision: 4 })).status, 400, "merged identity cannot occupy two roster slots");
  } finally { f.sqlite.close(); }
});

test("exact predecessor checks reject concurrent writes and concurrent finalization cannot bypass permissions", async () => {
  const f = fixture();
  try {
    assert.equal((await f.put(f.snapshot, 1)).status, 200);
    const changed = clone(f.snapshot); action(changed, "swap"); changed.state.strikerIndex = 1 - changed.state.strikerIndex;
    const racing = (sqlToRun) => ({ prepare(sql) {
      if (sql.startsWith("UPDATE matches SET revision")) f.sqlite.exec(sqlToRun);
      return f.DB.prepare(sql);
    } });
    assert.equal((await f.put(changed, 2, true, racing("UPDATE matches SET revision=revision+1"))).status, 409);
    assert.equal((await f.put(changed, 3, false, racing("UPDATE matches SET finalized_revision=revision,finalized_by='first@example.com',finalized_at='2026-09-29'"))).status, 409);
    assert.equal(f.sqlite.prepare("SELECT revision FROM matches").get().revision, 2);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM match_actions").get().n, 1);
  } finally { f.sqlite.close(); }
});

test("legacy recovery keeps its original format and cannot silently become an official result", async () => {
  const f = fixture();
  try {
    const legacy = clone(f.snapshot); delete legacy.matchConfig.schemaVersion;
    assert.equal((await f.put(legacy, 1)).status, 200);
    assert.equal((await f.call("POST", "/finalize", { generation: 0, revision: 1 })).status, 400);
    assert.equal((await f.put(f.snapshot, 2)).status, 400);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM match_actions").get().n, 0);
    assert.deepEqual((await (await f.call("GET")).json()).snapshot, legacy);
  } finally { f.sqlite.close(); }
});

test("server verifies authoritative innings while browser recovery also verifies every undo snapshot", async () => {
  const f = fixture();
  try {
    const undo = clone(f.snapshot.state); undo.total = 999;
    f.snapshot.undoStack.push(undo);
    assert.throws(() => validateRecovery(f.snapshot), /Invalid recovery/);
    assert.equal((await f.put(f.snapshot, 1)).status, 200, "undo figures are not official results and need not be replayed on every upload");
    const forged = clone(f.snapshot); forged.state.total = 999; action(forged, "correction");
    assert.equal((await f.put(forged, 2)).status, 400, "current figures must still be verified");
  } finally { f.sqlite.close(); }
});
