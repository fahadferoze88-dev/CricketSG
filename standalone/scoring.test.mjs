import assert from "node:assert/strict";
import test from "node:test";
import { freshScore, applyDelivery, recalculateInnings, consecutiveDots } from "../testing/scoring.mjs";
import { openCorrection } from "../testing/corrections.js";

const batters = Array.from({ length: 8 }, (_, i) => `Batter ${i}`);
const fielders = Array.from({ length: 8 }, (_, i) => `Fielder ${i}`);
const teams = { batters, fielders };
let sequence = 0;
function ready() {
  const state = freshScore(batters, fielders);
  state.battingPairs = [batters.slice(0, 2)];
  state.awaitingPair = false;
  state.bowler = fielders[0];
  return state;
}
function ball(state, event = {}) {
  return applyDelivery(state, { id: `delivery-${++sequence}`, batterRuns: 0, ...event }, teams);
}
function reach(state, count) {
  while (state.legalBalls < count) {
    if (state.awaitingPair) {
      state.battingPairs[state.pairIndex] = batters.slice(state.pairIndex * 2, state.pairIndex * 2 + 2);
      state.awaitingPair = false;
    }
    state.bowler ||= fielders[Math.floor(state.legalBalls / 12)];
    ball(state);
  }
}

test("leg byes credit only team extras and counting balls, including in the last over", () => {
  const state = ready();
  ball(state, { extraType: "Leg bye", extras: 3, strikeRuns: 3 });
  assert.equal(state.total, 3);
  assert.equal(state.playerRuns[batters[0]], 0);
  assert.equal(state.playerBalls[batters[0]], 1);
  assert.equal(state.bowlerBalls[fielders[0]], 1);
  assert.equal(state.bowlerRuns[fielders[0]], 0);
  assert.equal(state.bowlerExtras[fielders[0]], 0);
  assert.equal(state.strikerIndex, 0);
  reach(state, 90);
  state.bowler = fielders[7];
  ball(state, { extraType: "Wide", extras: 2 });
  ball(state, { extraType: "No ball", extras: 2 });
  assert.equal(state.legalBalls, 90);
  assert.equal(state.history.at(-1).ballLabel, "15.1*");
  ball(state, { extraType: "Leg bye", extras: 2, strikeRuns: 2 });
  assert.equal(state.legalBalls, 91);
  assert.equal(state.bowlerBalls[fielders[7]], 7);
  assert.equal(state.bowlerRuns[fielders[7]], 4);
  assert.equal(state.bowlerExtras[fielders[7]], 4);
});

test("earlier 1-to-2 correction keeps later batters and present strike while rebuilding figures", () => {
  const state = ready();
  ball(state, { batterRuns: 1 });
  state.strikerIndex = 1;
  for (const runs of [2, 4, 0, 0]) ball(state, { batterRuns: runs });
  const before = structuredClone(state);
  const edit = structuredClone(state);
  edit.history[0].batterRuns = 2;
  const corrected = recalculateInnings(edit, batters, fielders);
  assert.equal(corrected.total, 8);
  assert.equal(corrected.playerRuns[batters[0]], 2);
  assert.equal(corrected.playerRuns[batters[1]], 6);
  assert.equal(corrected.strikerIndex, before.strikerIndex);
  assert.equal(corrected.bowler, before.bowler);
  assert.deepEqual(corrected.history.map((event) => event.striker), before.history.map((event) => event.striker));
  assert.equal(corrected.history[0].summary, "2 runs");
  assert.equal(corrected.currentOver[0].label, "2");
  assert.deepEqual(state, before, "recalculation must not mutate the original");
});

test("explicit batter and bowler corrections move only the chosen delivery's figures", () => {
  const state = ready();
  for (const runs of [2, 4, 0]) ball(state, { batterRuns: runs });
  const edit = structuredClone(state);
  [edit.history[0].striker, edit.history[0].nonStriker] = [edit.history[0].nonStriker, edit.history[0].striker];
  edit.history[0].bowler = fielders[1];
  const corrected = recalculateInnings(edit, batters, fielders);
  assert.equal(corrected.playerRuns[batters[0]], 4);
  assert.equal(corrected.playerRuns[batters[1]], 2);
  assert.equal(corrected.bowlerRuns[fielders[0]], 4);
  assert.equal(corrected.bowlerRuns[fielders[1]], 2);
  assert.equal(corrected.bowlerBalls[fielders[0]], 2);
  assert.equal(corrected.bowlerBalls[fielders[1]], 1);
  assert.equal(corrected.bowlerOvers[fielders[0]], 0);
  assert.equal(corrected.strikerIndex, state.strikerIndex);
});

