import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { recoveryDB } from "./test-db.mjs";
import { matchAPI } from "./matches.mjs";
import { freshScore, applyDelivery, recalculateInnings, consecutiveDots } from "../testing/scoring.mjs";
import { validateRecovery } from "../testing/recovery.mjs";
import { IDBFactory } from "fake-indexeddb";

const source = readFileSync(new URL("../testing/app.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
const storageSource = readFileSync(new URL("../testing/storage.js", import.meta.url), "utf8");
const key = "cricketops-testing-match-v1";

async function scorer(indexedDB = new IDBFactory(), legacy = new Map(), cloudFetch) {
  const elements = new Map();
  let correction;
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      hidden: true, value: "", textContent: "", innerHTML: "", children: [],
      classList: { add() {}, remove() {}, toggle() {} },
      handlers: {}, setAttribute() {}, append(child) { this.children.push(child); },
      replaceChildren() { this.children = []; },
      addEventListener(name, listener) { this.handlers[name] = listener; }, querySelectorAll: () => [],
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    freshScore, applyDelivery, consecutiveDots, validateRecovery,
    initializePlayers: async () => {}, renderTeamPickers: () => {}, selectedTeams: () => ({}),
    playerNames: ids => Object.fromEntries(ids.map(id => [id,id])), openPlayers: () => {}, syncPlayers: async () => true,
    openCorrection: (options, id) => { correction = { ...options, id }; },
    fetch: cloudFetch, indexedDB, crypto: webcrypto, navigator: {}, structuredClone,
    localStorage: { getItem: (k) => legacy.get(k) ?? null },
    document: { getElementById: element, createElement: () => element(Symbol()), querySelectorAll: () => [], addEventListener() {} },
    setTimeout() {}, clearTimeout() {}, setInterval() {}, Intl,
    window: { confirm: () => true, addEventListener() {} },
  });
  const run = (code) => vm.runInContext(code, context);
  run(storageSource);
  run(source);
  await run("boot");
  const action = async (code) => { const result = await run(code); await run("saving"); return result; };
  const record = () => run("store.get(matchId)");
  return { run, action, element, indexedDB, legacy, record, correction: () => correction };
}

async function readyMatch() {
  const app = await scorer();
  await app.action(`matchConfig = {
    date: '2026-09-25', matchName: 'Recovery test', battingFirst: 'teamA',
    teamA: { name: 'A', players: [...batters] }, teamB: { name: 'B', players: [...fielders] }
  }; state = freshInnings(); state.battingPairs = [[batters[0], batters[1]]];
  state.awaitingPair = false; chooseBowler(fielders[0]);`);
  return app;
}

async function readyModernMatch(cloudFetch) {
  const app = await scorer(new IDBFactory(), new Map(), cloudFetch);
  await app.action(`{
    const ids = Array.from({length:16}, () => crypto.randomUUID());
    matchConfig = {schemaVersion:2,matchNumber:1,date:'2026-09-29',matchName:'Modern recovery QA',battingFirst:'teamA',
      playerNames:Object.fromEntries(ids.map((id,index) => [id, 'Player '+(index+1)])),
      teamA:{name:'A',players:ids.slice(0,8),captain:ids[0]},teamB:{name:'B',players:ids.slice(8),captain:ids[8]}};
    activateTeams(); state=freshInnings(); audit('create',null,matchConfig); render();
  }`);
  app.run("pairSelection=batters.slice(0,2)");
  app.element("savePair").handlers.click(); await app.run("saving");
  await app.action("chooseBowler(fielders[0])");
  return app;
}

async function scoreInnings(app, cloudFetch) {
  for (let ball = 0; ball < 96; ball++) {
    if (app.run("state.awaitingPair")) {
      app.run("pairSelection=batters.slice(state.pairIndex*2,state.pairIndex*2+2)");
      app.element("savePair").handlers.click(); await app.run("saving");
    }
    if (app.run("!state.bowler")) await app.action("chooseBowler(fielders[Math.floor(state.legalBalls/12)])");
    await app.action(ball % 2 ? "codedScore('7S')" : "codedScore('5F')");
    if (ball === 47) app = await scorer(app.indexedDB, new Map(), cloudFetch);
  }
  return app;
}

