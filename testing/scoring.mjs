const dismissals = new Set(["Bowled", "Catch", "Run Out", "Stumped", "Out-Other"]);
const extraTypes = new Set(["", "Wide", "No ball", "Leg bye"]);
const zeros = (players) => Object.fromEntries(players.map((player) => [player, 0]));
const copy = (value) => JSON.parse(JSON.stringify(value));
const fail = (message) => { throw new Error(message); };

function validateRosters(batters, fielders) {
  if (![batters, fielders].every((players) => Array.isArray(players) && players.length === 8 &&
      players.every((player) => typeof player === "string" && player.trim())) ||
      new Set([...batters, ...fielders]).size !== 16) fail("Choose eight different players for each team.");
}

export function freshScore(batters, fielders) {
  validateRosters(batters, fielders);
  return {
    scoringVersion: 2, battingPairs: [], total: 0, legalBalls: 0, pairIndex: 0, strikerIndex: 0,
    pairScores: [0, 0, 0, 0], pairWickets: [0, 0, 0, 0],
    playerRuns: zeros(batters), playerBalls: zeros(batters),
    bowler: null, bowlerOvers: zeros(fielders), bowlerBalls: zeros(fielders),
    bowlerRuns: zeros(fielders), bowlerWickets: zeros(fielders), bowlerExtras: zeros(fielders),
    fielding: Object.fromEntries(fielders.map((player) => [player, { catches: 0, runouts: 0, stumpings: 0, drops: 0 }])),
    currentOver: [], history: [], overRuns: 0, awaitingPair: true,
  };
}

function validateSelections(innings, batters, fielders) {
  const pairs = innings.battingPairs;
  if (!Array.isArray(pairs) || pairs.length > 4 || pairs.some((pair) =>
    !Array.isArray(pair) || pair.length !== 2 || pair.some((player) => !batters.includes(player))) ||
    new Set(pairs.flat()).size !== pairs.length * 2) fail("Each batter must belong to one batting pair.");
  if (!Number.isInteger(innings.legalBalls) || innings.legalBalls < 0 || innings.legalBalls > 96 ||
      ![0, 1, 2, 3].includes(innings.pairIndex) || ![0, 1].includes(innings.strikerIndex) ||
      typeof innings.awaitingPair !== "boolean" || (!innings.awaitingPair && !pairs[innings.pairIndex]) ||
      !(innings.bowler === null || fielders.includes(innings.bowler))) fail("Invalid current pair, strike or bowler selection.");
  if (innings.pairIndex !== Math.min(3, Math.floor(innings.legalBalls / 24))) fail("Current pair does not match the innings ball count.");
}

function validateEvent(event, innings, batters, fielders) {
  if (!event || typeof event.id !== "string" || !event.id || !Number.isInteger(event.pairIndex) ||
      !Number.isInteger(event.overIndex) || typeof event.striker !== "string" ||
      typeof event.nonStriker !== "string" || !Object.hasOwn(event, "penalizedPlayer")) {
    fail("This match has older delivery records without player identities. Earlier-ball corrections are unavailable; keep its recovery copy.");
  }
  const pair = innings.battingPairs[event.pairIndex];
  if (!pair || !pair.includes(event.striker) || !pair.includes(event.nonStriker) ||
      event.striker === event.nonStriker || !batters.includes(event.striker) || !fielders.includes(event.bowler)) {
    fail("Choose the recorded batting pair and a bowler from the fielding team.");
  }
  for (const key of ["batterRuns", "extras", "strikeRuns"]) {
    if (event[key] !== undefined && (!Number.isSafeInteger(event[key]) || event[key] < 0 || event[key] > 100)) {
      fail("Runs and extras must be whole numbers between 0 and 100.");
    }
  }
  if (!extraTypes.has(event.extraType || "") || (event.dismissal && !dismissals.has(event.dismissal))) fail("Unknown extra or dismissal type.");
  if ((event.extras || 0) > 0 && !event.extraType) fail("Choose an extra type for these extras.");
  if (event.extraType && !(event.extras > 0)) fail("An extra needs at least one extra run.");
  if (event.extraType === "Leg bye" && (event.batterRuns || 0) !== 0) fail("Leg byes are team extras, not batter runs.");
  if (event.dismissal ? !pair.includes(event.penalizedPlayer) : event.penalizedPlayer !== null) fail("Choose the dismissed player from the recorded pair.");
  if (event.dismissal && event.dismissal !== "Run Out" && event.penalizedPlayer !== event.striker) fail("Only a runout can dismiss the non-striker.");
  if ((event.fielder && !fielders.includes(event.fielder)) || (event.dropFielder && !fielders.includes(event.dropFielder))) fail("Choose a fielder from the fielding team.");
  if (["Catch", "Run Out", "Stumped"].includes(event.dismissal) && !event.fielder) fail("Choose the fielder for this dismissal.");
}