test("wicket penalties and non-striker runouts preserve the scorer's selected batter", () => {
  const state = ready();
  for (let i = 0; i < 5; i++) ball(state);
  ball(state, { dismissal: "Bowled", penalizedIndex: 0 });
  assert.equal(state.strikerIndex, 0);
  assert.equal(state.total, -5);
  assert.equal(state.playerRuns[batters[0]], -5);
  assert.equal(state.bowlerRuns[fielders[0]], -5);
  assert.equal(state.bowlerWickets[fielders[0]], 1);
  assert.equal(state.bowlerBalls[fielders[0]], 6);
  state.bowler = fielders[1];
  state.strikerIndex = 1;
  ball(state, { dismissal: "Run Out", penalizedIndex: 0, fielder: fielders[2] });
  assert.equal(state.strikerIndex, 1);
  assert.equal(state.playerRuns[batters[0]], -10);
  assert.equal(state.bowlerRuns[fielders[1]], 0);
  assert.equal(state.bowlerWickets[fielders[1]], 0);
  assert.equal(state.fielding[fielders[2]].runouts, 1);
  assert.deepEqual(recalculateInnings(state, batters, fielders), state);
});

test("runs, wickets and overs never choose the next batter; selecting the next pair starts at its first member", () => {
  const state = ready();
  state.strikerIndex = 1;
  for (const runs of [1, 2, 5, 0, 3, 4]) {
    ball(state, { batterRuns: runs });
    assert.equal(state.strikerIndex, 1);
    assert.equal(state.history.at(-1).striker, batters[1]);
  }
  assert.equal(state.bowler, null);
  state.bowler = fielders[0];
  for (const dismissal of ["Bowled", "Catch", "Stumped", "Out-Other", "Run Out"]) {
    ball(state, { dismissal, fielder: fielders[1] });
    assert.equal(state.strikerIndex, 1);
    assert.equal(state.history.at(-1).striker, batters[1]);
  }
  state.strikerIndex = 0;
  ball(state, { batterRuns: 1 });
  assert.equal(state.history.at(-1).striker, batters[0]);
  assert.equal(state.strikerIndex, 0);
  reach(state, 23);
  state.strikerIndex = 1;
  ball(state);
  assert.equal(state.pairIndex, 1);
  assert.equal(state.awaitingPair, true);
  assert.equal(state.strikerIndex, 0);
});

test("consecutive dots belong to the pair, cross overs and batters, and do not automatically dismiss anyone", () => {
  const state = ready();
  for (let i = 0; i < 4; i++) ball(state, { batterRuns: 1 });
  ball(state);
  state.strikerIndex = 1;
  ball(state);
  assert.equal(state.legalBalls, 6);
  assert.equal(consecutiveDots(state), 2);
  state.bowler = fielders[0];
  state.strikerIndex = 0;
  ball(state);
  assert.equal(consecutiveDots(state), 3);
  assert.equal(state.pairWickets[0], 0);
  assert.equal(state.total, 4);
  assert.equal(state.history.length, 7);
  assert.deepEqual(state.history.slice(-3).map((event) => event.striker), [batters[0], batters[1], batters[0]]);
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(consecutiveDots(restored), 3);
  reach(restored, 24);
  assert.equal(restored.pairIndex, 1);
  assert.equal(consecutiveDots(restored), 0);
  assert.equal(consecutiveDots(freshScore(batters, fielders)), 0);
});

test("runs, every extra type and any wicket reset pair dots; manual third-ball Out-Other counts once", () => {
  const resets = [
    { batterRuns: 1 },
    ...["Wide", "No ball", "Leg bye"].map((extraType) => ({ extraType, extras: 2 })),
    ...["Bowled", "Catch", "Run Out", "Stumped", "Out-Other"].map((dismissal) => ({ dismissal, fielder: fielders[1] })),
  ];
  for (const event of resets) {
    const state = ready();
    ball(state);
    state.strikerIndex = 1;
    ball(state);
    assert.equal(consecutiveDots(state), 2);
    ball(state, event);
    assert.equal(consecutiveDots(state), 0);
    assert.equal(state.history.length, 3);
    assert.equal(state.legalBalls, 3);
    if (event.dismissal === "Out-Other") {
      assert.equal(state.total, -5);
      assert.equal(state.playerRuns[batters[1]], -5);
      assert.equal(state.playerBalls[batters[1]], 2);
      assert.equal(state.bowlerRuns[fielders[0]], -5);
      assert.equal(state.bowlerWickets[fielders[0]], 1);
      assert.equal(state.pairWickets[0], 1);
      assert.equal(state.strikerIndex, 1);
    }
  }
});

