import { validateRecovery } from "./recovery.mjs";
import { freshScore, applyDelivery, consecutiveDots } from "./scoring.mjs";
import { initializePlayers, renderTeamPickers, selectedTeams, playerNames, openPlayers, syncPlayers } from "./players.js";
import { openCorrection } from "./corrections.js";
const defaultPairs = [
  ["Muqeem", "Shoaib"],
  ["Bilal", "Aasim"],
  ["Asif", "Ali L"],
  ["Fahad", "Naveed"],
];
let batters = defaultPairs.flat();

let fielders = ["Abdul Samad", "Akshay", "Ali Rizvi", "Anoosh", "Daniyal", "Fazal", "Juzer", "Kashif Ali"];
const secondaryCodes = ["5F", "7S", "5", "8", "4F", "6S", "6F", "7F", "8S", "9S", "6", "7", "9", "10F", "10", "12S", "14S", "16S"];
const codeValues = Object.fromEntries(secondaryCodes.map((code) => [code, Number.parseInt(code, 10)]));

const STORAGE_KEY = "cricketops-testing-match-v1";
let state = null;
let matchConfig = null;
let inningsNumber = 1;
let completedInnings = [];
let undoStack = [];
let actionLog = [];
let matchStatus = "playing";
let finalizedRevision = null;
let saveFailed = false;
let saving = null;
let store = null;
let matchId = null;
let revision = 0;
let generation = 0;
let ready = false;
let deviceId = null;
let syncing = null;
let syncAgain = false;
const cloudConflicts = new Set();
let openSheetId = null;
let pairSelection = [];
let selections = { extraType: "Wide", extraRuns: 2, extraBatter: 0, dismissal: "Catch", penalized: 0, wicketRuns: 0, dropType: "Dropped", dropRuns: 0 };

const $ = (id) => document.getElementById(id);
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"\']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "\'": "&#39;" }[char]));
const playerLabel = (id) => matchConfig?.playerNames?.[id] || id;
const initials = (name) => name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
const currentPair = () => state.battingPairs[state.pairIndex] || ["Choose batter", "Choose batter"];
const strikerName = () => currentPair()[state.strikerIndex];
const nonStrikerName = () => currentPair()[1 - state.strikerIndex];

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function freshInnings() {
  if (matchConfig?.schemaVersion === 2) return freshScore(batters, fielders);
  return {
    battingPairs: [], total: 0, legalBalls: 0, pairIndex: 0, strikerIndex: 0,
    pairScores: [0, 0, 0, 0], pairWickets: [0, 0, 0, 0],
    playerRuns: Object.fromEntries(batters.map((name) => [name, 0])),
    playerBalls: Object.fromEntries(batters.map((name) => [name, 0])),
    bowler: null, bowlerOvers: Object.fromEntries(fielders.map((name) => [name, 0])),
    bowlerRuns: Object.fromEntries(fielders.map((name) => [name, 0])),
    bowlerWickets: Object.fromEntries(fielders.map((name) => [name, 0])),
    bowlerExtras: Object.fromEntries(fielders.map((name) => [name, 0])),
    fielding: Object.fromEntries(fielders.map((name) => [name, { catches: 0, runouts: 0, stumpings: 0, drops: 0 }])),
    currentOver: [], history: [], overRuns: 0, awaitingPair: true,
  };
}

function recoverySnapshot() {
  return clone({ matchConfig, state, inningsNumber, completedInnings, undoStack, actionLog, matchStatus });
}

function audit(kind, before = null, after = null, reason = "Scoring action", innings = inningsNumber) {
  actionLog.push({ id: crypto.randomUUID(), kind, before: clone(before), after: clone(after),
    reason, innings, at: new Date().toISOString() });
}

function saveError(error) {
  saveFailed = true;
  $("syncText").textContent = "Not saved";
  $("syncButton").setAttribute("aria-label", "Save failed. Click to retry.");
  $("saveWarning").textContent = error?.name === "RevisionConflict" ? error.message :
    "Latest changes are NOT saved. Scoring is paused. Keep this page open. Tap Not saved to retry, or use Match controls → Download match data to keep a copy.";
  $("saveWarning").hidden = false;
}

function persist() {
  if (saving) return saving;
  if (!store || !state || !matchConfig) return Promise.resolve(false);
  matchId ||= crypto.randomUUID();
  const snapshot = recoverySnapshot();
  $("syncText").textContent = "Saving…";
  $("syncButton").setAttribute("aria-label", "Saving. Wait before the next action.");
  saving = store.save(matchId, revision, snapshot, generation).then((record) => {
    revision = record.revision;
    saveFailed = false;
    $("syncText").textContent = "Saved on device";
    $("syncButton").setAttribute("aria-label", "Saved on this device, not yet in the cloud. Click to save again.");
    $("saveWarning").hidden = true;
    return true;
  }).catch((error) => { saveError(error); return false; }).finally(() => { saving = null; syncCloud(); });
  return saving;
}

function canChangeMatch(ignoreCloudConflict = false) {
  if (!ignoreCloudConflict && cloudConflicts.has(matchId)) { showToast("Scoring paused · this match changed on another device. Your copy is kept."); return false; }
  if (!ready) { showToast("Opening device storage…"); return false; }
  if (saving) { showToast("Saving · wait before the next action"); return false; }
  if (saveFailed) showToast("Scoring paused · tap Not saved to retry saving first");
  return !saveFailed;
}

function teamForKey(key) { return matchConfig[key]; }
function battingKey() { return inningsNumber === 1 ? matchConfig.battingFirst : (matchConfig.battingFirst === "teamA" ? "teamB" : "teamA"); }
function bowlingKey() { return battingKey() === "teamA" ? "teamB" : "teamA"; }

function activateTeams() {
  batters = [...teamForKey(battingKey()).players];
  fielders = [...teamForKey(bowlingKey()).players];
}

function saveSnapshot() {
  undoStack.push(clone(state));
  if (undoStack.length > 30) undoStack.shift();
}

