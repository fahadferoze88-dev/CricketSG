import { validateRecovery } from "../testing/recovery.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const reply = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const conflict = () => reply({ error: "Another device or scorer has a newer copy. Your device copy has been kept. Open Cloud matches to check the latest saved copy." }, 409);
const invalid = (message) => { throw new Error(message); };
const stable = (value) => JSON.stringify(value, function (key, item) {
  return item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]])) : item;
});
const same = (a, b) => stable(a) === stable(b);
const modern = (snapshot) => snapshot?.matchConfig?.schemaVersion === 2;

function validateSnapshot(snapshot) {
  // Undo snapshots are recovery aids, not authoritative results. The browser verifies
  // them on restore; the server always verifies both actual innings here.
  validateRecovery(snapshot, { verifyUndo: false });
  if (!modern(snapshot)) return;
  const config = snapshot.matchConfig;
  if (!Number.isSafeInteger(config.matchNumber) || config.matchNumber < 1 ||
      !["playing", "completed", "shortened", "abandoned"].includes(snapshot.matchStatus)) invalid("Choose a match number and valid match status.");
  for (const team of [config.teamA, config.teamB]) {
    if (!team.players.includes(team.captain) || team.players.some((id) => !uuid.test(id) ||
        typeof config.playerNames?.[id] !== "string" || !config.playerNames[id].trim() || config.playerNames[id].length > 160)) {
      invalid("Each team needs a captain and eight identified players.");
    }
  }
  if (snapshot.matchStatus === "completed" && (snapshot.inningsNumber !== 2 ||
      snapshot.completedInnings[0].legalBalls !== 96 || snapshot.state.legalBalls !== 96)) {
    invalid("A completed match needs two complete innings. Use shortened or abandoned for an early finish.");
  }
  if (!Array.isArray(snapshot.actionLog) || !snapshot.actionLog.length) invalid("The match action history is required.");
  const ids = new Set();
  for (const action of snapshot.actionLog) {
    if (!action || !uuid.test(action.id || "") || ids.has(action.id) ||
        typeof action.kind !== "string" || !action.kind.trim() || action.kind.length > 100 ||
        typeof action.reason !== "string" || !action.reason.trim() || action.reason.length > 1000 ||
        typeof action.at !== "string" || action.at.length > 100 || !Number.isFinite(Date.parse(action.at)) ||
        ![1, 2].includes(action.innings) || !Object.hasOwn(action, "before") || !Object.hasOwn(action, "after")) {
      invalid("Every match action needs a unique ID, reason, time and before/after record.");
    }
    ids.add(action.id);
  }
}

function validateSuccessor(previous, snapshot) {
  if (modern(previous) !== modern(snapshot)) invalid("Keep older matches in their original scoring format. Create a separate match for the new scorer.");
  if (!modern(previous)) return;
  const oldLog = previous.actionLog;
  if (snapshot.actionLog.length < oldLog.length || oldLog.some((entry, index) => !same(entry, snapshot.actionLog[index]))) {
    invalid("Saved match actions cannot be changed or removed.");
  }
  if (snapshot.actionLog.length === oldLog.length && !same(previous, snapshot)) invalid("Add an audited action before changing this match.");
}

async function finalizablePlayers(env, snapshot) {
  const { results } = await env.DB.prepare("SELECT id,revision,merged_into,review_required FROM players").bind().all();
  const players = new Map(results.map((player) => [player.id, player]));
  const used = new Set(), checked = new Map();
  for (const original of [...snapshot.matchConfig.teamA.players, ...snapshot.matchConfig.teamB.players]) {
    let id = original;
    const visited = new Set();
    for (;;) {
      const player = players.get(id);
      if (!player || visited.has(id)) invalid("Some players have not synced or their identities need repair. Sync the player list before finalizing.");
      if (player.review_required) invalid("Resolve possible duplicate players before finalizing this match.");
      visited.add(id); checked.set(id, { id, revision: player.revision });
      if (!player.merged_into) break;
      id = player.merged_into;
    }
    if (used.has(id)) invalid("Two roster positions resolve to the same player. Correct the teams before finalizing.");
    used.add(id);
  }
  return [...checked.values()];
}