test("earlier corrections rebuild the pair dot count without changing later actors or adding wickets", () => {
  const state = ready();
  ball(state);
  state.strikerIndex = 1;
  ball(state, { batterRuns: 1 });
  ball(state);
  assert.equal(consecutiveDots(state), 1);
  const edit = structuredClone(state);
  edit.history[1].batterRuns = 0;
  const corrected = recalculateInnings(edit, batters, fielders);
  assert.equal(consecutiveDots(corrected), 3);
  assert.equal(corrected.pairWickets[0], 0);
  assert.equal(corrected.history.length, 3);
  assert.equal(corrected.legalBalls, 3);
  assert.equal(corrected.strikerIndex, state.strikerIndex);
  assert.deepEqual(corrected.history.map((event) => event.striker), state.history.map((event) => event.striker));
  assert.equal(consecutiveDots(state), 1, "a review must not alter the current innings");
});

test("two-over quota is enforced before mutating a score; first fifteen overs' extras count", () => {
  const state = ready();
  ball(state, { extraType: "Wide", extras: 2 });
  ball(state, { extraType: "No ball", extras: 2 });
  assert.equal(state.bowlerBalls[fielders[0]], 2);
  reach(state, 12);
  state.bowler = fielders[0];
  const before = structuredClone(state);
  assert.throws(() => ball(state), /exceed two overs/);
  assert.deepEqual(state, before);
});

test("count changes inside an unfinished over are rebuilt; crossing boundaries is rejected", () => {
  const state = ready();
  reach(state, 95);
  const edit = structuredClone(state);
  Object.assign(edit.history[90], { extraType: "Wide", extras: 2 });
  const corrected = recalculateInnings(edit, batters, fielders);
  assert.equal(corrected.legalBalls, 94);
  assert.equal(corrected.history[90].ballLabel, "15.1*");
  assert.equal(corrected.history[91].ballLabel, "15.1");
  assert.equal(corrected.strikerIndex, state.strikerIndex);
  reach(state, 96);
  const finishedEdit = structuredClone(state);
  Object.assign(finishedEdit.history[95], { extraType: "No ball", extras: 2 });
  assert.throws(() => recalculateInnings(finishedEdit, batters, fielders), /over or innings is complete/);
  assert.throws(() => ball(state), /Choose the batting pair and bowler/);
  const removed = structuredClone(state);
  removed.history.splice(0, 1);
  assert.throws(() => recalculateInnings(removed, batters, fielders), /across an over or pair boundary/);
});

test("legacy identities, duplicate IDs, invalid pair actors and impossible roster selections are rejected", () => {
  const state = ready();
  ball(state, { batterRuns: 4, chip: "4F" });
  const legacy = structuredClone(state);
  delete legacy.history[0].nonStriker;
  assert.throws(() => recalculateInnings(legacy, batters, fielders), /older delivery records/);
  const duplicate = structuredClone(state);
  duplicate.history.push(structuredClone(duplicate.history[0]));
  assert.throws(() => recalculateInnings(duplicate, batters, fielders), /appears twice/);
  const wrongPair = structuredClone(state);
  wrongPair.history[0].striker = batters[3];
  assert.throws(() => recalculateInnings(wrongPair, batters, fielders), /recorded batting pair/);
  assert.throws(() => freshScore(batters, batters), /eight different players/);
  assert.equal(recalculateInnings(state, batters, fielders).history[0].chip, "4F");
});