function render(save = true) {
  if (save) persist();
  const striker = strikerName();
  const nonStriker = nonStrikerName();
  const over = Math.floor(state.legalBalls / 6);
  const ball = state.legalBalls % 6;
  $("matchHeader").textContent = `${matchConfig.matchName} · ${formatMatchDate(matchConfig.date)}`;
  const target = inningsNumber === 2 && completedInnings[0] ? ` · target ${completedInnings[0].total + 1}` : "";
  $("inningsLabel").textContent = `${teamForKey(battingKey()).name} · ${inningsNumber === 1 ? "first" : "second"} innings${target}`;
  $("teamScore").textContent = formatSigned(state.total);
  $("oversDisplay").textContent = `${over}.${ball} / 16 overs`;
  $("pairLabel").textContent = `${state.pairIndex + 1} of 4`;
  $("pairScore").textContent = formatSigned(state.pairScores[state.pairIndex]);
  $("runRate").textContent = state.legalBalls ? (state.total / state.legalBalls * 6).toFixed(2) : "0.00";
  $("overRuns").textContent = formatSigned(state.overRuns);
  $("strikerName").textContent = playerLabel(striker);
  $("nonStrikerName").textContent = playerLabel(nonStriker);
  $("strikerRuns").textContent = formatSigned(state.playerRuns[striker] || 0);
  $("nonStrikerRuns").textContent = formatSigned(state.playerRuns[nonStriker] || 0);
  $("strikerCard").disabled = state.awaitingPair;
  $("nonStrikerCard").disabled = state.awaitingPair;
  $("strikerCard").setAttribute("aria-pressed", "true");
  $("nonStrikerCard").setAttribute("aria-pressed", "false");
  const dots = state.scoringVersion === 2 ? consecutiveDots(state) : 0;
  $("dotStatus").hidden = state.scoringVersion !== 2;
  $("dotStatus").textContent = dots >= 3
    ? `${dots} consecutive dots · Check history and correct the third dot to Out-Other if it was missed.`
    : dots === 2 ? "2 consecutive dots · If the next delivery is scoreless, enter Wicket → Out-Other on that ball."
    : `${dots} consecutive dot${dots === 1 ? "" : "s"} for this pair`;
  $("bowlerName").textContent = playerLabel(state.bowler) || "Choose bowler";
  $("bowlerInitials").textContent = state.bowler ? initials(playerLabel(state.bowler)) : "?";
  $("bowlerFigures").textContent = state.bowler ? `${overFigure(state.bowler)} overs · ${state.bowlerRuns[state.bowler] || 0} runs · ${state.bowlerWickets[state.bowler] || 0} wickets` : "Required before the next ball";
  $("rotationStatus").textContent = `${Math.floor(state.legalBalls / 6)} of 16 overs complete`;
  $("currentOverLabel").textContent = `Over ${Math.min(16, over + 1)}`;
  $("bowlerOverNumber").textContent = Math.min(16, over + 1);
  $("undoButton").disabled = undoStack.length === 0;
  $("matchStatusText").textContent = matchStatus === "playing" ? "Playing" : `${matchStatus} · ${finalizedRevision === revision ? "cloud finalized" : "local result saved"}`;
  renderBallStrip();
  renderRotation();
  renderHistory();
  renderBowlerList();
  refreshWicketSheet();
  updateExtraForm();
}

function formatMatchDate(value) {
  return new Intl.DateTimeFormat("en-SG", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function updateExtraForm() {
  const isLegBye = selections.extraType === "Leg bye";
  document.querySelectorAll("[data-leg-bye-only]").forEach((button) => { button.hidden = !isLegBye; });
  $("extraBatterSection").hidden = isLegBye;
  if (isLegBye) selections.extraBatter = 0;
  if (!isLegBye && selections.extraRuns > 4) selections.extraRuns = 4;
  $("extraRunChoices").querySelectorAll(".choice").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.value) === selections.extraRuns);
  });
  const finalOver = Math.floor(state.legalBalls / 6) === 15;
  $("extraRule").textContent = finalOver && !isLegBye
    ? "Final-over rule: this extra is saved, but the ball number does not advance. The delivery is rebowled."
    : isLegBye
      ? "Leg byes consume the current ball. Odd totals rotate the strike."
      : "In overs 1–15, this consumes the current ball.";
}

function overFigure(name) {
  if (state.bowlerBalls) return `${Math.floor(state.bowlerBalls[name] / 6)}.${state.bowlerBalls[name] % 6}`;
  const full = state.bowlerOvers[name] || 0;
  return name === state.bowler ? `${full}.${state.legalBalls % 6}` : `${full}.0`;
}

function renderBallStrip() {
  const items = [...state.currentOver];
  while (items.length < 6) items.push(null);
  $("ballStrip").innerHTML = items.slice(-6).map((item, index) => {
    if (!item) return `<span class="ball-chip empty">${index + 1}</span>`;
    return `<span class="ball-chip ${["run", "extra", "wicket"].includes(item.kind) ? item.kind : ""}">${escapeHTML(item.label)}</span>`;
  }).join("");
}

function renderRotation() {
  const completed = Math.floor(state.legalBalls / 6);
  $("rotationDots").innerHTML = Array.from({ length: 8 }, (_, index) => {
    const threshold = (index + 1) * 2;
    const klass = completed >= threshold ? "done" : completed >= threshold - 1 ? "current" : "";
    return `<i class="${klass}"></i>`;
  }).join("");
}

function renderHistory() {
  const selected = Number($("historyInnings").value) || inningsNumber;
  const number = Math.min(selected, inningsNumber);
  const innings = number === inningsNumber ? state : completedInnings[number - 1];
  $("historyInnings").querySelectorAll("option").forEach(option => { option.disabled = Number(option.value) > inningsNumber; });
  const rows = innings.history.slice().reverse();
  $("historyList").innerHTML = rows.length ? rows.map(event => `
    <button type="button" class="history-row" data-edit-delivery="${escapeHTML(event.id || "legacy")}" data-edit-innings="${number}"><span>${escapeHTML(event.ballLabel)}</span><strong>${escapeHTML(event.chip)} · ${escapeHTML(event.summary.replaceAll(event.fielder || "~never~", playerLabel(event.fielder) || "").replaceAll(event.dropFielder || "~never~", playerLabel(event.dropFielder) || ""))}</strong><em>${escapeHTML(playerLabel(event.striker))} · Edit</em></button>
  `).join("") : `<p class="sheet-note">Recorded deliveries appear here.</p>`;
}