async function bodyJSON(request) {
  if (!(request.headers.get("Content-Type") || "").startsWith("application/json")) throw new Error("JSON required");
  // Bound memory before JSON parsing, including requests without Content-Length.
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Body required");
  let size = 0;
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1_500_000) { await reader.cancel(); throw new Error("Recovery checkpoint exceeds 1.5 MB"); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function matchAPI(request, env, email, canCorrect = true) {
  const url = new URL(request.url);
  const device = request.headers.get("X-Scoring-Device");
  if (!uuid.test(device || "")) return reply({ error: "Valid scoring device required" }, 400);
  const origin = request.headers.get("Origin");
  if ((origin && origin !== url.origin) || request.headers.get("Sec-Fetch-Site") === "cross-site") return reply({ error: "Same-origin request required" }, 403);
  if (url.pathname === "/api/matches" && request.method === "GET") {
    const { results } = await env.DB.prepare(`SELECT id, revision, generation, updated_at, finalized_revision AS finalizedRevision,
      json_extract(snapshot, '$.matchConfig.matchName') AS name,
      json_extract(snapshot, '$.matchConfig.date') AS date,
      json_extract(snapshot, '$.state.total') AS total,
      json_extract(snapshot, '$.inningsNumber') AS innings,
      (owner_device = ? AND owner_email = ?) AS owned_here
      FROM matches ORDER BY updated_at DESC LIMIT 200`).bind(device, email).all();
    return reply({ matches: results });
  }
  const route = url.pathname.match(/^\/api\/matches\/([^/]+)(\/takeover|\/finalize)?$/);
  if (!route || !uuid.test(route[1])) return reply({ error: "Not found" }, 404);
  const id = route[1];
  const select = () => env.DB.prepare("SELECT * FROM matches WHERE id = ?").bind(id).first();
  if (request.method === "GET" && !route[2]) {
    const row = await select();
    return row ? reply({ id, revision: row.revision, generation: row.generation,
      savedAt: row.updated_at, finalizedRevision: row.finalized_revision, snapshot: JSON.parse(row.snapshot),
      ownedHere: row.owner_device === device && row.owner_email === email }) : reply({ error: "Not found" }, 404);
  }
  if (!((request.method === "PUT" && !route[2]) || (request.method === "POST" && route[2]))) {
    return reply({ error: "Method not allowed" }, 405);
  }
  let body;
  try {
    body = await bodyJSON(request);
    if (!integer(body.generation) || !integer(body.revision) || body.revision < 1) throw new Error("Invalid revision");
    if (!route[2]) validateSnapshot(body.snapshot);
  } catch (error) { return reply({ error: error.message || "Invalid or oversized recovery checkpoint" }, 400); }
  const updatedAt = new Date().toISOString();
  if (route[2] === "/takeover") {
    const row = await env.DB.prepare(`UPDATE matches SET owner_email = ?, owner_device = ?,
      generation = generation + 1, updated_at = ? WHERE id = ? AND generation = ? AND revision = ? RETURNING *`)
      .bind(email, device, updatedAt, id, body.generation, body.revision).first();
    if (!row) return conflict();
    return reply({ id, revision: row.revision, generation: row.generation, savedAt: row.updated_at, finalizedRevision: row.finalized_revision,
      snapshot: JSON.parse(row.snapshot), ownedHere: true });
  }
  const previous = await select();
  if (route[2] === "/finalize") {
    if (!canCorrect) return reply({ error: "Result finalization permission required" }, 403);
    if (!previous || previous.owner_email !== email || previous.owner_device !== device ||
        previous.generation !== body.generation || previous.revision !== body.revision) return conflict();
    if (previous.finalized_revision === body.revision) return reply({ id, revision: body.revision, finalizedRevision: body.revision });
    let checked;
    try {
      const snapshot = JSON.parse(previous.snapshot);
      if (!modern(snapshot)) invalid("Older recovery matches cannot be finalized. Keep their original recovery data.");
      validateSnapshot(snapshot);
      if (snapshot.matchStatus === "playing") invalid("Finish, shorten or abandon the match before finalizing.");
      checked = await finalizablePlayers(env, snapshot);
    } catch (error) { return reply({ error: error.message }, 400); }
    const finalized = await env.DB.prepare(`UPDATE matches SET finalized_revision = revision, finalized_at = ?, finalized_by = ?
      WHERE id = ? AND revision = ? AND generation = ? AND owner_email = ? AND owner_device = ?
      AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN players p ON p.id = json_extract(expected.value, '$.id')
        WHERE p.id IS NULL OR p.revision != json_extract(expected.value, '$.revision')) RETURNING *`)
      .bind(updatedAt, email, id, body.revision, body.generation, email, device, JSON.stringify(checked)).first();
    return finalized ? reply({ id, revision: finalized.revision, finalizedRevision: finalized.finalized_revision }) : conflict();
  }
  const snapshot = JSON.stringify(body.snapshot);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshot))),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (previous) {
    if (previous.owner_email !== email || previous.owner_device !== device || previous.generation !== body.generation) return conflict();
    if (body.revision === previous.revision && previous.content_hash !== hash) return conflict();
    if (body.revision <= previous.revision) return reply({ id, revision: body.revision, cloudRevision: previous.revision,
      generation: previous.generation, finalizedRevision: previous.finalized_revision, savedAt: previous.updated_at });
    if (previous.finalized_revision !== null && !canCorrect) return reply({ error: "Finalized match correction permission required" }, 403);
    try { validateSuccessor(JSON.parse(previous.snapshot), body.snapshot); }
    catch (error) { return reply({ error: error.message }, 400); }
    const changed = await env.DB.prepare(`UPDATE matches SET revision = ?, snapshot = ?, content_hash = ?, updated_at = ?
      WHERE id = ? AND owner_email = ? AND owner_device = ? AND generation = ? AND revision = ? AND finalized_revision IS ? RETURNING *`)
      .bind(body.revision, snapshot, hash, updatedAt, id, email, device, body.generation, previous.revision, previous.finalized_revision).first();
    if (!changed) return conflict();
    return reply({ id, revision: changed.revision, cloudRevision: changed.revision, generation: changed.generation,
      finalizedRevision: changed.finalized_revision, savedAt: changed.updated_at });
  }
  if (body.generation !== 0) return conflict();
  await env.DB.prepare(`INSERT OR IGNORE INTO matches(id, owner_email, owner_device, generation, revision, snapshot, content_hash, updated_at)
    VALUES(?, ?, ?, 0, ?, ?, ?, ?)`).bind(id, email, device, body.revision, snapshot, hash, updatedAt).run();
  const row = await select();
  if (!row || row.owner_email !== email || row.owner_device !== device || row.generation !== body.generation ||
      row.revision !== body.revision || row.content_hash !== hash) return conflict();
  // Same revision + content is a successful retry after a lost acknowledgement.
  return reply({ id, revision: body.revision, cloudRevision: row.revision, generation: row.generation,
    finalizedRevision: row.finalized_revision, savedAt: row.updated_at });
}
