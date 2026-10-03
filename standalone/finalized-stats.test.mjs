import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { freshScore, applyDelivery } from "../testing/scoring.mjs";
import { finalizationToTables } from "./finalized-stats.mjs";
import { statisticsPreview } from "./statistics-preview.mjs";

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const teamA = Array.from({ length: 8 }, (_, i) => id(i + 1));
const teamB = Array.from({ length: 8 }, (_, i) => id(i + 9));
const names = Object.fromEntries([...teamA, ...teamB].map((player, i) => [player, `Player ${i + 1}`]));
function prepared(batters, fielders) {
  const state = freshScore(batters, fielders);
  return Object.assign(state, { battingPairs: [batters.slice(0, 2)], awaitingPair: false, bowler: fielders[0] });
}
function deliver(state, event, batters, fielders) {
  if (state.awaitingPair) {
    state.battingPairs[state.pairIndex] = batters.slice(state.pairIndex * 2, state.pairIndex * 2 + 2);
    state.awaitingPair = false;
  }
  state.bowler ||= fielders[Math.floor(state.legalBalls / 12)];
  applyDelivery(state, { id: id(100 + state.history.length), batterRuns: 0, ...event }, { batters, fielders });
}
function record(state, { battingFirst = "teamB", completedInnings = [], status = "shortened", revision = 7 } = {}) {
  const snapshot = {
    matchConfig: { schemaVersion: 2, matchNumber: 2, date: "2026-09-25", matchName: "Friday match 2", battingFirst,
      playerNames: names, teamA: { name: "A", players: teamA, captain: teamA[0] }, teamB: { name: "B", players: teamB, captain: teamB[0] } },
    state, inningsNumber: completedInnings.length + 1, completedInnings, undoStack: [], actionLog: [], matchStatus: status,
  };
  return seal({ match_id: id(99), revision, created_at: "2026-09-25T15:00:00.000Z", snapshot });
}
function seal(value) {
  return { ...value, content_hash: createHash("sha256").update(typeof value.snapshot === "string" ? value.snapshot : JSON.stringify(value.snapshot)).digest("hex") };
}
const policy = { season: "S8_2026" };