function correctDelivery(number, deliveryId) {
  if (!canChangeMatch()) return;
  const innings = number === inningsNumber ? state : completedInnings[number - 1];
  const key = number === 1 ? matchConfig.battingFirst : (matchConfig.battingFirst === "teamA" ? "teamB" : "teamA");
  openCorrection({ innings, batters: matchConfig[key].players,
    fielders: matchConfig[key === "teamA" ? "teamB" : "teamA"].players, label: playerLabel,
    onSave(next, change) {
      if (!canChangeMatch()) throw new Error("Wait for the current save before applying this correction.");
      if (number < inningsNumber && next.legalBalls < 96 && next.legalBalls !== innings.legalBalls &&
          !window.confirm("This makes the first innings shorter. Keep all second-innings deliveries and treat the first innings as shortened?")) throw new Error("Correction cancelled; original deliveries kept.");
      if (matchStatus === "completed" && next.legalBalls < 96) {
        const status = number < inningsNumber ? "shortened" : "playing";
        audit("status", matchStatus, status, "Completion changed by delivery correction"); matchStatus = status;
      }
      audit(change.kind, change.before, change.after, change.reason, number);
      if (number === inningsNumber) state = next; else completedInnings[number - 1] = next;
      undoStack = []; // Old snapshots must never resurrect the entry just corrected.
      render();
      showToast("Correction saved · later batter assignments kept");
    }
  }, deliveryId);
}

function renderBowlerList() {
  $("bowlerList").innerHTML = fielders.map((name) => {
    const overs = state.bowlerOvers[name] || 0;
    return `<button type="button" class="roster-option ${overs >= 2 ? "complete" : ""}" data-bowler="${escapeHTML(name)}"><span><strong>${escapeHTML(playerLabel(name))}</strong><span>${overs} of 2 overs completed</span></span></button>`;
  }).join("");
  document.querySelectorAll("[data-bowler]").forEach((button) => button.addEventListener("click", () => chooseBowler(button.dataset.bowler)));
}

function commitEvent(event) {
  if (!canChangeMatch()) return;
  if (state.legalBalls >= 96) { showInningsComplete(); return; }
  if (state.awaitingPair) { openSheet("pairSheet"); showToast("Choose the next batting pair"); return; }
  if (!state.bowler) { openSheet("bowlerSheet"); showToast("Choose a bowler before scoring"); return; }
  if (matchStatus !== "playing") { showToast("Reopen the match in Match controls before adding balls."); return; }
  if (state.scoringVersion === 2) {
    const next = clone(state);
    try { applyDelivery(next, { ...event, id: crypto.randomUUID() }, { batters, fielders }); }
    catch (error) { showToast(error.message); return; }
    saveSnapshot();
    state = next;
    audit("delivery", null, { id: state.history.at(-1).id });
    closeSheet(); render();
    if (state.legalBalls >= 96) setTimeout(showInningsComplete, 250);
    else if (state.awaitingPair || !state.bowler) setTimeout(() => openSheet(state.awaitingPair ? "pairSheet" : "bowlerSheet"), 250);
    return;
  }
  saveSnapshot();
  const beforeBalls = state.legalBalls;
  const beforeOver = Math.floor(beforeBalls / 6);
  const beforeBall = beforeBalls % 6;
  const batter = strikerName();
  const batterRuns = event.batterRuns || 0;
  const extras = event.extras || 0;
  const penalty = event.dismissal ? 5 : 0;
  const increment = batterRuns + extras - penalty;
  state.total += increment;
  state.pairScores[state.pairIndex] += increment;
  state.playerRuns[batter] = (state.playerRuns[batter] || 0) + batterRuns;
  if (event.dismissal) {
    const penalizedName = currentPair()[event.penalizedIndex ?? state.strikerIndex];
    state.playerRuns[penalizedName] = (state.playerRuns[penalizedName] || 0) - 5;
    state.pairWickets[state.pairIndex] += 1;
  }
  state.overRuns += increment;

  const finalOverRebowl = beforeOver === 15 && ["Wide", "No ball"].includes(event.extraType);
  const advancesBall = !finalOverRebowl;
  if (advancesBall) state.playerBalls[batter] = (state.playerBalls[batter] || 0) + 1;
  const bowlerWicket = event.dismissal && event.dismissal !== "Run Out";
  state.bowlerRuns[state.bowler] = (state.bowlerRuns[state.bowler] || 0) + batterRuns + extras - (bowlerWicket ? 5 : 0);
  state.bowlerExtras[state.bowler] = (state.bowlerExtras[state.bowler] || 0) + extras;
  if (bowlerWicket) state.bowlerWickets[state.bowler] = (state.bowlerWickets[state.bowler] || 0) + 1;
  if (event.fielder && state.fielding[event.fielder]) {
    if (event.dismissal === "Catch") state.fielding[event.fielder].catches += 1;
    if (event.dismissal === "Run Out") state.fielding[event.fielder].runouts += 1;
    if (event.dismissal === "Stumped") state.fielding[event.fielder].stumpings += 1;
  }
  if (event.dropFielder && state.fielding[event.dropFielder]) state.fielding[event.dropFielder].drops += 1;
  const ballLabel = `${beforeOver}.${beforeBall + 1}${finalOverRebowl ? "*" : ""}`;
  state.currentOver.push({ label: event.chip, kind: event.kind });
  state.history.push({ ballLabel, summary: event.summary, striker: batter, bowler: state.bowler, ...event });

  if (advancesBall) state.legalBalls += 1;
  const overEnded = advancesBall && state.legalBalls % 6 === 0;
  if (overEnded) {
    if (state.bowler) state.bowlerOvers[state.bowler] = (state.bowlerOvers[state.bowler] || 0) + 1;
    state.bowler = null;
    state.currentOver = [];
    state.overRuns = 0;
    if (state.legalBalls < 96 && state.legalBalls % 24 === 0) {
      state.pairIndex += 1;
      state.strikerIndex = 0;
      state.awaitingPair = true;
      pairSelection = [];
      showToast(`Choose pair ${state.pairIndex + 1}`);
    } else if (state.legalBalls < 96) {
      showToast("Over complete · choose the next bowler");
    } else {
      showToast("Innings complete · 96 balls recorded");
      setTimeout(showInningsComplete, 250);
    }
    if (state.legalBalls < 96) setTimeout(() => openSheet(state.awaitingPair ? "pairSheet" : "bowlerSheet"), 250);
  } else if (finalOverRebowl) {
    showToast("Extra saved · ball will be rebowled");
  }
  closeSheet();
  render();
}

