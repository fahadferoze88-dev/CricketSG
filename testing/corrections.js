import { recalculateInnings } from "./scoring.mjs";

const copy = (value) => JSON.parse(JSON.stringify(value));
const overs = (balls) => `${Math.floor(balls / 6)}.${balls % 6}`;
const selection = (innings) => Object.fromEntries(["strikerIndex", "pairIndex", "bowler", "awaitingPair"].map((key) => [key, innings[key]]));
function auditChanges(before, after) {
  const previous = new Map(before.history.map((event) => [event.id, event]));
  const next = new Map(after.history.map((event) => [event.id, event]));
  const changed = (event, other) => JSON.stringify(event) !== JSON.stringify(other.get(event.id));
  const result = {
    before: { deliveries: before.history.filter((event) => changed(event, next)) },
    after: { deliveries: after.history.filter((event) => changed(event, previous)) },
  };
  if (JSON.stringify(before.battingPairs) !== JSON.stringify(after.battingPairs)) {
    result.before.battingPairs = before.battingPairs;
    result.after.battingPairs = after.battingPairs;
  }
  if (JSON.stringify(selection(before)) !== JSON.stringify(selection(after))) {
    result.before.current = selection(before);
    result.after.current = selection(after);
  }
  return result;
}

// No live state is changed here. Only the reviewed candidate reaches onSave.
export function openCorrection({ innings, batters, fielders, label, onSave }, deliveryId = null) {
  const original = copy(innings);
  const playerLabel = typeof label === "function" ? label : (player) => player;
  const playerIds = [...batters, ...fielders].sort((a, b) => b.length - a.length);
  const playerPattern = new RegExp(playerIds.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  // Summaries and validation messages can contain stored player IDs too, not only option labels.
  const displayText = (text) => String(text).replace(playerPattern, (id) => playerLabel(id) ?? id);
  const dialog = document.createElement("dialog");
  dialog.style.cssText = "width:min(94vw,580px);max-height:90dvh;overflow:auto;border:1px solid #526576;border-radius:16px;padding:20px;background:#fff;color:#152d3b;";
  const node = (tag, text, parent = dialog) => {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = displayText(text);
    parent.append(item);
    return item;
  };
  const title = node("h2", typeof label === "string" && label ? `Correct ${label}` : "Correct delivery");
  title.id = `correction-${crypto.randomUUID()}`;
  dialog.setAttribute("aria-labelledby", title.id);
  const button = (text, fn, parent = dialog) => {
    const item = node("button", text, parent);
    item.type = "button";
    item.style.cssText = "min-height:44px;margin:8px 8px 8px 0;padding:8px 14px;";
    item.addEventListener("click", fn);
    return item;
  };
  const close = () => { dialog.close(); dialog.remove(); };
  const cancel = button("Cancel", close);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  try {
    recalculateInnings(original, batters, fielders);
  } catch (error) {
    node("p", error.message);
    dialog.showModal();
    return dialog;
  }
  if (!original.history.length) {
    node("p", "There are no deliveries to correct yet.");
    dialog.showModal();
    return dialog;
  }
  const form = node("form");
  form.addEventListener("submit", (event) => event.preventDefault());
  const field = (name, type = "select", parent = form) => {
    const wrap = node("label", name, parent);
    wrap.style.cssText = "display:block;margin:12px 0;font-weight:600;";
    const input = node(type === "select" ? "select" : "input", undefined, wrap);
    if (type !== "select") input.type = type;
    input.style.cssText = "display:block;width:100%;min-height:44px;margin-top:4px;padding:8px;color:#152d3b;background:#fff;border:1px solid #a4b3be;border-radius:6px;";
    if (type === "number") { input.min = "0"; input.max = "100"; input.step = "1"; input.required = true; }
    return input;
  };
  const options = (input, values, value) => {
    input.replaceChildren();
    for (const entry of values) {
      const [id, text] = Array.isArray(entry) ? entry : [entry, entry];
      const option = node("option", text, input);
      option.value = id;
    }
    if (value !== undefined) input.value = value;
  };
  const delivery = field("Delivery");
  options(delivery, original.history.map((event) => [event.id, `${event.ballLabel} · ${event.summary} · ${event.striker}`]), deliveryId || original.history.at(-1).id);
  if (!original.history.some((event) => event.id === delivery.value)) delivery.value = original.history.at(-1).id;
  const mode = field("What needs correcting?");
  options(mode, [["replace", "Correct this delivery"], ["insert", "Insert a missed delivery before this one"], ["remove", "Remove a mistaken duplicate entry"]]);
  node("p", "Later batters and current strike stay as recorded. Enter 0 for a real dot ball; remove only an entry that did not happen.", form);
  const editFields = node("fieldset", undefined, form);
  node("legend", "Delivery details", editFields);
  const runs = field("Batter runs", "number", editFields);
  const advanced = node("details", undefined, editFields);
  node("summary", "Extras, wickets, players or bowler", advanced);
  const boundary = field("Run type", "select", advanced);
  options(boundary, [["", "Ordinary runs"], ["F", "Boundary code F"], ["S", "Boundary code S"]]);
  const extraType = field("Extra type", "select", advanced);
  options(extraType, [["", "No extra"], "Wide", "No ball", "Leg bye"]);
  const extras = field("Extra runs", "number", advanced);
  const striker = field("Batter who faced this delivery", "select", advanced);
  const dismissal = field("Dismissal", "select", advanced);
  options(dismissal, [["", "No wicket"], "Bowled", "Catch", "Run Out", "Stumped", "Out-Other"]);
  const penalized = field("Dismissed player (for runout)", "select", advanced);
  const fielder = field("Fielder for catch, runout or stumping", "select", advanced);
  options(fielder, [["", "None"], ...fielders]);
  const dropped = field("Dropped chance fielder", "select", advanced);
  options(dropped, [["", "None"], ...fielders]);
  const bowler = field("Bowler", "select", advanced);
  options(bowler, fielders);
  const bowlerScope = field("Apply this bowler to", "select", advanced);
  options(bowlerScope, [["delivery", "This delivery only"], ["over", "Every recorded delivery in this over"]]);
  const pairDetails = node("details", undefined, advanced);
  node("summary", "Wrong player selected in the batting pair", pairDetails);
  node("p", "Corrects the identity on every delivery for this pair. Choose an unused member of this match's batting team.", pairDetails);
  const wrongPlayer = field("Recorded player to replace", "select", pairDetails);
  const rightPlayer = field("Actual player from this team's eight", "select", pairDetails);
  const boundaryDetails = node("details", undefined, form);
  node("summary", "Changed delivery count or boundaries", boundaryDetails);
  const boundaryReview = field("Review changed over/pair boundaries", "checkbox", boundaryDetails);
  boundaryReview.style.width = "24px";
  node("p", "Needed when inserting/removing an entry moves later deliveries. The review preserves recorded players, validates pairs and bowling limits, and shows every changed delivery number.", boundaryDetails);
  const reason = field("Reason for correction", "text");
  reason.placeholder = "For example: entered 1 instead of 2";
  reason.value = "Scoring entry correction";
  reason.required = true;
  reason.maxLength = 240;
  const errorText = node("p", "", form);
  errorText.setAttribute("role", "alert");
  errorText.style.color = "#a02a20";
  const preview = node("section", undefined, form);
  preview.setAttribute("aria-live", "polite");
  let candidate = null;
  let audit = null;
  let confirm;
  let saving = false;
  dialog.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });
  const invalidate = () => {
    candidate = null;
    audit = null;
    preview.replaceChildren();
    errorText.textContent = "";
    if (confirm) confirm.disabled = true;
  };
  const selected = () => original.history.find((event) => event.id === delivery.value);
  const load = () => {
    invalidate();
    const event = selected();
    const inserting = mode.value === "insert";
    boundaryDetails.open = mode.value !== "replace";
    editFields.disabled = mode.value === "remove";
    runs.value = String(inserting ? 0 : event.batterRuns || 0);
    boundary.value = !inserting && /^\d+[FS]$/.test(event.chip || "") ? event.chip.slice(-1) : "";
    extraType.value = inserting ? "" : event.extraType || "";
    extras.value = String(inserting ? 0 : event.extras || 0);
    const pair = original.battingPairs[event.pairIndex];
    options(striker, pair, event.striker);
    options(penalized, pair, event.penalizedPlayer || event.striker);
    dismissal.value = inserting ? "" : event.dismissal || "";
    fielder.value = inserting ? "" : event.fielder || "";
    dropped.value = inserting ? "" : event.dropFielder || "";
    bowler.value = event.bowler;
    bowlerScope.value = "delivery";
    options(wrongPlayer, [["", "No pair change"], ...pair], "");
    options(rightPlayer, [["", "Choose unused team member"], ...batters.filter((player) => !original.battingPairs.flat().includes(player))], "");
  };
  delivery.addEventListener("change", load);
  mode.addEventListener("change", load);
  form.addEventListener("input", invalidate);
  form.addEventListener("change", invalidate);
  button("Review correction", () => {
    if (saving) return;
    invalidate();
    try {
      if (!reason.value.trim()) throw new Error("Enter a short reason so other scorers can understand this change.");
      if (mode.value !== "remove" && !form.reportValidity()) return;
      const source = selected();
      const draft = copy(original);
      const index = draft.history.findIndex((event) => event.id === source.id);
      const pair = draft.battingPairs[source.pairIndex];
      const rename = (player) => wrongPlayer.value && player === wrongPlayer.value ? rightPlayer.value : player;
      if (mode.value !== "remove" && (wrongPlayer.value || rightPlayer.value)) {
        if (!wrongPlayer.value || !rightPlayer.value || !batters.includes(rightPlayer.value) || draft.battingPairs.flat().includes(rightPlayer.value)) throw new Error("Select the wrong pair member and an unused player from this team's eight.");
        pair[pair.indexOf(wrongPlayer.value)] = rightPlayer.value;
        for (const event of draft.history.filter((item) => item.pairIndex === source.pairIndex)) {
          event.striker = rename(event.striker);
          event.nonStriker = rename(event.nonStriker);
          if (event.penalizedPlayer) event.penalizedPlayer = rename(event.penalizedPlayer);
        }
      }
      if (mode.value === "remove") draft.history.splice(index, 1);
      else {
        const event = mode.value === "insert" ? { id: crypto.randomUUID(), pairIndex: source.pairIndex, overIndex: source.overIndex } : draft.history[index];
        Object.assign(event, {
          striker: rename(striker.value), bowler: bowler.value,
          batterRuns: Number(runs.value), extras: Number(extras.value), extraType: extraType.value,
          dismissal: dismissal.value, fielder: fielder.value, dropFielder: dropped.value,
          strikeRuns: extraType.value === "Leg bye" ? Number(extras.value) : Number(runs.value),
          chip: `${Number(runs.value)}${boundary.value}`,
        });
        event.nonStriker = pair.find((player) => player !== event.striker);
        event.penalizedPlayer = event.dismissal ? event.dismissal === "Run Out" ? rename(penalized.value) : event.striker : null;
        if (event.dismissal) event.penalizedIndex = pair.indexOf(event.penalizedPlayer);
        else delete event.penalizedIndex;
        if (mode.value === "insert") draft.history.splice(index, 0, event);
        if (bowlerScope.value === "over") {
          for (const item of draft.history.filter((item) => item.overIndex === source.overIndex)) item.bowler = bowler.value;
          if (source.overIndex === Math.floor(original.legalBalls / 6) && original.legalBalls % 6 !== 0) draft.bowler = bowler.value;
        }
      }
      candidate = recalculateInnings(draft, batters, fielders, { reflow: boundaryReview.checked });
      audit = { kind: mode.value, reason: reason.value.trim() };
      node("h3", "Review before saving", preview);
      node("p", `Score: ${original.total} → ${candidate.total}. Overs: ${overs(original.legalBalls)} → ${overs(candidate.legalBalls)}. Recorded deliveries: ${original.history.length} → ${candidate.history.length}.`, preview);
      const changes = node("ul", undefined, preview);
      const beforeById = new Map(original.history.map((event) => [event.id, event]));
      for (const event of candidate.history) {
        const before = beforeById.get(event.id);
        if (!before) node("li", `Inserted ${event.ballLabel}: ${event.summary} · ${event.striker} · bowler ${event.bowler}`, changes);
        else if (JSON.stringify(before) !== JSON.stringify(event)) node("li", `${before.ballLabel} → ${event.ballLabel}: ${before.summary} → ${event.summary}; batter ${before.striker} → ${event.striker}; bowler ${before.bowler} → ${event.bowler}; pair ${before.pairIndex + 1} → ${event.pairIndex + 1}`, changes);
      }
      for (const before of original.history) if (!candidate.history.some((event) => event.id === before.id)) node("li", `Removed ${before.ballLabel}: ${before.summary} · ${before.striker}`, changes);
      const figures = node("ul", undefined, preview);
      for (const player of batters) {
        if (original.playerRuns[player] !== candidate.playerRuns[player] || original.playerBalls[player] !== candidate.playerBalls[player]) node("li", `${player}: ${original.playerRuns[player]} runs / ${original.playerBalls[player]} balls → ${candidate.playerRuns[player]} runs / ${candidate.playerBalls[player]} balls`, figures);
      }
      for (const player of fielders) {
        if (["bowlerRuns", "bowlerBalls", "bowlerWickets", "bowlerExtras"].some((key) => original[key][player] !== candidate[key][player])) node("li", `${player} bowling: ${original.bowlerRuns[player]} runs / ${overs(original.bowlerBalls[player])} overs / ${original.bowlerWickets[player]} wickets → ${candidate.bowlerRuns[player]} runs / ${overs(candidate.bowlerBalls[player])} overs / ${candidate.bowlerWickets[player]} wickets; extras ${original.bowlerExtras[player]} → ${candidate.bowlerExtras[player]}`, figures);
      }
      if (candidate.pairIndex !== original.pairIndex && !candidate.awaitingPair) {
        const currentStrike = field("Confirm current striker after the boundary change", "select", preview);
        options(currentStrike, [["", "Choose current striker"], ...candidate.battingPairs[candidate.pairIndex]], "");
        currentStrike.addEventListener("change", (event) => {
          event.stopPropagation();
          candidate.strikerIndex = candidate.battingPairs[candidate.pairIndex].indexOf(currentStrike.value);
          confirm.disabled = candidate.strikerIndex < 0;
        });
        currentStrike.addEventListener("input", (event) => event.stopPropagation());
      } else node("p", candidate.awaitingPair ? "Choose the next batting pair after saving." : `Current striker stays ${candidate.battingPairs[candidate.pairIndex][candidate.strikerIndex]}.`, preview);
      if (!candidate.bowler && candidate.legalBalls < 96) node("p", "Choose the bowler before scoring the next delivery.", preview);
      else if (candidate.bowler !== original.bowler) node("p", `Current bowler: ${original.bowler || "not selected"} → ${candidate.bowler}. The next delivery will use this bowler.`, preview);
      confirm.disabled = candidate.pairIndex !== original.pairIndex && !candidate.awaitingPair;
    } catch (error) {
      candidate = null;
      if (/boundary|over or innings/.test(error.message)) boundaryDetails.open = true;
      errorText.textContent = displayText(`${error.message}${!boundaryReview.checked && /boundary|over or innings/.test(error.message) ? " Tick Review changed over/pair boundaries, then review again." : ""}`);
    }
  }, form);
  confirm = button("Confirm and save correction", async () => {
    if (!candidate || confirm.disabled || saving) return;
    saving = true;
    form.inert = true;
    cancel.disabled = true;
    confirm.disabled = true;
    try {
      const result = await onSave(copy(candidate), copy({ ...audit, ...auditChanges(original, candidate) }));
      if (result === false) throw new Error("The correction has not been saved. Keep this review open and retry.");
      close();
    } catch (error) {
      saving = false;
      form.inert = false;
      cancel.disabled = false;
      errorText.textContent = displayText(error.message);
      confirm.disabled = false;
    }
  }, form);
  confirm.disabled = true;
  load();
  dialog.showModal();
  return dialog;
}