async function saveCorrection(app, number, modify, reflow = false) {
  app.run(`correctDelivery(${number}, ${number}===inningsNumber?state.history[0].id:completedInnings[${number}-1].history[0].id)`);
  const context = app.correction();
  assert.ok(context, "correction dialog received the recorded innings");
  const before = structuredClone(context.innings), changed = structuredClone(before);
  modify(changed);
  const next = recalculateInnings(changed, context.batters, context.fielders, { reflow });
  context.onSave(next, { kind: "correction", reason: "QA reviewed correction", before, after: structuredClone(next) });
  await app.run("saving");
  return { before, next };
}

async function settleCloud(app) {
  // A save arriving during a request queues one more request in its finally handler.
  while (app.run("syncing")) await app.run("syncing");
}

test("committed scores reload with strike, undo, teams, and both innings intact", async () => {
  const app = await readyMatch();
  await app.action("codedScore('5F')");
  await app.action("codedScore('7S')");
  const saved = (await app.record()).snapshot;
  assert.equal(saved.state.total, 12);
  assert.equal(saved.state.legalBalls, 2);
  assert.deepEqual(saved.state.history.map((event) => event.chip), ["5F", "7S"]);
  assert.equal(saved.state.strikerIndex, 0);
  assert.equal(saved.state.playerRuns.Muqeem, 12);
  assert.equal(saved.state.playerRuns.Shoaib, 0);
  const restored = await scorer(app.indexedDB);
  assert.equal(restored.run("state.total"), 12);
  assert.equal(restored.run("revision"), 3);
  await restored.action("undo()");
  assert.equal((await restored.record()).snapshot.state.total, 5);
  await restored.action("state.legalBalls = 96; startSecondInnings()");
  const second = await scorer(app.indexedDB);
  assert.equal(second.run("inningsNumber"), 2);
  assert.equal(second.run("completedInnings[0].total"), 5);
  assert.equal(second.run("state.awaitingPair"), true);
  assert.equal(second.run("battingKey()"), "teamB");
});

test("pending/failed saves block every mutation; retry keeps exactly the pending delivery", async () => {
  const app = await readyMatch();
  await app.action("codedScore('7S')");
  const durable = await app.record();
  app.run("const realSave = store.save; store.save = () => Promise.reject(new Error('Quota exceeded')); quickScore('1'); quickScore('2');");
  assert.equal(app.run("state.total"), 8, "second tap blocked while save pending");
  await app.run("saving");
  assert.deepEqual(await app.record(), durable);
  assert.equal(app.element("syncText").textContent, "Not saved");
  assert.equal(app.element("saveWarning").hidden, false);
  const pending = app.run("JSON.stringify(recoverySnapshot())");
  await app.action("quickScore('2'); codedScore('5F'); swapStrike(); undo(); chooseBowler(fielders[1]); startSecondInnings(); resetMatch(); pairSelection = [batters[2], batters[3]];");
  app.element("savePair").handlers.click();
  assert.equal(app.run("JSON.stringify(recoverySnapshot())"), pending);
  assert.equal(await app.action("persist()"), false);
  app.run("store.save = realSave");
  assert.equal(await app.action("persist()"), true);
  assert.equal((await app.record()).snapshot.state.total, 8);
  assert.equal(app.element("saveWarning").hidden, true);
  await app.action("quickScore('2')");
  assert.equal((await app.record()).snapshot.state.total, 10);
  assert.equal((await app.record()).snapshot.state.legalBalls, 3);
});

