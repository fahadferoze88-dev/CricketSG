import { recoveryDB } from "./test-db.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { matchAPI } from "./matches.mjs";

const players = Array.from({ length: 16 }, (_, i) => `Player ${i + 1}`);
const numeric = (names) => Object.fromEntries(names.map((name) => [name, 0]));
const snapshot = () => ({
  matchConfig: { date: "2026-09-26", matchName: "Cloud QA", battingFirst: "teamA",
    teamA: { name: "A", players: players.slice(0, 8) }, teamB: { name: "B", players: players.slice(8) } },
  inningsNumber: 1, completedInnings: [], undoStack: [],
  state: { battingPairs: [], total: 0, legalBalls: 0, pairIndex: 0, strikerIndex: 0,
    pairScores: [0,0,0,0], pairWickets: [0,0,0,0], playerRuns: numeric(players.slice(0,8)), playerBalls: numeric(players.slice(0,8)),
    bowler: null, bowlerOvers: numeric(players.slice(8)), bowlerRuns: numeric(players.slice(8)),
    bowlerWickets: numeric(players.slice(8)), bowlerExtras: numeric(players.slice(8)),
    fielding: Object.fromEntries(players.slice(8).map((name) => [name, { catches: 0, runouts: 0, stumpings: 0, drops: 0 }])),
    currentOver: [], history: [], overRuns: 0, awaitingPair: true },
});

test("cloud checkpoints retry safely, fence old owners, and audit explicit handovers atomically", async () => {
  const { DB, sqlite } = recoveryDB();
  const firstDevice = randomUUID(), secondDevice = randomUUID(), id = randomUUID();
  const call = (method, path, body, second = false, headers = {}) => matchAPI(new Request(`https://beta.example/api/matches${path}`, {
    method, headers: { "Content-Type": "application/json", "X-Scoring-Device": second ? secondDevice : firstDevice, ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), { DB }, second ? "second@example.com" : "first@example.com");
  const body = { generation: 0, revision: 5, snapshot: snapshot() };
  assert.equal((await call("PUT", `/${id}`, body)).status, 200, "first connection can follow several offline revisions");
  assert.equal((await call("PUT", `/${id}`, body)).status, 200, "lost acknowledgement retry is idempotent");
  assert.equal((await call("PUT", `/${id}`, { ...body, snapshot: { ...body.snapshot, inningsNumber: 7 } })).status, 400);
  assert.equal((await call("PUT", `/${id}`, { ...body, snapshot: { ...body.snapshot, state: { ...body.snapshot.state, total: 99 } } })).status, 409);
  assert.equal((await call("PUT", `/${id}`, { ...body, revision: 4 })).status, 200);
  assert.equal((await call("PUT", `/${id}`, { ...body, revision: 6 }, true)).status, 409);
  assert.equal((await call("PUT", `/${id}`, body, false, { Origin: "https://evil.example" })).status, 403);
  let list = await (await call("GET", "")).json();
  assert.equal(list.matches.length, 1);
  assert.equal(list.matches[0].name, "Cloud QA");
  assert.equal(list.matches[0].owned_here, 1);
  assert.equal((await call("POST", `/${id}/takeover`, { generation: 0, revision: 4 }, true)).status, 409);
  const transferred = await (await call("POST", `/${id}/takeover`, { generation: 0, revision: 5 }, true)).json();
  assert.equal(transferred.generation, 1);
  assert.equal(transferred.revision, 5);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM match_handoffs").get().n, 1);
  assert.equal((await call("PUT", `/${id}`, { ...body, revision: 100 })).status, 409, "old offline phone cannot overwrite new owner's match");
  assert.equal((await call("PUT", `/${id}`, { ...body, generation: 1, revision: 6 }, true)).status, 200);
  const recovered = await (await call("GET", `/${id}`, undefined, true)).json();
  assert.equal(recovered.revision, 6);
  assert.equal(recovered.ownedHere, true);
  assert.deepEqual(recovered.snapshot, body.snapshot);
  assert.equal((await call("PUT", `/${randomUUID()}`, { ...body, generation: 8 })).status, 409, "a missing established match cannot be recreated silently");
  const tooLarge = { ...body, padding: "x".repeat(1_500_000) };
  assert.equal((await call("PUT", `/${id}`, tooLarge)).status, 400);
  sqlite.close();
});