function quickScore(code) {
  const runs = Number(code);
  commitEvent({ batterRuns: runs, chip: code, kind: "run", summary: runs === 0 ? "Dot ball" : `${runs} run${runs === 1 ? "" : "s"}` });
}

function codedScore(code) {
  const runs = codeValues[code];
  commitEvent({ batterRuns: runs, chip: code, kind: "run", summary: `${code} · ${runs} batter runs` });
}

function chooseBowler(name) {
  if (!canChangeMatch()) return;
  if (state.legalBalls >= 96) { showInningsComplete(); return; }
  if (state.legalBalls % 6 && state.bowler && state.bowler !== name) { showToast("Use History → Edit to correct a wrong bowler entry."); return; }
  const completed = state.bowlerOvers[name] || 0;
  if (completed >= 2 && state.bowler !== name) {
    showToast(`${name} has completed two overs`);
    return;
  }
  audit("bowler", state.bowler, name);
  state.bowler = name;
  closeSheet();
  render();
}

function undo() {
  if (!canChangeMatch()) return;
  if (!undoStack.length) return;
  const before = clone(state);
  state = undoStack.pop();
  audit("undo", before, state, "Undo latest action");
  closeSheet();
  render();
  showToast("Last action undone");
}

function swapStrike() {
  if (!canChangeMatch() || state.awaitingPair) return;
  saveSnapshot();
  audit("strike", state.strikerIndex, 1 - state.strikerIndex);
  state.strikerIndex = 1 - state.strikerIndex;
  render();
  showToast(`${playerLabel(strikerName())} is now on strike`);
}

function refreshWicketSheet() {
  const pair = currentPair();
  $("penalizedChoices").innerHTML = pair.map((name, index) => `<button type="button" class="choice ${selections.penalized === index ? "active" : ""}" data-penalized="${index}">${escapeHTML(playerLabel(name))}</button>`).join("");
  document.querySelectorAll("[data-penalized]").forEach((button) => button.addEventListener("click", () => {
    selections.penalized = Number(button.dataset.penalized); refreshWicketSheet();
  }));
  $("nextStrikerNote").textContent = "Choose who faces next by tapping their batter card after saving. Strike never changes automatically.";
  $("fielderSection").hidden = ["Bowled", "Out-Other"].includes(selections.dismissal);
  $("penalizedSection").hidden = selections.dismissal !== "Run Out";
}

function renderPairPicker() {
  const alreadyBatted = new Set(state.battingPairs.slice(0, state.pairIndex).flat());
  const eligible = batters.filter((name) => !alreadyBatted.has(name));
  $("pairChoices").innerHTML = eligible.map((name) => {
    const selectedAt = pairSelection.indexOf(name);
    return `<button type="button" class="roster-option ${selectedAt >= 0 ? "selected" : ""}" data-pair-player="${escapeHTML(name)}">
      <span><strong>${escapeHTML(playerLabel(name))}</strong><small>${selectedAt === 0 ? "Will start on strike" : selectedAt === 1 ? "Non-striker" : "Available"}</small></span>
      <b>${selectedAt >= 0 ? selectedAt + 1 : "+"}</b>
    </button>`;
  }).join("");
  $("pairSelectionStatus").textContent = pairSelection.length === 0
    ? "Select the striker first, then the non-striker."
    : pairSelection.length === 1
      ? `${playerLabel(pairSelection[0])} will start on strike. Choose their partner.`
      : `${playerLabel(pairSelection[0])} on strike · ${playerLabel(pairSelection[1])} non-striker`;
  $("savePair").disabled = pairSelection.length !== 2;
}

function openSheet(id) {
  closeSheet(false);
  openSheetId = id;
  $("scrim").hidden = false;
  const sheet = $(id);
  sheet.classList.add("open");
  sheet.setAttribute("aria-hidden", "false");
  if (id === "wicketSheet") {
    selections.penalized = state.strikerIndex;
    refreshWicketSheet();
  }
  if (id === "pairSheet") renderPairPicker();
}

function closeSheet(hideScrim = true) {
  if (openSheetId) {
    const sheet = $(openSheetId);
    sheet.classList.remove("open");
    sheet.setAttribute("aria-hidden", "true");
    openSheetId = null;
  }
  if (hideScrim) $("scrim").hidden = true;
}

function activateChoice(containerId, key, parser = (value) => value) {
  $(containerId).addEventListener("click", (event) => {
    const button = event.target.closest("[data-value]");
    if (!button) return;
    selections[key] = parser(button.dataset.value);
    $(containerId).querySelectorAll(".choice").forEach((item) => item.classList.toggle("active", item === button));
    if (key === "dismissal") refreshWicketSheet();
    if (key === "extraType") updateExtraForm();
  });
}

function showInningsComplete() {
  const battingTeam = teamForKey(battingKey());
  $("completedScore").textContent = formatSigned(state.total);
  $("completedTeam").textContent = battingTeam.name;
  $("nextInnings").hidden = inningsNumber !== 1;
  $("finishMatch").hidden = inningsNumber !== 2;
  if (inningsNumber === 1) {
    $("inningsCompleteTitle").textContent = "First innings complete";
    $("inningsCompleteNote").textContent = `${teamForKey(bowlingKey()).name} needs ${state.total + 1} to win.`;
  } else {
    const first = completedInnings[0];
    const firstTeam = teamForKey(matchConfig.battingFirst);
    const secondTeam = battingTeam;
    $("inningsCompleteTitle").textContent = state.total === first.total ? "Match tied" : `${state.total > first.total ? secondTeam.name : firstTeam.name} won`;
    $("inningsCompleteNote").textContent = state.total === first.total
      ? `Both teams scored ${state.total}.`
      : `${firstTeam.name} ${first.total} · ${secondTeam.name} ${state.total}`;
  }
  openSheet("inningsSheet");
}

