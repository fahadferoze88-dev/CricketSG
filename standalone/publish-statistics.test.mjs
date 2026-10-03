import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { recoveryDB } from './test-db.mjs';
import { freshScore, applyDelivery } from '../testing/scoring.mjs';
import { buildSnapshot, publishReview, publishStatistics, readPinnedHistory, captureSource, APPEARANCE_POLICY } from './publish-statistics.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const id = number => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const now = () => '2026-09-30T12:00:00.000Z';
const source = () => ({ format: 1, workbook_sha256: 'a'.repeat(64), gzip_sha256: 'b'.repeat(64), season: 'S8_2026', source_version: 1, review_only: true });
const players = () => Array.from({ length: 16 }, (_, index) => ({ id: id(index + 1), name: `Player ${index + 1}`, nickname: '', revision: 1, merged_into: null, review_required: 0 }));
function history() {
  const tables = { players: players().map(player => ({ player_id: player.id, name: player.name })),
    matches: [{ match_id: '20260828_1', date: '20260828', season: 'S8_2026' }],
    batting: [{ match_id: '20260828_1', player_id: id(1), name: 'Player 1', team_slot: 'Team 1', runs: 4, balls_faced: 1 }], bowling: [], fielding: [] };
  return { generated_at: '2026-09-06T00:00:00Z', season: 'S8_2026', tables,
    provenance: { workbook_sha256: source().workbook_sha256, source_counts: Object.fromEntries(Object.entries(tables).map(([key, rows]) => [key, rows.length])), private: 'private-history@example.com' },
    review: { publication_ready: false, reconciliation: { checks: 1, mismatches: [] }, repeated_player_match_slots: [], metadata_conflicts: [], privateAudit: 'private-review@example.com' } };
}
function finalized(revision = 2) {
  const teamA = players().slice(0, 8).map(player => player.id), teamB = players().slice(8).map(player => player.id);
  const state = freshScore(teamA, teamB);
  Object.assign(state, { battingPairs: [teamA.slice(0, 2)], awaitingPair: false, bowler: teamB[0] });
  applyDelivery(state, { id: id(50), batterRuns: revision, chip: String(revision) }, { batters: teamA, fielders: teamB });
  const snapshot = JSON.stringify({
    matchConfig: { schemaVersion: 2, matchNumber: 1, date: '2026-09-30', matchName: 'Publisher test', battingFirst: 'teamA',
      playerNames: Object.fromEntries(players().map(player => [player.id, player.name])),
      teamA: { name: 'A', players: teamA, captain: teamA[0] }, teamB: { name: 'B', players: teamB, captain: teamB[0] } },
    state, inningsNumber: 1, completedInnings: [], undoStack: [], actionLog: [], matchStatus: 'shortened', privateAudit: 'private-checkpoint@example.com',
  });
  return { match_id: id(99), revision, snapshot, content_hash: hash(snapshot), created_at: now() };
}
function dbFixture(registry = players()) {
  const { sqlite } = recoveryDB();
  sqlite.exec(readFileSync(new URL('./migrations/0005_statistics.sql', import.meta.url), 'utf8'));
  for (const player of registry) sqlite.prepare(`INSERT INTO players(id,name,nickname,normalized_name,creation_payload,created_at,updated_at,updated_by,reason)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(player.id, player.name, '', player.name.toLowerCase(), '{}', now(), now(), 'first@example.com', 'Fixture');
  const capturedQueries = [];
  const fetcher = async (_url, options) => {
    const { sql, params = [] } = JSON.parse(options.body);
    capturedQueries.push(sql);
    const results = sqlite.prepare(sql).all(...params);
    return Response.json({ success: true, result: [{ success: true, results }] });
  };
  return { sqlite, fetcher, capturedQueries };
}
function insertFinalization(sqlite, row) {
  sqlite.prepare(`INSERT OR IGNORE INTO matches(id,owner_email,owner_device,generation,revision,snapshot,content_hash,updated_at)
    VALUES(?,?,?,0,?,?,?,?)`).run(row.match_id, 'first@example.com', id(90), row.revision, row.snapshot, row.content_hash, now());
  sqlite.prepare('INSERT INTO match_finalizations VALUES(?,?,?,?,?,?,?)').run(row.match_id, row.revision, 'first@example.com', id(90), row.snapshot, row.content_hash, row.created_at);
}

test('pure review snapshot projects canonical names and contains no private audit metadata', () => {
  const registry = players(); registry[0].name = 'Renamed player'; registry[0].nickname = 'Captain'; registry[0].revision = 2;
  registry[1].review_required = 1;
  const snapshot = buildSnapshot({ history: history(), source: source(), players: registry, finalizations: [finalized()], generation: 3, capturedAt: now() });
  const bytes = Buffer.from(snapshot.gzip_base64, 'base64');
  assert.equal(hash(bytes), snapshot.sha256);
  const plain = gunzipSync(bytes).toString('utf8');
  const data = JSON.parse(plain), manifest = JSON.parse(snapshot.source_manifest);
  assert.equal(snapshot.name, 'review');
  assert.equal(data.meta.publication.generation, 3);
  assert.equal(data.meta.publication_ready, false);
  assert.equal(data.matches.length, 2);
  assert.ok(data.players.some(player => player.name === 'Renamed player (Captain)'));
  assert.equal(manifest.unresolved.player_identity_reviews, 1);
  assert.equal(manifest.unresolved.season_confirmation, true);
  for (const text of [plain, snapshot.source_manifest]) {
    assert.doesNotMatch(text, /private-.*@example\.com|actor_email|owner_email|owner_device|actionLog|privateAudit/);
  }
  assert.equal(history().tables.players[0].name, 'Player 1');
  const merged = players(); merged[0].merged_into = id(2);
  assert.throws(() => buildSnapshot({ history: history(), source: source(), players: merged }), /missing or merged/);
  assert.throws(() => buildSnapshot({ history: history(), source: source(), players: players().slice(1) }), /missing or merged/);
  assert.throws(() => buildSnapshot({ history: history(), source: source(), players: players(), finalizations: [finalized(), finalized()] }), /exactly the latest/);
  const nextYear = finalized();
  const saved = JSON.parse(nextYear.snapshot); saved.matchConfig.date = '2027-01-01';
  nextYear.snapshot = JSON.stringify(saved); nextYear.content_hash = hash(nextYear.snapshot);
  assert.throws(() => buildSnapshot({ history: history(), source: source(), players: players(), finalizations: [nextYear] }), /season rollover/);
});

test('publication reads immutable latest revisions and atomically advances only the review channel', async () => {
  const f = dbFixture();
  try {
    insertFinalization(f.sqlite, finalized(1)); insertFinalization(f.sqlite, finalized(2));
    const outcome = await publishReview({ token: 'test-token', history: history(), source: source(), fetcher: f.fetcher, now });
    assert.equal(outcome.generation, 1);
    const saved = f.sqlite.prepare('SELECT * FROM public_statistics').all();
    assert.equal(saved.length, 1); assert.equal(saved[0].name, 'review');
    assert.equal(JSON.parse(saved[0].source_manifest).finalized_revisions[id(99)], 2);
    const next = await publishReview({ token: 'test-token', history: history(), source: source(), fetcher: f.fetcher, now });
    assert.equal(next.generation, 2);
    assert.ok(f.capturedQueries.some(sql => sql.includes('FROM match_finalizations f')));
    assert.ok(f.capturedQueries.every(sql => !/actor_email|owner_email|owner_device|SELECT\s+\*/i.test(sql)));
    assert.ok(f.capturedQueries.every(sql => !/\bFROM matches\b/i.test(sql)));
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM public_statistics WHERE name='primary'").get().n, 0);
  } finally { f.sqlite.close(); }
});

test('a slower publication, source mutation or older baseline cannot replace the previous good snapshot', async () => {
  const f = dbFixture();
  try {
    await publishReview({ token: 'test-token', history: history(), source: source(), fetcher: f.fetcher, now });
    const original = f.sqlite.prepare("SELECT * FROM public_statistics WHERE name='review'").get();
    let interrupted = false;
    const race = async (url, options) => {
      const { sql } = JSON.parse(options.body);
      if (!interrupted && sql.startsWith('UPDATE public_statistics')) {
        interrupted = true;
        f.sqlite.exec("UPDATE public_statistics SET generation=generation+1 WHERE name='review'");
      }
      return f.fetcher(url, options);
    };
    await assert.rejects(() => publishReview({ token: 'test-token', history: history(), source: source(), fetcher: race, now }), /changed before publication/);
    assert.equal(f.sqlite.prepare("SELECT sha256 FROM public_statistics WHERE name='review'").get().sha256, original.sha256);
    const sourceRace = async (url, options) => {
      if (JSON.parse(options.body).sql.startsWith('UPDATE public_statistics')) f.sqlite.prepare('UPDATE players SET revision=revision+1 WHERE id=?').run(id(1));
      return f.fetcher(url, options);
    };
    await assert.rejects(() => publishReview({ token: 'test-token', history: history(), source: source(), fetcher: sourceRace, now }), /changed before publication/);
    assert.equal(f.sqlite.prepare("SELECT sha256 FROM public_statistics WHERE name='review'").get().sha256, original.sha256);
    const manifest = JSON.parse(original.source_manifest); manifest.source_version = 2;
    f.sqlite.prepare("UPDATE public_statistics SET generation=generation+1,source_manifest=? WHERE name='review'").run(JSON.stringify(manifest));
    await assert.rejects(() => publishReview({ token: 'test-token', history: history(), source: source(), fetcher: f.fetcher, now }), /older or conflicts/);
  } finally { f.sqlite.close(); }
});

test('source capture detects identity changes between reads', async () => {
  const f = dbFixture();
  try {
    let changed = false;
    const race = async (url, options) => {
      const response = await f.fetcher(url, options);
      if (!changed && JSON.parse(options.body).sql.includes('SELECT id,name,nickname')) {
        changed = true; f.sqlite.prepare('UPDATE players SET revision=revision+1 WHERE id=?').run(id(1));
      }
      return response;
    };
    await assert.rejects(() => captureSource('token', race), /changed during capture/);
  } finally { f.sqlite.close(); }
});

test('pinned gzip source validates bytes, workbook identity, counts and review-only mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cricket-statistics-test-'));
  try {
    const path = join(directory, 'history.json.gz'), manifestPath = join(directory, 'source.json');
    const bytes = gzipSync(JSON.stringify(history()));
    const manifest = { ...source(), gzip_sha256: hash(bytes) };
    await writeFile(path, bytes); await writeFile(manifestPath, JSON.stringify(manifest));
    assert.equal((await readPinnedHistory(path, manifestPath)).history.tables.matches.length, 1);
    await writeFile(path, Buffer.concat([bytes, Buffer.from('tamper')]));
    await assert.rejects(() => readPinnedHistory(path, manifestPath), /checksum/);
    await writeFile(path, bytes); await writeFile(manifestPath, JSON.stringify({ ...manifest, review_only: false }));
    await assert.rejects(() => readPinnedHistory(path, manifestPath), /review-only/);
    const invalid = history(); invalid.provenance.source_counts.batting = 99;
    assert.throws(() => buildSnapshot({ history: invalid, source: source(), players: players() }), /row counts/);
    assert.throws(() => buildSnapshot({ history: history(), source: { ...source(), season: 'S9_2027' }, players: players() }), /reviewed manifest/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('approved Ammar hold keeps 28 career appearances, all seven catches and the original fielding record', async () => {
  const pinned = await readPinnedHistory(new URL('./history.json.gz', import.meta.url), new URL('./history-source.json', import.meta.url));
  const registry = pinned.history.tables.players.map(row => ({ id: row.player_id, name: row.name, nickname: '', revision: 1, merged_into: null, review_required: 0 }));
  const decided = { ...pinned.source, season_confirmed: true, appearance_count_policy: APPEARANCE_POLICY };
  const before = JSON.stringify(pinned.history);
  const snapshot = buildSnapshot({ history: pinned.history, source: decided, players: registry, capturedAt: now() });
  const data = JSON.parse(gunzipSync(Buffer.from(snapshot.gzip_base64, 'base64')));
  const record = data.views.player_records.Ammar;
  assert.equal(record.matches, 28);
  assert.equal(data.players.find(row => row.name === 'Ammar').matches, 28);
  assert.equal(record.fielding.catches, 7);
  assert.equal(record.fielding.matches, 29);
  assert.match(record.review_notes[0], /one catch and fielding entry remain included/);
  const raw = data.raw.fielding;
  assert.ok(raw.rows.some(row => row[raw.columns.indexOf('match')] === '20231104_2' && row[raw.columns.indexOf('player')] === 'Ammar' && row[raw.columns.indexOf('catches')] === 1));
  assert.equal(data.meta.record_holds[0].career_appearance_counted, false);
  assert.equal(JSON.parse(snapshot.source_manifest).unresolved.appearance_count_policy, false);
  assert.equal(JSON.parse(pinned.history ? JSON.stringify(pinned.history) : '{}').tables.players.find(row => row.name === 'Ammar').matches, 28);
  assert.equal(JSON.stringify(pinned.history), before);
  const next = finalized();
  next.snapshot = next.snapshot.replaceAll(id(1), '333f6749-ebf8-425d-842a-7790bfa9d81f');
  next.content_hash = hash(next.snapshot);
  const additionalPlayers = players().filter(player => player.id !== id(1));
  const updated = buildSnapshot({ history: pinned.history, source: decided, players: [...registry, ...additionalPlayers], finalizations: [next], capturedAt: now() });
  const updatedData = JSON.parse(gunzipSync(Buffer.from(updated.gzip_base64, 'base64')));
  assert.equal(updatedData.views.player_records.Ammar.matches, 29, 'future finalized participation adds to the confirmed 28-match baseline');
  assert.equal(updatedData.views.player_records.Ammar.fielding.catches, 7);
  const altered = structuredClone(pinned.history);
  altered.tables.fielding.find(row => row.name === 'Ammar' && row.match_id === '20231104_2').catches = 2;
  assert.throws(() => buildSnapshot({ history: altered, source: decided, players: registry }), /held Ammar record changed/);
});

test('primary needs source-specific approval and remains isolated from the default review channel', async () => {
  const pinned = await readPinnedHistory(new URL('./history.json.gz', import.meta.url), new URL('./history-source.json', import.meta.url));
  const registry = pinned.history.tables.players.map(row => ({ id: row.player_id, name: row.name, nickname: '', revision: 1, merged_into: null, review_required: 0 }));
  const approved = { ...pinned.source, review_only: false, season_confirmed: true, appearance_count_policy: APPEARANCE_POLICY,
    primary_approval: { approved: true, source_version: pinned.source.source_version, history_gzip_sha256: pinned.source.gzip_sha256,
      season: pinned.source.season, appearance_count_policy: APPEARANCE_POLICY, approved_at: now() } };
  const unapproved = { ...pinned.source, review_only: true, primary_approval: undefined };
  await assert.rejects(() => publishStatistics({ token: 'token', ...pinned, source: unapproved, channel: 'primary', fetcher: () => { throw Error('Should not reach database'); } }), /explicit approval/);
  assert.throws(() => buildSnapshot({ history: pinned.history, source: approved, players: registry, channel: 'arbitrary' }), /channel/);
  const wrongHash = structuredClone(approved); wrongHash.primary_approval.history_gzip_sha256 = '0'.repeat(64);
  assert.throws(() => buildSnapshot({ history: pinned.history, source: wrongHash, players: registry, channel: 'primary' }), /manifest/);
  const f = dbFixture(registry);
  try {
    const official = await publishStatistics({ token: 'token', history: pinned.history, source: approved, channel: 'primary', fetcher: f.fetcher, now });
    assert.equal(official.name, 'primary'); assert.equal(official.publication_ready, true);
    const saved = f.sqlite.prepare("SELECT * FROM public_statistics WHERE name='primary'").get();
    const data = JSON.parse(gunzipSync(Buffer.from(saved.gzip_base64, 'base64')));
    assert.equal(data.meta.review_only, false); assert.equal(data.meta.publication_ready, true);
    assert.equal(data.meta.publication.channel, 'primary'); assert.equal(data.views.player_records.Ammar.matches, 28);
    assert.equal(f.sqlite.prepare("SELECT count(*) n FROM public_statistics WHERE name='review'").get().n, 0);
    const review = await publishStatistics({ token: 'token', history: pinned.history, source: approved, fetcher: f.fetcher, now });
    assert.equal(review.name, 'review'); assert.equal(review.publication_ready, false);
    assert.deepEqual(f.sqlite.prepare("SELECT * FROM public_statistics WHERE name='primary'").get(), saved);
  } finally { f.sqlite.close(); }
});