test("bowler-credited dismissals deduct five runs; runouts do not", async () => {
  for (const dismissal of ["Catch", "Bowled", "Stumped", "Out-Other", "Run Out"]) {
    const app = await readyMatch();
    await app.action(`commitEvent({ dismissal: ${JSON.stringify(dismissal)}, batterRuns: 2, extras: 2,
      extraType: 'Wide', penalizedIndex: 0, chip: 'W+2+Wd2', kind: 'wicket', summary: 'Wicket with runs' })`);
    assert.equal(app.run("state.total"), -1);
    assert.equal(app.run("state.playerRuns.Muqeem"), -3);
    assert.equal(app.run("state.bowlerRuns[fielders[0]]"), dismissal === "Run Out" ? 4 : -1);
    assert.equal(app.run("state.bowlerWickets[fielders[0]]"), dismissal === "Run Out" ? 0 : 1);
    await app.action("undo()");
    assert.equal(app.run("state.bowlerRuns[fielders[0]]"), 0);
  }
});

test("final-over extras rebowl, completion blocks scoring, and innings transition occurs once", async () => {
  const app = await readyMatch();
  await app.action("startSecondInnings()");
  assert.equal(app.run("inningsNumber"), 1);
  app.run("state.legalBalls = 95; state.pairIndex = 3; state.battingPairs = defaultPairs.map(pair => [...pair]);");
  for (const extraType of ["Wide", "No ball"]) {
    await app.action(`commitEvent({ extras: 2, extraType: ${JSON.stringify(extraType)}, chip: 'Extra', kind: 'extra', summary: 'Extra' })`);
    assert.equal(app.run("state.legalBalls"), 95);
  }
  await app.action("commitEvent({ extras: 1, extraType: 'Leg bye', strikeRuns: 1, chip: 'Lb1', kind: 'extra', summary: 'Leg bye' })");
  assert.equal(app.run("state.legalBalls"), 96);
  const finished = app.run("JSON.stringify(state)");
  await app.action("chooseBowler(fielders[1]); quickScore('1'); codedScore('5F');");
  assert.equal(app.run("JSON.stringify(state)"), finished);
  await app.action("startSecondInnings()");
  assert.equal(app.run("inningsNumber"), 2);
  assert.equal(app.run("completedInnings[0].total"), 5);
  app.run("state.legalBalls = 96;");
  const second = app.run("JSON.stringify({ state, completedInnings })");
  await app.action("startSecondInnings()");
  assert.equal(app.run("JSON.stringify({ state, completedInnings })"), second);
});

test("old localStorage saves migrate once, unchanged; corrupt data is not overwritten", async () => {
  const original = await readyMatch();
  await original.action("quickScore('3')");
  const raw = JSON.stringify((await original.record()).snapshot);
  const legacy = new Map([[key, raw]]);
  const app = await scorer(new IDBFactory(), legacy);
  assert.equal(app.run("state.total"), 3);
  assert.equal(legacy.get(key), raw);
  await app.action("quickScore('2')");
  const reopened = await scorer(app.indexedDB, legacy);
  assert.equal(reopened.run("state.total"), 5, "old save must not replace newer checkpoint");
  for (const corrupt of ["{broken", JSON.stringify({ matchConfig: { battingFirst: "teamA" }, state: {} })]) {
    const legacy = new Map([[key, corrupt]]);
    const broken = await scorer(new IDBFactory(), legacy);
    assert.equal(legacy.get(key), corrupt);
    assert.equal(broken.element("saveWarning").hidden, false);
    assert.equal(broken.element("setupView").hidden, true);
    assert.equal((await broken.run("store.list()")).length, 0);
  }
});

test("starting another match retains the old one and allows resuming it", async () => {
  const app = await readyMatch();
  await app.action("quickScore('4')");
  const id = app.run("matchId");
  await app.action("resetMatch()");
  assert.equal(app.run("state"), null);
  assert.equal((await app.run("store.list()")).length, 1);
  const reopened = await scorer(app.indexedDB);
  assert.equal(reopened.run("state"), null);
  await reopened.action(`resumeMatch(${JSON.stringify(id)})`);
  assert.equal(reopened.run("state.total"), 4);
  assert.equal(reopened.run("undoStack.length"), 1);
  reopened.run("store.select = () => Promise.reject(new Error('Storage unavailable'))");
  await reopened.action("resetMatch()");
  assert.equal(reopened.run("state.total"), 4);
});