test("shortened B-first match exports true team slots, net penalties, leg byes and actual player appearances", () => {
  const state = prepared(teamB, teamA);
  for (const [index, event] of [
    { batterRuns: 5, chip: "5F" },
    { extraType: "Leg bye", extras: 3, strikeRuns: 3 },
    { dismissal: "Bowled" },
    { dismissal: "Run Out", penalizedIndex: 0, fielder: teamA[1] },
    { batterRuns: 1, extraType: "No ball", extras: 2 },
    { dropFielder: teamA[2] },
  ].entries()) {
    state.strikerIndex = [0, 1, 0, 1, 1, 0][index]; // Explicit scorer selections, including after wickets.
    deliver(state, event, teamB, teamA);
  }
  const finalized = record(state);
  const before = structuredClone(finalized);
  const exportData = finalizationToTables(finalized, policy);
  const match = exportData.tables.matches[0];
  assert.equal(match.slot1_total, null, "Team A has not batted, rather than scoring a fabricated zero");
  assert.equal(match.slot2_total, 1);
  assert.equal(match.slot2_player_runs, -4);
  assert.equal(match.slot2_extras, 5);
  assert.equal(match.slot2_leg_byes, 3);
  assert.equal(match.slot2_run_out_penalty, -5);
  assert.equal(match.slot2_bowling_player_runs, 3);
  assert.equal(match.slot2_counting_balls, 6);
  assert.equal(match.result, null);
  assert.equal(match.winner_slot, null);
  assert.equal(match.slot1_captain_id, teamA[0]);
  assert.equal(match.players_total, 10);
  assert.equal(match.revision, 7);
  assert.equal(exportData.tables.batting.length, 2);
  const dismissed = exportData.tables.batting.find((row) => row.player_id === teamB[0]);
  assert.equal(dismissed.team_slot, "Team 2");
  assert.equal(dismissed.runs, -5);
  assert.equal(dismissed.out, 2);
  assert.equal(dismissed.fours, 1);
  assert.equal(dismissed.dots, 1, "only the scoreless dropped chance is a dot; wickets and leg byes are excluded");
  const bowler = exportData.tables.bowling[0];
  assert.equal(bowler.team_slot, "Team 1");
  assert.equal(bowler.balls, 6);
  assert.equal(bowler.runs, 3);
  assert.equal(bowler.wickets, 1);
  assert.equal(bowler.bowled, 1);
  assert.equal(bowler.wides, 2, "legacy wides column carries total bowler extras");
  assert.equal(bowler.wide_runs, 0);
  assert.equal(bowler.no_ball_runs, 2);
  assert.equal(exportData.tables.fielding.length, 8);
  assert.equal(exportData.tables.fielding.find((row) => row.player_id === teamA[1]).runouts, 1);
  assert.equal(exportData.tables.fielding.find((row) => row.player_id === teamA[2]).dropped, 1);
  assert.equal(exportData.tables.players.find((row) => row.player_id === teamB[2]).matches, 0);
  assert.equal(exportData.tables.players.find((row) => row.player_id === teamB[1]).matches, 1);
  assert.equal(exportData.provenance[0].content_hash, finalized.content_hash);
  assert.equal(exportData.generated_at, finalized.created_at);
  assert.deepEqual(finalized, before);
  const historicalPlayer = id(500);
  const history = { generated_at: "2026-09-06T00:00:00.000Z", season: "S8_2026",
    provenance: { workbook_sha256: "fixture-history-checksum" }, review: { publication_ready: false }, tables: {
      players: [{ player_id: historicalPlayer, name: names[teamB[0]] }],
      matches: [{ match_id: "historical", date: "20260828", season: "S8_2026" }],
      batting: [{ match_id: "historical", player_id: historicalPlayer, name: names[teamB[0]], team_slot: "Team 1", runs: 4, balls_faced: 1 }],
      bowling: [], fielding: [],
    } };
  const preview = statisticsPreview(history, [exportData]);
  const rawRows = (table) => preview.data.raw[table].rows.map((row) => Object.fromEntries(preview.data.raw[table].columns.map((column, i) => [column, row[i]])));
  const battingLabel = preview.review.identity_labels[teamB[0]];
  assert.notEqual(battingLabel, preview.review.identity_labels[historicalPlayer], "same names and UUID prefixes must not merge player identities");
  assert.equal(battingLabel, `${names[teamB[0]]} [${teamB[0]}]`, "same-prefix names use full permanent ID labels");
  const projectedBatter = rawRows("batting").find((row) => row.match === finalized.match_id && row.player === battingLabel);
  assert.equal(projectedBatter.runs, -5);
  assert.equal(projectedBatter.out, 2);
  assert.equal(projectedBatter.balls_faced, 3);
  assert.equal(projectedBatter.team_slot, "Team 2");
  const projectedBowler = rawRows("bowling").find((row) => row.match === finalized.match_id && row.player === preview.review.identity_labels[teamA[0]]);
  assert.equal(projectedBowler.runs, 3);
  assert.equal(projectedBowler.wides, 2);
  assert.equal(projectedBowler.balls, 6);
  assert.equal(preview.review.finalized_matches[0].provenance[0].content_hash, finalized.content_hash);
  assert.equal(preview.review.finalized_matches[0].revision, finalized.revision);
  assert.equal(preview.data.meta.generated_at, finalized.created_at);
  assert.equal(preview.data.meta.publication_ready, false, "integration remains review-only");
});

test("completed match derives winner, captures final-over rebowls and keeps same-name players separate by ID", () => {
  const first = prepared(teamA, teamB);
  while (first.legalBalls < 90) deliver(first, first.legalBalls === 0 ? { batterRuns: 7, chip: "7S" } : {}, teamA, teamB);
  deliver(first, { extraType: "Wide", extras: 2 }, teamA, teamB);
  while (first.legalBalls < 96) deliver(first, {}, teamA, teamB);
  const second = prepared(teamB, teamA);
  while (second.legalBalls < 96) deliver(second, {}, teamB, teamA);
  const finalized = record(second, { battingFirst: "teamA", completedInnings: [first], status: "completed" });
  finalized.snapshot.matchConfig.playerNames = { ...names, [teamA[1]]: names[teamA[0]] };
  const output = finalizationToTables(seal(finalized), policy);
  const match = output.tables.matches[0];
  assert.equal(match.winner_slot, "Team 1");
  assert.equal(match.result, "Team A won");
  assert.equal(match.margin, 9);
  assert.equal(match.slot1_total, 9);
  assert.equal(match.slot2_total, 0);
  assert.equal(output.tables.batting.reduce((total, row) => total + row.balls_faced, 0), 192);
  assert.equal(output.tables.bowling.reduce((total, row) => total + row.balls, 0), 192);
  assert.equal(output.tables.batting.find((row) => row.player_id === teamA[0]).sixes, 1);
  assert.equal(output.tables.bowling.find((row) => row.player_id === teamB[7]).wide_runs, 2);
  assert.equal(output.tables.players.filter((row) => row.name === names[teamA[0]]).length, 2);
  assert.equal(new Set(output.tables.players.map((row) => row.player_id)).size, 16);
  assert.equal(output.tables.fielding.length, 16);
});