function startSecondInnings() {
  if (!canChangeMatch()) return;
  if (inningsNumber !== 1 || state.legalBalls !== 96) return;
  audit("innings", 1, 2);
  completedInnings = [clone(state)];
  inningsNumber = 2;
  activateTeams();
  state = freshInnings();
  undoStack = [];
  pairSelection = [];
  closeSheet();
  populateStaticControls();
  render();
  setTimeout(() => openSheet("pairSheet"), 200);
}

function downloadMatch() {
  const payload = { version: 2, matchId, revision, recovery: recoverySnapshot(), exportedAt: new Date().toISOString(), match: matchConfig, innings: [...completedInnings, state] };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${matchConfig.date}_${matchConfig.matchName.replace(/[^a-z0-9]+/gi, "_")}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("Match data downloaded");
}

async function resetMatch() {
  if (!canChangeMatch(true)) return;
  if (!window.confirm("Start another match? This match will stay in Saved matches on this device.")) return;
  ready = false;
  try {
    await store.select(null);
    state = null;
    matchConfig = null;
    matchId = null;
    revision = 0;
    generation = 0;
    inningsNumber = 1;
    completedInnings = [];
    undoStack = [];
    actionLog = []; matchStatus = "playing"; finalizedRevision = null;
    closeSheet();
    $("liveView").hidden = true;
    $("setupView").hidden = false;
    await renderSavedMatches();
  } catch { showToast("Could not start a new match. Your current match has been kept."); }
  finally { ready = true; }
}

async function renderSavedMatches() {
  const records = await store.list();
  $("savedMatches").replaceChildren();
  records.sort((a, b) => b.savedAt.localeCompare(a.savedAt)).forEach((record) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "scenario-card";
    button.textContent = `${record.snapshot.matchConfig.date} · ${record.snapshot.matchConfig.matchName} · innings ${record.snapshot.inningsNumber} · ${record.snapshot.state.total} runs`;
    button.addEventListener("click", () => resumeMatch(record.id));
    $("savedMatches").append(button);
  });
  $("savedMatchesEmpty").hidden = records.length > 0;
}

function restoreRecord(record) {
  validateRecovery(record.snapshot);
  ({ matchConfig, state, inningsNumber, completedInnings, undoStack } = clone(record.snapshot));
  actionLog = clone(record.snapshot.actionLog || []);
  matchStatus = record.snapshot.matchStatus || "playing";
  finalizedRevision = record.finalizedRevision || null;
  matchId = record.id;
  revision = record.revision;
  generation = record.generation || 0;
  if (record.conflicted) cloudConflicts.add(record.id);
  else cloudConflicts.delete(record.id);
  pairSelection = [];
  activateTeams();
  $("setupView").hidden = true;
  $("liveView").hidden = false;
  populateStaticControls();
  render(false);
  $("syncText").textContent = "Saved on device";
  $("syncButton").setAttribute("aria-label", "Saved on this device, not yet in the cloud. Click to save again.");
  $("saveWarning").hidden = true;
  if (state.legalBalls >= 96) setTimeout(showInningsComplete, 200);
  else if (state.awaitingPair) setTimeout(() => openSheet("pairSheet"), 200);
  else if (!state.bowler) setTimeout(() => openSheet("bowlerSheet"), 200);
}

async function resumeMatch(id) {
  if (!canChangeMatch(true)) return;
  ready = false;
  try {
    const record = await store.get(id);
    validateRecovery(record.snapshot);
    await store.select(id);
    closeSheet();
    restoreRecord(record);
    showToast("Saved match restored on this device");
  } catch { recoveryError(); }
  finally { ready = true; }
}

function renderSetupInputs() {
  $("matchDate").value = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year:"numeric",month:"2-digit",day:"2-digit" }).format(new Date());
}

async function startMatch(event) {
  event.preventDefault();
  if (!canChangeMatch()) return;
  let teams;
  try { teams = selectedTeams(); } catch (error) { showToast(error.message); return; }
  const teamAPlayers = teams.teamA, teamBPlayers = teams.teamB;
  const allPlayers = [...teamAPlayers, ...teamBPlayers];
  const matchNumber = Number($("matchNumber").value);
  if (!Number.isInteger(matchNumber) || matchNumber < 1 || matchNumber > 99) { showToast("Choose a match number from 1 to 99"); return; }
  if (!teamAPlayers.includes($("teamACaptain").value) || !teamBPlayers.includes($("teamBCaptain").value)) { showToast("Choose each team's captain"); return; }
  const previous = await store.list();
  if (!canChangeMatch()) return;
  if (previous.some(record => record.snapshot.matchConfig.date === $("matchDate").value && record.snapshot.matchConfig.matchNumber === matchNumber) &&
      !window.confirm("A match with this date and number is already saved. Create another separate match?")) return;
  if (!$("matchName").value.trim() || $("matchName").value.trim().length > 200 ||
      [$("teamAName").value.trim(), $("teamBName").value.trim()].some((name) => !name || name.length > 100)) {
    showToast("Enter a match name (up to 200 characters) and team names (up to 100)"); return;
  }
  matchConfig = {
    schemaVersion: 2, matchNumber, playerNames: playerNames(allPlayers),
    date: $("matchDate").value,
    matchName: $("matchName").value.trim(),
    battingFirst: $("battingFirst").value,
    teamA: { name: $("teamAName").value.trim(), players: teamAPlayers, captain: $("teamACaptain").value },
    teamB: { name: $("teamBName").value.trim(), players: teamBPlayers, captain: $("teamBCaptain").value },
  };
  inningsNumber = 1;
  completedInnings = [];
  undoStack = [];
  actionLog = []; matchStatus = "playing"; finalizedRevision = null;
  audit("create", null, matchConfig);
  pairSelection = [];
  activateTeams();
  state = freshInnings();
  $("setupView").hidden = true;
  $("liveView").hidden = false;
  populateStaticControls();
  render();
  setTimeout(() => openSheet("pairSheet"), 200);
}

async function cloudRequest(path, options = {}) {
  const response = await fetch(`/api/matches${path}`, {
    ...options, credentials: "same-origin", redirect: "error",
    headers: { "Content-Type": "application/json", "X-Scoring-Device": deviceId },
  });
  if (!response.ok) {
    const error = new Error(response.status === 409 ? "Cloud conflict · device copy kept" :
      [401, 403].includes(response.status) ? "Sign in again to sync" : "Cloud pending · retry when connected");
    try { error.message = (await response.json()).error || error.message; } catch {}
    error.status = response.status;
    throw error;
  }
  if (!(response.headers.get("Content-Type") || "").includes("application/json")) throw new Error("Sign in again to sync");
  return response.json();
}

