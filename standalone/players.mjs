const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const normalize = (name) => name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const clean = (value, limit, required = false) => {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) throw Error('Invalid text');
  value = value.trim().replace(/\s+/g, ' ');
  if (required && !normalize(value)) throw Error('Name or reason required');
  return value;
};

async function readBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) throw Error('JSON required');
  const reader = request.body?.getReader();
  if (!reader) throw Error('Body required');
  const chunks = []; let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 4096) { await reader.cancel(); throw Error('Body too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const body = JSON.parse(new TextDecoder().decode(bytes));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Object required');
  return body;
}

// Warnings only: exact normalized names, shortened full names, or one mistyped letter.
// No similarity result ever merges identities automatically.
function similar(a, b) {
  if (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `)) return true;
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, differences = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++differences > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return differences + (i < a.length || j < b.length ? 1 : 0) <= 1;
}

const view = (row, aliases = []) => ({ id: row.id, name: row.name, nickname: row.nickname,
  active: row.active === 1, revision: row.revision, mergedInto: row.merged_into,
  reviewRequired: row.review_required === 1, aliases, updatedAt: row.updated_at });

export async function playerAPI(request, env, email) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if ((origin && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    return reply({ error: 'Same-origin request required' }, 403);
  }
  const canManage = typeof env.OWNER_EMAIL === 'string' && email.toLowerCase() === env.OWNER_EMAIL.trim().toLowerCase();
  const list = async () => (await env.DB.prepare('SELECT * FROM players ORDER BY name, nickname, id').bind().all()).results;
  const select = (id) => env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(id).first();
  const aliases = async (id) => (await env.DB.prepare('SELECT name,nickname FROM player_aliases WHERE player_id = ? ORDER BY name,nickname').bind(id).all()).results;
  const full = async (row) => view(row, await aliases(row.id));
  const warnings = async (name, id) => {
    const rows = await list();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const oldNames = (await env.DB.prepare('SELECT player_id,name FROM player_aliases').bind().all()).results;
    const found = new Map();
    const normalized = normalize(name);
    for (const alias of oldNames) {
      if (!similar(normalized, normalize(alias.name))) continue;
      let row = byId.get(alias.player_id);
      // Merges retain old identities; follow them to the current player suggestion.
      const seen = new Set();
      while (row?.merged_into && !seen.has(row.id)) { seen.add(row.id); row = byId.get(row.merged_into); }
      if (row && !row.merged_into && row.id !== id) found.set(row.id, { id: row.id, name: row.name, nickname: row.nickname });
    }
    return [...found.values()];
  };
  if (url.pathname === '/api/players' && request.method === 'GET') {
    const rows = await list();
    const allAliases = (await env.DB.prepare('SELECT player_id,name,nickname FROM player_aliases ORDER BY name,nickname').bind().all()).results;
    const byPlayer = new Map();
    for (const { player_id, name, nickname } of allAliases) {
      if (!byPlayer.has(player_id)) byPlayer.set(player_id, []);
      byPlayer.get(player_id).push({ name, nickname });
    }
    return reply({ players: rows.map((row) => view(row, byPlayer.get(row.id))), canManage });
  }
  const route = url.pathname.match(/^\/api\/players\/([^/]+)(\/merge)?$/);
  const creating = url.pathname === '/api/players' && request.method === 'POST';
  if (!creating && (!route || !uuid.test(route[1]))) return reply({ error: 'Not found' }, 404);
  if (!creating && !((request.method === 'PATCH' && !route[2]) || (request.method === 'POST' && route[2]))) return reply({ error: 'Method not allowed' }, 405);
  if (!creating && !canManage) return reply({ error: 'Only the owner can change player identities' }, 403);
  let body, name, nickname, reason;
  try {
    body = await readBody(request);
    if (creating) {
      if (!uuid.test(body.id || '')) throw Error('UUID required');
      name = clean(body.name, 100, true); nickname = clean(body.nickname ?? '', 60);
    } else {
      if (!Number.isSafeInteger(body.revision) || body.revision < 1) throw Error('Revision required');
      reason = clean(body.reason, 500, true);
      if (route[2]) {
        if (!uuid.test(body.targetId || '') || body.targetId === route[1]) throw Error('Invalid merge target');
      } else {
        if (body.name !== undefined) name = clean(body.name, 100, true);
        if (body.nickname !== undefined) nickname = clean(body.nickname, 60);
        if (body.active !== undefined && typeof body.active !== 'boolean') throw Error('Invalid active state');
        if (body.reviewRequired !== undefined && typeof body.reviewRequired !== 'boolean') throw Error('Invalid review state');
        if (![name, nickname, body.active, body.reviewRequired].some((value) => value !== undefined)) throw Error('No change');
      }
    }
  } catch { return reply({ error: 'Invalid or oversized player details' }, 400); }
  const now = new Date().toISOString();
  if (creating) {
    const id = body.id.toLowerCase();
    const creation = JSON.stringify({ name, nickname });
    const candidates = await warnings(name, id);
    // The EXISTS check also catches exact-name additions racing on separate devices.
    const inserted = await env.DB.prepare(`INSERT INTO players
      (id,name,nickname,normalized_name,review_required,creation_payload,created_at,updated_at,updated_by,reason)
      VALUES(?,?,?,?, CASE WHEN ? = 1 OR EXISTS(SELECT 1 FROM players WHERE normalized_name = ? AND merged_into IS NULL) THEN 1 ELSE 0 END,?,?,?,?,?)
      ON CONFLICT(id) DO NOTHING RETURNING *`).bind(id, name, nickname, normalize(name), candidates.length ? 1 : 0,
      normalize(name), creation, now, now, email, 'Player added').first();
    let row = inserted || await select(id);
    if (!row || row.creation_payload !== creation) return reply({ error: 'This player ID already has different details' }, 409);
    const finalWarnings = await warnings(name, id);
    // Recheck after insertion: two devices may have searched the pool before either added a near-match.
    if (inserted && finalWarnings.length && !row.review_required) {
      row = await env.DB.prepare(`UPDATE players SET review_required = 1, revision = revision + 1,
        updated_at = ?, updated_by = ?, reason = 'Similar player added concurrently; identity review required'
        WHERE id = ? AND revision = ? AND merged_into IS NULL RETURNING *`)
        .bind(now, email, id, row.revision).first() || await select(id);
    }
    return reply({ player: await full(row), warnings: finalWarnings }, inserted ? 201 : 200);
  }
  const id = route[1].toLowerCase();
  const previous = await select(id);
  if (!previous) return reply({ error: 'Player not found' }, 404);
  if (previous.revision !== body.revision || previous.merged_into) return reply({ error: 'Player changed. Refresh before editing.' }, 409);
  if (route[2]) {
    const targetId = body.targetId.toLowerCase();
    const row = await env.DB.prepare(`UPDATE players SET merged_into = ?, active = 0, review_required = 0,
      revision = revision + 1, updated_at = ?, updated_by = ?, reason = ?
      WHERE id = ? AND revision = ? AND merged_into IS NULL AND id != ?
      AND EXISTS(SELECT 1 FROM players target WHERE target.id = ? AND target.merged_into IS NULL) RETURNING *`)
      .bind(targetId, now, email, reason, id, body.revision, targetId, targetId).first();
    if (!row) return reply({ error: 'Merge source or target changed. Refresh before merging.' }, 409);
    return reply({ player: await full(row), target: await full(await select(targetId)) });
  }
  name ??= previous.name; nickname ??= previous.nickname;
  const candidates = await warnings(name, id);
  const review = body.reviewRequired ?? (name !== previous.name && candidates.length > 0 ? true : previous.review_required === 1);
  const row = await env.DB.prepare(`UPDATE players SET name = ?, nickname = ?, normalized_name = ?, active = ?,
    review_required = ?, revision = revision + 1, updated_at = ?, updated_by = ?, reason = ?
    WHERE id = ? AND revision = ? AND merged_into IS NULL RETURNING *`)
    .bind(name, nickname, normalize(name), body.active === undefined ? previous.active : Number(body.active), Number(review), now, email, reason, id, body.revision).first();
  if (!row) return reply({ error: 'Player changed. Refresh before editing.' }, 409);
  return reply({ player: await full(row), warnings: candidates });
}