test("two tabs cannot silently overwrite the same match", async () => {
  const first = await readyMatch();
  const second = await scorer(first.indexedDB);
  await first.action("quickScore('4')");
  await second.action("quickScore('2')");
  assert.equal(second.run("saveFailed"), true);
  assert.match(second.element("saveWarning").textContent, /another tab/);
  assert.equal((await second.record()).snapshot.state.total, 4);
  assert.equal(second.run("state.total"), 2, "pending copy retained for export");
  assert.equal(await second.action("persist()"), false, "retry must not overwrite newer revision");
});

test("recovery import creates a separate copy and rejects invalid files without changing the current match", async () => {
  const app = await readyMatch();
  await app.action("codedScore('7S')");
  const original = await app.record();
  const imported = { version: 2, recovery: original.snapshot };
  await app.element("importRecovery").handlers.change({ target: { files: [{ size: 100, text: async () => JSON.stringify(imported) }] } });
  assert.notEqual(app.run("matchId"), original.id);
  assert.equal(app.run("state.total"), 7);
  assert.equal((await app.run("store.list()")).length, 2);
  const active = app.run("matchId");
  imported.recovery.inningsNumber = 7;
  await app.element("importRecovery").handlers.change({ target: { files: [{ size: 100, text: async () => JSON.stringify(imported) }] } });
  assert.equal(app.run("matchId"), active);
  assert.equal((await app.run("store.list()")).length, 2);
  assert.equal(app.run(`escapeHTML('<img src=x onerror="evil()">')`), '&lt;img src=x onerror=&quot;evil()&quot;&gt;');
});

test("offline queue catches up after restart, retries lost responses, and preserves pending data after handover", async () => {
  const { DB, sqlite } = recoveryDB();
  const first = await readyMatch();
  await first.action("quickScore('3')");
  const id = first.run("matchId");
  let offline = true, loseResponse = false;
  const cloudFetch = async (url, options = {}) => {
    if (offline) throw new TypeError("No network");
    const response = await matchAPI(new Request(`https://beta.example${url}`, options), { DB }, "first@example.com");
    if (loseResponse && options.method === "PUT") { loseResponse = false; throw new TypeError("Acknowledgement lost"); }
    return response;
  };
  const app = await scorer(first.indexedDB, new Map(), cloudFetch);
  await app.run("syncing");
  assert.equal(app.run("state.total"), 3);
  assert.equal((await app.record()).syncedRevision, 0);
  offline = false;
  loseResponse = true;
  await app.run("syncCloud()");
  assert.equal((await app.record()).syncedRevision, 0, "no local acknowledgement until response arrives");
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM matches").get().n, 1);
  await app.run("syncCloud()");
  assert.equal((await app.record()).syncedRevision, app.run("revision"));
  assert.equal(app.element("cloudStatus").textContent, "Cloud saved");
  const secondDevice = webcrypto.randomUUID();
  const transferred = await matchAPI(new Request(`https://beta.example/api/matches/${id}/takeover`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Scoring-Device": secondDevice },
    body: JSON.stringify({ generation: 0, revision: app.run("revision") }),
  }), { DB }, "second@example.com");
  assert.equal(transferred.status, 200);
  await app.action("quickScore('2')");
  await app.run("syncing");
  assert.equal((await app.record()).snapshot.state.total, 5, "conflicting delivery remains durably on its device");
  assert.equal((await app.record()).conflicted, true);
  await app.action("quickScore('4')");
  assert.equal(app.run("state.total"), 5, "known handover stops old phone's scoring");
  const reopened = await scorer(first.indexedDB);
  await reopened.action("quickScore('4')");
  assert.equal(reopened.run("state.total"), 5, "conflict lock survives offline reopen");
  sqlite.close();
});