function syncCloud() {
  if (!store || !deviceId || typeof fetch !== "function") return Promise.resolve();
  if (syncing) { syncAgain = true; return syncing; }
  syncing = (async () => {
    if (!(await syncPlayers())) { $("cloudStatus").textContent = "Cloud pending · player list will sync when connected"; return; }
    const records = await store.list();
    let failed = false;
    for (const record of records.filter((record) => !record.localOnly && !record.conflicted && record.syncedRevision < record.revision)) {
      try {
        $("cloudStatus").textContent = "Saving to cloud…";
        const ack = await cloudRequest(`/${record.id}`, { method: "PUT", body: JSON.stringify({
          revision: record.revision, generation: record.generation, snapshot: record.snapshot,
        }) });
        if (ack.id !== record.id || ack.revision !== record.revision || ack.generation !== record.generation) throw new Error("Cloud acknowledgement mismatch");
        await store.acknowledge(record.id, ack.revision, ack.generation, ack.finalizedRevision);
        if (matchId === record.id) finalizedRevision = ack.finalizedRevision || null;
      } catch (error) {
        failed = true;
        if (error.status === 409) {
          await store.markConflict(record.id, record.generation);
          if ((await store.get(record.id))?.conflicted) cloudConflicts.add(record.id);
        }
        $("cloudStatus").textContent = error.status === 409 ? "Cloud conflict · device copy kept. Open Cloud matches." :
          error.status === 400 ? `Cloud not saved: ${error.message}` : "Cloud pending · reconnect or sign in, then tap Sync now";
        if (![400, 409].includes(error.status)) break;
      }
    }
    if (!failed) {
      const remaining = (await store.list()).some((record) => !record.localOnly && record.syncedRevision < record.revision);
      const current = matchId ? await store.get(matchId) : null;
      $("cloudStatus").textContent = current?.localOnly ? "Device recovery copy · not uploaded" : (saving || saveFailed) ? "Latest change pending · cloud has the previous checkpoint" : remaining ? "Saved on device · cloud save pending" : records.length ? "Cloud saved" : "Cloud ready after your first match";
    }
  })().catch(() => { $("cloudStatus").textContent = "Cloud pending · device storage unavailable"; })
    .finally(() => { syncing = null; if (syncAgain) { syncAgain = false; syncCloud(); } });
  return syncing;
}

async function showCloudMatches() {
  if (!canChangeMatch(true)) return;
  openSheet("cloudMatchesSheet");
  $("cloudMatches").textContent = "Loading cloud matches…";
  try {
    const { matches } = await cloudRequest("");
    $("cloudMatches").replaceChildren();
    if (!matches.length) $("cloudMatches").textContent = "No cloud matches yet.";
    for (const match of matches) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "scenario-card";
      button.textContent = `${match.date} · ${match.name} · innings ${match.innings} · ${match.total} runs · ${match.owned_here ? "Resume" : "Take over"}`;
      button.addEventListener("click", () => openCloudMatch(match.id));
      $("cloudMatches").append(button);
    }
  } catch { $("cloudMatches").textContent = "Cloud unavailable. Connect to the internet and sign in again if your session has expired. Your device matches are still available."; }
}

async function openCloudMatch(id) {
  if (!canChangeMatch(true)) return;
  ready = false;
  try {
    // Drain this tab's upload first, so its acknowledgement cannot race a handover.
    await syncing;
    const local = await store.get(id);
    const preserveLocal = !!local && local.syncedRevision !== local.revision;
    if (preserveLocal && !window.confirm("This device has unsynced changes. Keep them as a separate device recovery copy and open the cloud version? Those pending changes will not be merged into the cloud match.")) return;
    let record = await cloudRequest(`/${id}`);
    validateRecovery(record.snapshot);
    if (!record.ownedHere) {
      if (!window.confirm(`Take over this match from its cloud save at ${new Date(record.savedAt).toLocaleString()}? First check the old phone says Cloud saved. Any unsynced deliveries on that phone are NOT included. The old phone will no longer be able to upload this match.`)) return;
      record = await cloudRequest(`/${id}/takeover`, { method: "POST", body: JSON.stringify({ generation: record.generation, revision: record.revision }) });
    }
    await store.restoreCloud(record, local?.revision || 0, preserveLocal);
    closeSheet();
    restoreRecord(record);
    $("cloudStatus").textContent = "Cloud saved";
    showToast("Cloud match ready on this device");
  } catch (error) { showToast(error.status === 409 ? "The cloud copy changed. Refresh Cloud matches and retry." : "Could not open cloud match. All device copies have been kept."); }
  finally { ready = true; }
}

function recoveryError() {
  saveFailed = true;
  $("setupView").hidden = true;
  $("liveView").hidden = true;
  $("saveWarning").textContent = "The saved match could not be opened. Its stored data has been kept. Do not clear this site's data; contact the app owner to recover it.";
  $("saveWarning").hidden = false;
}

async function bootstrap() {
  $("setupView").hidden = true;
  renderSetupInputs();
  try {
    store = await CricketStore.open();
    deviceId = await store.device();
    await initializePlayers({ store, notify: showToast, onChange: updateCaptains });
    let activeId = await store.active();
    // A missing marker means first migration; null means the user chose a new match.
    if (activeId === undefined) {
      const legacy = localStorage.getItem(STORAGE_KEY);
      if (legacy) {
        const saved = JSON.parse(legacy);
        validateRecovery(saved);
        activeId = crypto.randomUUID();
        await store.save(activeId, 0, saved);
        // Keep the old bytes untouched as a migration fallback.
      } else await store.select(null);
    }
    if (activeId) {
      const record = await store.get(activeId);
      restoreRecord(record);
      showToast("Saved match restored on this device");
    } else $("setupView").hidden = false;
    await renderSavedMatches();
    ready = true;
    syncCloud();
  } catch { recoveryError(); }
}