function labels(event) {
  const runs = event.batterRuns || 0;
  const extras = event.extras || 0;
  const extraCode = { Wide: "Wd", "No ball": "Nb", "Leg bye": "Lb" }[event.extraType];
  if (event.dismissal) return {
    chip: `W${runs ? `+${runs}` : ""}${extras ? `+${extraCode}${extras}` : ""}`, kind: "wicket",
    summary: `${event.dismissal}${event.fielder ? ` · ${event.fielder}` : ""}${runs ? ` · ${runs} runs` : ""}${extras ? ` · ${event.extraType} +${extras}` : ""}`,
  };
  if (event.extraType) return { chip: `${extraCode}${extras}`, kind: "extra", summary: `${event.extraType} +${extras}${runs ? ` · ${runs} batter runs` : ""}` };
  if (event.dropFielder) return { chip: `D${runs}`, kind: "extra", summary: `Dropped · ${event.dropFielder} · ${runs} runs` };
  const coded = /^\d+[FS]$/.test(event.chip || "") && Number.parseInt(event.chip, 10) === runs;
  return { chip: coded ? event.chip : String(runs), kind: "run", summary: coded ? `${event.chip} · ${runs} batter runs` : runs ? `${runs} run${runs === 1 ? "" : "s"}` : "Dot ball" };
}

// Recorded actors are facts. Rebuilding figures never derives later batters from earlier run parity.
function addFigures(state, event) {
  const over = Math.floor(state.legalBalls / 6);
  if (state.legalBalls >= 96) fail("This edit would add deliveries after the innings ended. Correct the extra entry first.");
  if (event.pairIndex !== Math.floor(state.legalBalls / 24) || event.overIndex !== over) {
    fail("This edit moves a delivery across an over or pair boundary. Correct the affected delivery entries together first.");
  }
  const counts = !(over === 15 && ["Wide", "No ball"].includes(event.extraType));
  if (state.bowlerBalls[event.bowler] + Number(counts) > 12) fail(`${event.bowler} would exceed two overs. Correct the bowler entries first.`);
  const runs = event.batterRuns || 0;
  const extras = event.extras || 0;
  const wicket = Boolean(event.dismissal);
  const bowlerWicket = wicket && event.dismissal !== "Run Out";
  const total = runs + extras - (wicket ? 5 : 0);
  state.total += total;
  state.pairScores[event.pairIndex] += total;
  state.pairWickets[event.pairIndex] += Number(wicket);
  state.playerRuns[event.striker] += runs;
  if (wicket) state.playerRuns[event.penalizedPlayer] -= 5;
  state.playerBalls[event.striker] += Number(counts);
  state.bowlerBalls[event.bowler] += Number(counts);
  state.bowlerOvers[event.bowler] = Math.floor(state.bowlerBalls[event.bowler] / 6);
  state.bowlerRuns[event.bowler] += runs + (event.extraType === "Leg bye" ? 0 : extras) - (bowlerWicket ? 5 : 0);
  state.bowlerExtras[event.bowler] += event.extraType === "Leg bye" ? 0 : extras;
  state.bowlerWickets[event.bowler] += Number(bowlerWicket);
  const fieldingKey = { Catch: "catches", "Run Out": "runouts", Stumped: "stumpings" }[event.dismissal];
  if (fieldingKey) state.fielding[event.fielder][fieldingKey] += 1;
  if (event.dropFielder) state.fielding[event.dropFielder].drops += 1;
  const recorded = { ...event, ...labels(event), ballLabel: `${over}.${state.legalBalls % 6 + 1}${counts ? "" : "*"}` };
  state.history.push(recorded);
  state.currentOver.push({ label: recorded.chip, kind: recorded.kind });
  state.overRuns += total;
  state.legalBalls += Number(counts);
  const overEnded = counts && state.legalBalls % 6 === 0;
  if (overEnded) { state.currentOver = []; state.overRuns = 0; }
  return { counts, overEnded };
}