test("a complete 192-ball match survives a mid-innings restart and stays within the cloud checkpoint limit", async () => {
  let app = await readyMatch();
  for (let innings = 1; innings <= 2; innings++) {
    for (let ball = 0; ball < 96; ball++) {
      if (app.run("state.awaitingPair")) {
        app.run("pairSelection = batters.slice(state.pairIndex * 2, state.pairIndex * 2 + 2)");
        app.element("savePair").handlers.click();
        await app.run("saving");
      }
      if (app.run("!state.bowler")) await app.action("chooseBowler(fielders[Math.floor(state.legalBalls / 12)])");
      await app.action(ball % 2 ? "codedScore('7S')" : "codedScore('5F')");
      if (ball === 47) app = await scorer(app.indexedDB);
    }
    assert.equal(app.run("state.total"), 576);
    assert.equal(app.run("state.legalBalls"), 96);
    assert.equal(app.run("Object.values(state.bowlerOvers).every(n => n === 2)"), true);
    if (innings === 1) await app.action("startSecondInnings()");
  }
  app = await scorer(app.indexedDB);
  assert.equal(app.run("inningsNumber"), 2);
  assert.equal(app.run("completedInnings[0].total"), 576);
  const record = await app.record();
  assert.ok(Buffer.byteLength(JSON.stringify(record)) < 1_500_000);
  assert.equal(app.run("undoStack.length"), 30);
});

test("new-format 192-ball match, earlier corrections and restart retain actors, audit, second innings and cloud acknowledgement within the body cap", async (t) => {
  const { DB, sqlite } = recoveryDB();
  let offline = true, largestUpload = 0;
  const cloudFetch = async (url, options = {}) => {
    if (options.body) largestUpload = Math.max(largestUpload, Buffer.byteLength(options.body));
    if (offline) throw new TypeError("No network");
    return matchAPI(new Request(`https://beta.example${url}`, options), { DB }, "first@example.com");
  };
  let app;
  try {
    app = await readyModernMatch(cloudFetch);
    app = await scoreInnings(app, cloudFetch);
    assert.equal(app.run("state.total"), 576);
    await app.action("startSecondInnings()");
    app = await scoreInnings(app, cloudFetch);
    await app.action("completeMatch('completed')");
    await settleCloud(app);
    const complete = await app.record();
    const payloadBytes = Buffer.byteLength(JSON.stringify({ generation: complete.generation, revision: complete.revision, snapshot: complete.snapshot }));
    assert.ok(payloadBytes < 1_500_000, `new-format body is ${payloadBytes} bytes; cloud limit is 1,500,000`);
    assert.equal(complete.snapshot.completedInnings[0].legalBalls, 96);
    assert.equal(complete.snapshot.state.legalBalls, 96);
    assert.equal(complete.snapshot.state.total, 576);
    assert.equal(Object.values(complete.snapshot.state.bowlerBalls).every((n) => n === 12), true);
    offline = false;
    await app.run("syncCloud()");
    assert.equal((await app.record()).syncedRevision, complete.revision, `Cloud status: ${app.element("cloudStatus").textContent}`);
    assert.ok(largestUpload < 1_500_000, `largest attempted checkpoint body is ${largestUpload} bytes`);
    t.diagnostic(`Largest 192-ball checkpoint with undo: ${largestUpload} bytes; completed checkpoint: ${payloadBytes} bytes (limit 1,500,000).`);
    const secondBefore = app.run("JSON.stringify(state)");
    await saveCorrection(app, 1, (innings) => { innings.history[0].batterRuns = 2; });
    assert.equal(app.run("JSON.stringify(state)"), secondBefore, "first-innings edit must not change innings two");
    assert.equal(app.run("completedInnings[0].total"), 573);
    assert.equal(app.run("completedInnings[0].history[1].striker"), complete.snapshot.completedInnings[0].history[1].striker);
    assert.equal(app.run("completedInnings[0].strikerIndex"), complete.snapshot.completedInnings[0].strikerIndex);
    assert.equal(app.run("undoStack.length"), 0, "undo cannot restore a stale pre-correction innings");
    await settleCloud(app);
    assert.equal((await app.record()).syncedRevision, app.run("revision"));
    app = await scorer(app.indexedDB, new Map(), cloudFetch);
    assert.equal(app.run("matchStatus"), "completed");
    assert.equal(app.run("completedInnings[0].total"), 573);
    assert.equal(app.run("JSON.stringify(state)"), secondBefore);
    await saveCorrection(app, 1, (innings) => { innings.history.pop(); }, true);
    assert.equal(app.run("matchStatus"), "shortened", "shortening first innings preserves all later match records");
    assert.equal(app.run("completedInnings[0].legalBalls"), 95);
    assert.equal(app.run("JSON.stringify(state)"), secondBefore);
    await settleCloud(app);
    assert.equal((await app.record()).syncedRevision, app.run("revision"), app.element("cloudStatus").textContent);
    const cloud = JSON.parse(sqlite.prepare("SELECT snapshot FROM matches").get().snapshot);
    assert.equal(cloud.matchStatus, "shortened");
    assert.equal(cloud.state.legalBalls, 96);
    assert.equal(cloud.completedInnings[0].legalBalls, 95);
    assert.equal(sqlite.prepare("SELECT count(*) n FROM match_actions").get().n, cloud.actionLog.length);
  } finally { if (app) await app.run("syncing"); sqlite.close(); }
});