test("explicit boundary review removes a duplicate across an over and reopens a finished innings", () => {
  const state = ready();
  reach(state, 7);
  const edit = structuredClone(state);
  const removed = edit.history.shift();
  const reviewed = recalculateInnings(edit, batters, fielders, { reflow: true });
  assert.equal(reviewed.legalBalls, 6);
  assert.equal(reviewed.bowler, null);
  assert.equal(reviewed.history.at(-1).ballLabel, "0.6");
  assert.equal(reviewed.strikerIndex, state.strikerIndex);
  assert.deepEqual(reviewed.history.map((event) => event.striker), state.history.filter((event) => event.id !== removed.id).map((event) => event.striker));
  reach(state, 96);
  const reopened = structuredClone(state);
  reopened.history.pop();
  const rebuilt = recalculateInnings(reopened, batters, fielders, { reflow: true });
  assert.equal(rebuilt.legalBalls, 95);
  assert.equal(rebuilt.bowler, fielders[7]);
  assert.equal(rebuilt.bowlerBalls[fielders[7]], 11);
  assert.equal(rebuilt.strikerIndex, state.strikerIndex);
});

test("reviewed insertion can finish a pair; incompatible recorded actors cannot silently cross a pair", () => {
  const state = ready();
  reach(state, 23);
  const inserted = structuredClone(state);
  inserted.history.push({ ...inserted.history.at(-1), id: `delivery-${++sequence}` });
  const reviewed = recalculateInnings(inserted, batters, fielders, { reflow: true });
  assert.equal(reviewed.legalBalls, 24);
  assert.equal(reviewed.pairIndex, 1);
  assert.equal(reviewed.awaitingPair, true);
  assert.equal(reviewed.bowler, null);
  reach(state, 25);
  const inconsistent = structuredClone(state);
  inconsistent.history.shift();
  assert.throws(() => recalculateInnings(inconsistent, batters, fielders, { reflow: true }), /recorded batting pair/);
  const old = structuredClone(state);
  delete old.history[0].overIndex;
  assert.throws(() => recalculateInnings(old, batters, fielders, { reflow: true }), /older delivery records/);
});

test("pair identity correction assigns the existing deliveries to an unused member of the same team", () => {
  const state = ready();
  ball(state, { batterRuns: 2 });
  const edit = structuredClone(state);
  edit.battingPairs[0][0] = batters[2];
  edit.history[0].striker = batters[2];
  const corrected = recalculateInnings(edit, batters, fielders);
  assert.equal(corrected.playerRuns[batters[0]], 0);
  assert.equal(corrected.playerRuns[batters[2]], 2);
  assert.equal(corrected.battingPairs[0][corrected.strikerIndex], batters[2]);
});

// Small DOM double checks the review/save contract; native-dialog rendering is checked in the browser.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.handlers = {}; this.textContent = ""; }
  get value() { return this._value ?? (this.tag === "select" ? this.children[0]?.value || "" : ""); }
  set value(value) { this._value = String(value); }
  append(child) { child.parent = this; this.children.push(child); }
  replaceChildren() { this.children = []; this._value = undefined; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(name, listener) { (this.handlers[name] ||= []).push(listener); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  reportValidity() { return true; }
  async fire(name) {
    const event = { stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; } };
    for (let element = this; element; element = element.parent) {
      for (const listener of element.handlers[name] || []) await listener(event);
      if (event.stopped) break;
    }
  }
}
const descendants = (element) => [element, ...element.children.flatMap(descendants)];

test("correction dialog requires a reviewed candidate and confirmation, invalidates stale previews, and preserves original", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { body: new Element("body"), createElement: (tag) => new Element(tag) };
  try {
    const state = ready();
    for (const runs of [1, 4, 0]) ball(state, { batterRuns: runs });
    const original = structuredClone(state);
    const saves = [];
    const dialog = openCorrection({ innings: state, batters, fielders, label: "first innings", onSave: (...args) => { saves.push(args); } }, state.history[0].id);
    const control = (name) => descendants(dialog).find((item) => item.tag === "label" && item.textContent === name).children[0];
    const click = (text) => descendants(dialog).find((item) => item.tag === "button" && item.textContent === text).fire("click");
    const confirm = descendants(dialog).find((item) => item.textContent === "Confirm and save correction");
    assert.equal(confirm.disabled, true);
    control("Batter runs").value = 2;
    control("Reason for correction").value = "Entered one instead of two";
    await click("Review correction");
    assert.equal(confirm.disabled, false);
    assert.equal(saves.length, 0);
    assert.deepEqual(state, original);
    control("Batter runs").value = 3;
    await control("Batter runs").fire("input");
    assert.equal(confirm.disabled, true);
    await click("Confirm and save correction");
    assert.equal(saves.length, 0);
    await click("Review correction");
    await click("Confirm and save correction");
    assert.equal(saves.length, 1);
    assert.equal(saves[0][0].total, 7);
    assert.equal(saves[0][0].strikerIndex, state.strikerIndex);
    assert.equal(saves[0][1].reason, "Entered one instead of two");
    assert.equal(saves[0][1].kind, "replace");
    assert.equal(saves[0][1].before.deliveries.length, 1);
    assert.equal(saves[0][1].after.deliveries.length, 1);
    assert.equal(saves[0][1].before.deliveries[0].batterRuns, 1);
    assert.equal(saves[0][1].after.deliveries[0].batterRuns, 3);
    assert.equal(saves[0][1].after.current, undefined, "unchanged current selections do not bloat the audit");
    assert.deepEqual(state, original);
    assert.equal(dialog.open, false);
  } finally { globalThis.document = previousDocument; }
});