export function applyDelivery(state, event, { batters, fielders }) {
  validateRosters(batters, fielders);
  validateSelections(state, batters, fielders);
  if (state.awaitingPair || !state.bowler) fail("Choose the batting pair and bowler before scoring.");
  if (!state.bowlerBalls) fail("Resume this older match with the legacy scorer; its delivery identities are incomplete.");
  const pair = state.battingPairs[state.pairIndex];
  const recorded = {
    ...event, striker: pair[state.strikerIndex], nonStriker: pair[1 - state.strikerIndex],
    bowler: state.bowler, pairIndex: state.pairIndex, overIndex: Math.floor(state.legalBalls / 6),
    penalizedPlayer: event.dismissal ? pair[event.penalizedIndex ?? state.strikerIndex] : null,
  };
  validateEvent(recorded, state, batters, fielders);
  if (state.history.some((past) => past.id === recorded.id)) fail("This delivery has already been recorded.");
  const { overEnded } = addFigures(state, recorded);
  // The scorer selects the facing batter, including after runs, wickets and completed overs.
  if (overEnded) {
    state.bowler = null;
    if (state.legalBalls < 96 && state.legalBalls % 24 === 0) {
      state.pairIndex += 1;
      state.strikerIndex = 0;
      state.awaitingPair = true;
    }
  }
  return state;
}

export function consecutiveDots(innings) {
  const history = innings?.history || [];
  let dots = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const event = history[index];
    if (event.pairIndex !== innings.pairIndex || (event.batterRuns || 0) !== 0 ||
        (event.extras || 0) !== 0 || event.dismissal) break;
    dots += 1;
  }
  return dots;
}

export function recalculateInnings(innings, batters, fielders, { reflow = false } = {}) {
  validateRosters(batters, fielders);
  validateSelections(innings, batters, fielders);
  if (innings.scoringVersion !== 2 || !Array.isArray(innings.history)) fail("This older match does not have the recorded identities needed for earlier-ball correction.");
  const rebuilt = freshScore(batters, fielders);
  rebuilt.battingPairs = copy(innings.battingPairs);
  const ids = new Set();
  for (const source of innings.history) {
    validateEvent(source, rebuilt, batters, fielders);
    // Reflow is an explicit reviewed correction. Actors never change with ball numbering.
    const event = reflow ? { ...source, pairIndex: Math.min(3, Math.floor(rebuilt.legalBalls / 24)), overIndex: Math.floor(rebuilt.legalBalls / 6) } : source;
    validateEvent(event, rebuilt, batters, fielders);
    if (ids.has(event.id)) fail("A delivery appears twice. Remove the duplicate entry first.");
    ids.add(event.id);
    addFigures(rebuilt, event);
  }
  if (!reflow && Math.floor(rebuilt.legalBalls / 6) !== Math.floor(innings.legalBalls / 6)) {
    fail("This edit changes whether an over or innings is complete. Correct the ball count before applying it.");
  }
  // Users correct strike on the field. Keep their present selections even after an odd/even run edit.
  for (const key of ["pairIndex", "strikerIndex", "bowler", "awaitingPair"]) rebuilt[key] = innings[key];
  if (reflow && rebuilt.legalBalls !== innings.legalBalls) {
    const currentStriker = innings.battingPairs[innings.pairIndex]?.[innings.strikerIndex];
    rebuilt.pairIndex = Math.min(3, Math.floor(rebuilt.legalBalls / 24));
    const pair = rebuilt.battingPairs[rebuilt.pairIndex];
    rebuilt.awaitingPair = !pair;
    rebuilt.strikerIndex = pair?.includes(currentStriker) ? pair.indexOf(currentStriker) : 0;
    if (rebuilt.legalBalls % 6 === 0) rebuilt.bowler = null;
    else if (Math.floor(rebuilt.legalBalls / 6) !== Math.floor(innings.legalBalls / 6) || !rebuilt.bowler) rebuilt.bowler = rebuilt.history.at(-1)?.bowler ?? null;
  }
  return rebuilt;
}