test("reviewed removal from the completed live innings reopens it and the change survives restart", async () => {
  let app = await readyModernMatch();
  app = await scoreInnings(app);
  await app.action("startSecondInnings()");
  app = await scoreInnings(app);
  await app.action("completeMatch('completed')");
  const firstBefore = app.run("JSON.stringify(completedInnings[0])");
  await saveCorrection(app, 2, (innings) => { innings.history.pop(); }, true);
  assert.equal(app.run("matchStatus"), "playing");
  assert.equal(app.run("state.legalBalls"), 95);
  assert.equal(app.run("JSON.stringify(completedInnings[0])"), firstBefore);
  app = await scorer(app.indexedDB);
  assert.equal(app.run("matchStatus"), "playing");
  assert.equal(app.run("state.legalBalls"), 95);
  assert.equal(app.run("undoStack.length"), 0);
});

test("cloud finalization locks scoring and match switching until its fixed target is acknowledged", async () => {
  const { DB, sqlite } = recoveryDB();
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const paused = new Promise((resolve) => { release = resolve; });
  const cloudFetch = async (url, options = {}) => {
    if (url.endsWith("/finalize")) { entered(); await paused; }
    return matchAPI(new Request(`https://beta.example${url}`, options), { DB }, "first@example.com");
  };
  let app;
  try {
    app = await readyModernMatch(cloudFetch);
    const players = app.run("[...batters,...fielders]");
    for (const [index, id] of players.entries()) sqlite.prepare(`INSERT INTO players
      (id,name,normalized_name,creation_payload,created_at,updated_at,updated_by,reason) VALUES(?,?,?,?,?,?,?,?)`)
      .run(id, `Player ${index}`, `player ${index}`, "{}", "2026-09-29", "2026-09-29", "first@example.com", "QA seed");
    await app.action("quickScore('3')");
    await app.action("completeMatch('shortened')");
    await app.run("syncing");
    const target = app.run("({id:matchId,revision,generation})");
    const finalizing = app.run("finalizeMatch()");
    await started;
    assert.equal(app.run("ready"), false);
    await app.action("resetMatch(); swapStrike(); completeMatch('playing')");
    assert.equal(app.run("matchId"), target.id);
    assert.equal(app.run("revision"), target.revision);
    release(); await finalizing;
    assert.equal(app.run("ready"), true);
    assert.equal((await app.record()).finalizedRevision, target.revision);
    assert.equal(sqlite.prepare("SELECT revision FROM match_finalizations").get().revision, target.revision);
    app = await scorer(app.indexedDB);
    assert.equal(app.run("finalizedRevision"), target.revision);
    assert.match(app.element("matchStatusText").textContent, /cloud finalized/);
  } finally { release(); if (app) await app.run("syncing"); sqlite.close(); }
});