test("abandoned performance retains approved boundary statistics while unplayed innings remain unknown", () => {
  const state = prepared(teamB, teamA);
  deliver(state, { batterRuns: 14, chip: "14S" }, teamB, teamA);
  const finalized = record(state, { status: "abandoned" });
  const output = finalizationToTables(finalized, { season: "S8_2026" });
  assert.equal(output.tables.matches[0].result, null);
  assert.equal(output.tables.matches[0].slot2_total, 14);
  assert.equal(output.tables.batting[0].runs, 14);
  assert.equal(output.tables.batting[0].sixes, 1);
  assert.equal(output.tables.batting[0].fours, 0);
  assert.equal(output.tables.batting[0].dots, 0);
  assert.deepEqual(output.tables.batting[0].boundary_codes, { "14S": 1 });
  assert.equal(output.review.ready, true);
  assert.equal(output.review.issues.length, 0);
  const noPlay = finalizationToTables(record(prepared(teamB, teamA), { status: "abandoned" }), policy);
  assert.equal(noPlay.tables.matches[0].slot2_total, null);
  assert.equal(noPlay.tables.matches[0].players_total, 0);
  assert.equal(noPlay.tables.batting.length, 0);
  assert.equal(noPlay.tables.bowling.length, 0);
  assert.equal(noPlay.tables.fielding.length, 0);
});

test("snapshot checksum, lifecycle, permanent identities, replay and explicit season are validated", () => {
  const state = prepared(teamB, teamA);
  deliver(state, {}, teamB, teamA);
  const finalized = record(state);
  assert.throws(() => finalizationToTables(finalized), /explicit season/);
  assert.throws(() => finalizationToTables({ ...finalized, content_hash: "0".repeat(64) }, policy), /checksum/);
  const corrupted = structuredClone(finalized);
  corrupted.snapshot.state.total = 99;
  assert.throws(() => finalizationToTables(seal(corrupted), policy), /Invalid recovery/);
  assert.throws(() => finalizationToTables(record(state, { status: "playing" }), policy), /Only completed/);
  assert.throws(() => finalizationToTables(record(state, { status: "completed" }), policy), /two complete innings/);
  assert.throws(() => finalizationToTables({ ...finalized, match_id: "Friday match 2" }, policy), /UUID/);
  const asJSON = seal({ ...finalized, snapshot: JSON.stringify(finalized.snapshot) });
  assert.deepEqual(finalizationToTables(asJSON, policy), finalizationToTables(finalized, policy));
});


test("approved rules count each coded boundary once, plain runs never as boundaries, and only scoreless non-wickets as dots", () => {
  const state = prepared(teamB, teamA);
  const codes = ['4F', '5F', '6F', '7F', '10F', '6S', '7S', '8S', '9S', '12S', '14S', '16S', '4', '6'];
  for (const chip of codes) deliver(state, { batterRuns: Number.parseInt(chip, 10), chip }, teamB, teamA);
  for (const event of [{}, { extraType: 'Leg bye', extras: 1 }, { extraType: 'Wide', extras: 2 },
    { extraType: 'No ball', extras: 2 }, { dismissal: 'Bowled' },
    { dismissal: 'Run Out', penalizedIndex: 0, fielder: teamA[1] }, { dropFielder: teamA[2] }]) {
    deliver(state, event, teamB, teamA);
  }
  const output = finalizationToTables(record(state), policy);
  const total = key => output.tables.batting.reduce((sum, row) => sum + row[key], 0);
  assert.equal(total('fours'), 5);
  assert.equal(total('sixes'), 7);
  assert.equal(total('dots'), 2, 'ordinary dot and scoreless dropped chance count; extras and dismissals do not');
  assert.equal(total('balls_faced'), 21, 'leg bye still counts as a ball faced');
  assert.equal(total('runs'), codes.reduce((sum, code) => sum + Number.parseInt(code, 10), 0) - 10);
  assert.equal(output.provenance[0].statistics_rules_version, '2026-09-30');
  assert.equal(output.review.dot_rule, 'scoreless-delivery');
  assert.equal(output.review.ready, true);
});