async function importRecovery(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file || !canChangeMatch(true)) return;
  ready = false;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error("Recovery file is too large");
    const payload = JSON.parse(await file.text());
    if (payload.version !== 2) throw new Error("Choose a recovery file exported by this beta version");
    validateRecovery(payload.recovery);
    if (payload.matchId && await store.get(payload.matchId)) {
      throw new Error("This match already exists. Use Saved matches to resume it; use cloud handover for another phone.");
    }
    // Recovery branches must be reviewed explicitly before they can become cloud results.
    const record = await store.save(crypto.randomUUID(), 0, payload.recovery, 0, true);
    closeSheet();
    restoreRecord(record);
    showToast("Recovery copy restored on this device");
  } catch (error) { showToast(error.message || "Could not restore this file. Existing saved matches have been kept."); }
  finally { ready = true; }
}

async function prepareOffline() {
  if (!("serviceWorker" in navigator)) {
    $("offlineStatus").textContent = "Offline reopening is unavailable in this browser. Keep this tab open while scoring.";
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register("./sw.js");
    const installing = registration.installing;
    if (!registration.active && installing) await new Promise((resolve, reject) => {
      const changed = () => {
        if (["installed", "activated"].includes(installing.state)) resolve();
        if (installing.state === "redundant") reject(new Error("Offline installation failed"));
      };
      installing.addEventListener("statechange", changed);
      changed();
    });
    await navigator.serviceWorker.ready;
    const cache = await caches.open("cricket-sg-shell-v9");
    const installed = await cache.match(new URL("./index.html", location.href).href);
    $("offlineStatus").textContent = installed ? "Ready to reopen offline on this device" : "Open online once to prepare offline recovery";
    if (registration.waiting) $("offlineStatus").textContent += " · Update ready after all scorer tabs close";
  } catch { $("offlineStatus").textContent = "Offline reopening is not ready. Keep this tab open while scoring."; }
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 1800);
}

function formatSigned(value) { return value < 0 ? `−${Math.abs(value)}` : String(value); }

function populateStaticControls() {
  $("codeGrid").innerHTML = secondaryCodes.map((code) => `<button type="button" data-score-code="${code}">${code}</button>`).join("");
  const options = `<option value="">Select from fielding team</option>${fielders.map((name) => `<option value="${escapeHTML(name)}">${escapeHTML(playerLabel(name))}</option>`).join("")}`;
  $("fielderSelect").innerHTML = options;
  $("dropFielderSelect").innerHTML = options;
}

document.querySelectorAll("[data-code]").forEach((button) => button.addEventListener("click", () => quickScore(button.dataset.code)));
document.addEventListener("click", (event) => {
  const delivery = event.target.closest("[data-edit-delivery]");
  if (delivery) correctDelivery(Number(delivery.dataset.editInnings), delivery.dataset.editDelivery);
  const coded = event.target.closest("[data-score-code]");
  if (coded) codedScore(coded.dataset.scoreCode);
  if (event.target.closest("[data-close]")) closeSheet();
  const pairPlayer = event.target.closest("[data-pair-player]");
  if (pairPlayer) {
    const name = pairPlayer.dataset.pairPlayer;
    const selectedAt = pairSelection.indexOf(name);
    if (selectedAt >= 0) pairSelection.splice(selectedAt, 1);
    else if (pairSelection.length < 2) pairSelection.push(name);
    else showToast("Two batters are already selected");
    renderPairPicker();
  }
});

$("moreButton").addEventListener("click", () => openSheet("moreSheet"));
$("extraButton").addEventListener("click", () => openSheet("extraSheet"));
$("wicketButton").addEventListener("click", () => openSheet("wicketSheet"));
$("droppedButton").addEventListener("click", () => openSheet("droppedSheet"));
$("bowlerButton").addEventListener("click", () => openSheet("bowlerSheet"));
$("historyButton").addEventListener("click", () => { $("historyInnings").value = String(inningsNumber); renderHistory(); openSheet("historySheet"); });
$("scenarioButton").addEventListener("click", () => openSheet("scenarioSheet"));
$("undoButton").addEventListener("click", undo);
$("syncButton").addEventListener("click", () => { if (ready) persist(); });
$("swapButton").addEventListener("click", swapStrike);
$("nonStrikerCard").addEventListener("click", swapStrike);
$("strikerCard").addEventListener("click", () => { if (state && !state.awaitingPair) showToast(`${playerLabel(strikerName())} is already selected to face`); });
$("scrim").addEventListener("click", () => closeSheet());

$("savePair").addEventListener("click", () => {
  if (!canChangeMatch()) return;
  if (pairSelection.length !== 2) { showToast("Select two batters"); return; }
  audit("pair", state.battingPairs[state.pairIndex] || null, pairSelection);
  state.battingPairs[state.pairIndex] = [...pairSelection];
  state.strikerIndex = 0;
  state.awaitingPair = false;
  pairSelection.forEach((name) => { state.playerRuns[name] ??= 0; });
  closeSheet();
  render();
  showToast(`${playerLabel(pairSelection[0])} and ${playerLabel(pairSelection[1])} are pair ${state.pairIndex + 1}`);
  setTimeout(() => openSheet("bowlerSheet"), 250);
});

activateChoice("extraTypeChoices", "extraType");
activateChoice("extraRunChoices", "extraRuns", Number);
activateChoice("extraBatterChoices", "extraBatter", Number);
activateChoice("dismissalChoices", "dismissal");
activateChoice("wicketRunChoices", "wicketRuns", Number);
activateChoice("dropTypeChoices", "dropType");
activateChoice("dropRunChoices", "dropRuns", Number);

$("saveExtra").addEventListener("click", () => commitEvent({
  batterRuns: selections.extraType === "Leg bye" ? 0 : selections.extraBatter,
  extras: selections.extraRuns,
  extraType: selections.extraType,
  strikeRuns: selections.extraType === "Leg bye" ? selections.extraRuns : selections.extraBatter,
  chip: selections.extraType === "Wide" ? `Wd${selections.extraRuns}` : selections.extraType === "No ball" ? `Nb${selections.extraRuns}` : `Lb${selections.extraRuns}`,
  kind: "extra",
  summary: `${selections.extraType} +${selections.extraRuns}${selections.extraBatter ? ` · ${selections.extraBatter} batter runs` : ""}`,
}));