test("cloud recovery preserves conflicting local work as a separate copy and fences stale tabs by generation", async () => {
  const app = await readyMatch();
  await app.action("quickScore('4')");
  const pending = await app.record();
  const cloud = { ...pending, generation: 1, syncedRevision: pending.revision, snapshot: structuredClone(pending.snapshot) };
  cloud.snapshot.state.total = 2;
  app.run(`globalThis.cloudFixture = ${JSON.stringify(cloud)}`);
  await assert.rejects(app.run("store.restoreCloud(cloudFixture, revision)"));
  await app.run("store.restoreCloud(cloudFixture, revision, true)");
  const records = await app.run("store.list()");
  assert.equal(records.length, 2);
  assert.equal(records.find((record) => record.localOnly).snapshot.state.total, 4);
  assert.equal(records.find((record) => record.id === pending.id).snapshot.state.total, 2);
  await app.action("quickScore('1')");
  assert.equal(app.run("saveFailed"), true, "same revision in old tab cannot overwrite a new ownership generation");
  assert.equal((await app.record()).snapshot.state.total, 2);
});

test("manual batter taps and pair dot reminder survive restart; Out-Other is entered once by the scorer", async () => {
  let app = await readyModernMatch();
  await app.action("quickScore('3')");
  assert.equal(app.run("state.strikerIndex"), 0, "net-inclusive odd runs cannot infer who faces next");
  app.element("nonStrikerCard").handlers.click(); await app.run("saving");
  assert.equal(app.run("state.strikerIndex"), 1);
  await app.action("quickScore('0')");
  app.element("nonStrikerCard").handlers.click(); await app.run("saving");
  await app.action("quickScore('0')");
  assert.match(app.element("dotStatus").textContent, /2 consecutive dots/);
  app = await scorer(app.indexedDB);
  assert.equal(app.run("state.strikerIndex"), 0);
  assert.match(app.element("dotStatus").textContent, /Out-Other/);
  app.run("selections.dismissal='Out-Other'; openSheet('wicketSheet')");
  assert.equal(app.element("fielderSection").hidden, true);
  assert.match(app.element("nextStrikerNote").textContent, /never changes automatically/);
  app.element("saveWicket").handlers.click(); await app.run("saving");
  assert.equal(app.run("state.legalBalls"), 4);
  assert.equal(app.run("state.total"), -2);
  assert.equal(app.run("state.history.at(-1).dismissal"), 'Out-Other');
  assert.equal(app.run("state.strikerIndex"), 0);
  assert.match(app.element("dotStatus").textContent, /^0 consecutive dots/);
  await app.action("undo()");
  assert.equal(app.run("state.legalBalls"), 3);
  assert.match(app.element("dotStatus").textContent, /^2 consecutive dots/);
  app = await scorer(app.indexedDB);
  assert.match(app.element("dotStatus").textContent, /^2 consecutive dots/);
  await app.action("quickScore('0')");
  assert.equal(app.run("state.total"), 3, "a missed wicket is flagged, never fabricated");
  assert.match(app.element("dotStatus").textContent, /correct the third dot/);
});


test("owner backup status is read-only, warns about stale/newer cloud data, and does not block scoring", async () => {
  const calls = [];
  const app = await scorer(new IDBFactory(), new Map(), async path => {
    calls.push(path);
    if (path === '/api/session') return Response.json({ canViewBackups: true });
    if (path === '/api/backup-status') return Response.json({ lastVerified: { at: '2026-09-01T00:00:00.000Z' },
      latest: { status: 'failed', stage: 'export' }, stale: true, newerCloudChanges: true });
    return Response.json({ matches: [] });
  });
  await app.run('loadBackupStatus()');
  assert.equal(app.element('backupHealth').hidden, false);
  assert.match(app.element('backupHealthText').textContent, /over 48 hours/);
  assert.match(app.element('backupHealthText').textContent, /Newer cloud/);
  assert.match(app.element('backupHealthText').textContent, /Device-only changes/);
  assert.equal(app.run('ready'), true);
  app.run('fetch = async () => { throw Error("offline") }');
  await app.run('loadBackupStatus()');
  assert.match(app.element('backupHealthText').textContent, /does not affect scoring/);
  assert.equal(app.run('ready'), true);
  assert.ok(calls.includes('/api/backup-status'));
});