test("player label callback hides stored UUIDs in options, summaries, review figures and save errors", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { body: new Element("body"), createElement: (tag) => new Element(tag) };
  try {
    const ids = Array.from({ length: 16 }, () => crypto.randomUUID());
    const names = new Map(ids.map((id, i) => [id, `Player ${i + 1}`]));
    const batting = ids.slice(0, 8);
    const bowling = ids.slice(8);
    const state = freshScore(batting, bowling);
    Object.assign(state, { battingPairs: [batting.slice(0, 2)], awaitingPair: false, bowler: bowling[0] });
    applyDelivery(state, { id: crypto.randomUUID(), batterRuns: 0, dismissal: "Catch", fielder: bowling[1] }, { batters: batting, fielders: bowling });
    const dialog = openCorrection({ innings: state, batters: batting, fielders: bowling, label: (id) => names.get(id), onSave() { throw new Error(`${bowling[0]} could not be saved`); } });
    const control = (name) => descendants(dialog).find((item) => item.tag === "label" && item.textContent === name).children[0];
    const click = (text) => descendants(dialog).find((item) => item.tag === "button" && item.textContent === text).fire("click");
    const visibleText = () => descendants(dialog).map((item) => item.textContent).join("\n");
    assert.match(visibleText(), /Correct delivery/);
    assert.match(visibleText(), /Catch · Player 10/);
    assert.equal(control("Bowler").value, bowling[0], "stored values remain canonical IDs");
    control("Batter runs").value = 2;
    control("Reason for correction").value = "Missed two runs before the catch";
    await click("Review correction");
    assert.match(visibleText(), /Player 1: -5 runs/);
    assert.match(visibleText(), /Player 9 bowling:/);
    await click("Confirm and save correction");
    assert.match(visibleText(), /Player 9 could not be saved/);
    for (const id of ids) assert.equal(visibleText().includes(id), false, "canonical IDs must not appear as visible player names");
  } finally { globalThis.document = previousDocument; }
});

test("correcting the whole current over updates the next delivery's bowler and audits the selection; single-ball correction does not", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { body: new Element("body"), createElement: (tag) => new Element(tag) };
  try {
    const state = ready();
    for (const runs of [1, 2, 0]) ball(state, { batterRuns: runs });
    for (const scope of ["delivery", "over"]) {
      let saved;
      const dialog = openCorrection({ innings: state, batters, fielders, onSave: (...args) => { saved = args; } }, state.history[0].id);
      const control = (name) => descendants(dialog).find((item) => item.tag === "label" && item.textContent === name).children[0];
      const click = (text) => descendants(dialog).find((item) => item.tag === "button" && item.textContent === text).fire("click");
      control("Bowler").value = fielders[1];
      control("Apply this bowler to").value = scope;
      control("Reason for correction").value = "Wrong bowler selected";
      await click("Review correction");
      if (scope === "over") assert.match(descendants(dialog).map((item) => item.textContent).join("\n"), /Current bowler: Fielder 0 → Fielder 1/);
      await click("Confirm and save correction");
      assert.equal(saved[0].bowler, scope === "over" ? fielders[1] : fielders[0]);
      if (scope === "over") {
        assert.equal(saved[1].before.current.bowler, fielders[0]);
        assert.equal(saved[1].after.current.bowler, fielders[1]);
        assert.equal(saved[0].history.every((event) => event.bowler === fielders[1]), true);
        ball(saved[0]);
        assert.equal(saved[0].history.at(-1).bowler, fielders[1]);
      } else assert.equal(saved[1].after.current, undefined);
      assert.equal(state.bowler, fielders[0], "opening the editor never mutates its input");
    }
  } finally { globalThis.document = previousDocument; }
});