$("saveWicket").addEventListener("click", () => {
  const fielder = ["Bowled", "Out-Other"].includes(selections.dismissal) ? "" : $("fielderSelect").value;
  const extraType = $("wicketExtraType").value;
  const extraRuns = extraType ? Number($("wicketExtraRuns").value) : 0;
  if (!["Bowled", "Out-Other"].includes(selections.dismissal) && !fielder) { showToast("Select a fielder"); return; }
  if (extraType && extraRuns < 1) { showToast("Choose the number of extra runs"); return; }
  commitEvent({
    batterRuns: selections.wicketRuns,
    extras: extraRuns,
    extraType,
    dismissal: selections.dismissal,
    fielder,
    penalizedIndex: selections.dismissal === "Run Out" ? selections.penalized : state.strikerIndex,
    chip: `W${selections.wicketRuns ? `+${selections.wicketRuns}` : ""}${extraRuns ? `+${extraType === "Wide" ? "Wd" : "Nb"}${extraRuns}` : ""}`,
    kind: "wicket",
    summary: `${selections.dismissal}${fielder ? ` · ${fielder}` : ""}${selections.wicketRuns ? ` · ${selections.wicketRuns} runs` : ""}${extraRuns ? ` · ${extraType} +${extraRuns}` : ""}`,
  });
});

$("saveDropped").addEventListener("click", () => {
  const fielder = $("dropFielderSelect").value;
  if (!fielder) { showToast("Select the fielder"); return; }
  commitEvent({ batterRuns: selections.dropRuns, dropFielder: fielder, chip: `D${selections.dropRuns}`, kind: "extra", summary: `${selections.dropType} · ${fielder} · ${selections.dropRuns} runs` });
});

$("setupForm").addEventListener("submit", startMatch);
$("nextInnings").addEventListener("click", startSecondInnings);
$("finishMatch").addEventListener("click", () => completeMatch(completedInnings[0]?.legalBalls < 96 ? "shortened" : "completed"));
$("exportMatch").addEventListener("click", downloadMatch);
$("newMatch").addEventListener("click", resetMatch);

$("syncCloudButton").addEventListener("click", syncCloud);
$("cloudMatchesButton").addEventListener("click", showCloudMatches);
$("setupCloudMatches").addEventListener("click", showCloudMatches);
window.addEventListener("online", syncCloud);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncCloud(); });
setInterval(syncCloud, 30000);
$("savedMatchesButton").addEventListener("click", async () => {
  if (!canChangeMatch(true)) return;
  try { await renderSavedMatches(); openSheet("savedMatchesSheet"); }
  catch { showToast("Could not open saved matches. Keep this page open."); }
});
$("setupSavedMatches").addEventListener("click", async () => {
  if (!canChangeMatch(true)) return;
  try { await renderSavedMatches(); openSheet("savedMatchesSheet"); }
  catch { showToast("Could not open saved matches."); }
});
$("importRecovery").addEventListener("change", importRecovery);
window.addEventListener("beforeunload", (event) => {
  if (saving || saveFailed) { event.preventDefault(); event.returnValue = ""; }
});
$("historyInnings").addEventListener("change", renderHistory);
$("playersButton").addEventListener("click", openPlayers);
$("matchPlayersButton").addEventListener("click", openPlayers);
$("shortenMatch").addEventListener("click", () => completeMatch("shortened"));
$("abandonMatch").addEventListener("click", () => completeMatch("abandoned"));
$("reopenMatch").addEventListener("click", () => completeMatch("playing"));
$("finalizeMatch").addEventListener("click", finalizeMatch);
$("copyLineup").addEventListener("click", async () => {
  const previous = (await store.list()).filter(record => record.snapshot.matchConfig.schemaVersion === 2).sort((a,b) => b.savedAt.localeCompare(a.savedAt))[0];
  if (!previous) { showToast("No previous player-pool lineup on this device yet"); return; }
  if (!window.confirm("Copy the most recently saved lineup? Check every player and captain before starting.")) return;
  const config = previous.snapshot.matchConfig;
  renderTeamPickers(config.teamA.players, config.teamB.players);
  $("teamAName").value = config.teamA.name; $("teamBName").value = config.teamB.name;
  updateCaptains();
  $("teamACaptain").value = config.teamA.captain; $("teamBCaptain").value = config.teamB.captain;
});

function updateCaptains() {
  for (const key of ["teamA", "teamB"]) {
    const select = $(key + "Captain"), previous = select.value;
    const ids = [...$(key + "Roster").querySelectorAll("select")].map(input => input.value).filter(Boolean);
    const names = playerNames(ids);
    select.innerHTML = '<option value="">Choose captain</option>' + ids.map(id => `<option value="${escapeHTML(id)}">${escapeHTML(names[id] || id)}</option>`).join("");
    if (ids.includes(previous)) select.value = previous;
  }
}

async function completeMatch(status) {
  if (!canChangeMatch()) return;
  if (status === "completed" && (inningsNumber !== 2 || state.legalBalls !== 96)) { showToast("Use shortened or abandoned for an unfinished match."); return; }
  if (!window.confirm(status === "playing" ? "Reopen this match for scoring? Its next result will be a new revision." : `Mark this match ${status}? Recorded performances will be retained for statistics.`)) return;
  audit("status", matchStatus, status, `Match ${status}`);
  matchStatus = status; undoStack = []; closeSheet(); render();
}

async function finalizeMatch() {
  if (!canChangeMatch()) return;
  if (matchStatus === "playing") { showToast("Complete the match first, or mark it shortened or abandoned."); return; }
  const target = { id:matchId, revision, generation };
  ready = false;
  try {
    await syncCloud();
    const record = await store.get(target.id);
    if (record.localOnly || record.conflicted || record.syncedRevision !== target.revision || record.revision !== target.revision) throw new Error("Save this match to the cloud before finalizing. Recovery copies need review.");
    const result = await cloudRequest(`/${target.id}/finalize`, { method:"POST", body:JSON.stringify({generation:target.generation,revision:target.revision}) });
    finalizedRevision = result.finalizedRevision;
    await store.acknowledge(target.id,target.revision,target.generation,finalizedRevision);
    $("matchStatusText").textContent = `${matchStatus} · cloud finalized revision ${result.finalizedRevision}`;
    showToast("Cloud result verified. Statistics integration is still pending.");
  } catch (error) { showToast(error.message); }
  finally { ready = true; }
}

const boot = bootstrap();
prepareOffline();
