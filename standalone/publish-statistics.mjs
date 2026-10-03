// Manual review-only publication. Never writes the production ('primary') snapshot.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { cloudRequest, SOURCE_DATABASE } from './backup.mjs';
import { statisticsPreview } from './statistics-preview.mjs';
import { finalizationToTables } from './finalized-stats.mjs';

const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 1_350_000;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tableNames = ['players', 'matches', 'batting', 'bowling', 'fielding'];

export function validateSource(history, source) {
  if (source?.format !== 1 || source.review_only !== true || !HASH.test(source.workbook_sha256 || '') ||
      !HASH.test(source.gzip_sha256 || '') || !Number.isSafeInteger(source.source_version) || source.source_version < 1 ||
      typeof source.season !== 'string' || !/^S\d+_\d{4}(?:_[A-Z])?$/.test(source.season)) throw Error('A pinned review-only historical source manifest is required.');
  if (history?.provenance?.workbook_sha256 !== source.workbook_sha256 || history.season !== source.season ||
      history.review?.publication_ready !== false || !validTime(history.generated_at) ||
      tableNames.some(name => !Array.isArray(history.tables?.[name]))) throw Error('Historical source does not match its reviewed manifest.');
  const counts = history.provenance.source_counts;
  if (!counts || tableNames.some(name => counts[name] !== history.tables[name].length)) throw Error('Historical row counts do not match the source manifest.');
  if (!Number.isSafeInteger(history.review.reconciliation?.checks) || history.review.reconciliation.checks < 0 ||
      !Array.isArray(history.review.reconciliation.mismatches) || !Array.isArray(history.review.repeated_player_match_slots) ||
      !Array.isArray(history.review.metadata_conflicts)) throw Error('Historical review findings are incomplete.');
}

export async function readPinnedHistory(historyPath, manifestPath) {
  if ((await stat(manifestPath)).size > 65_536 || (await stat(historyPath)).size > MAX_SOURCE_BYTES) throw Error('Historical source exceeds its size limit.');
  const [bytes, manifest] = await Promise.all([readFile(historyPath), readFile(manifestPath, 'utf8')]);
  const source = JSON.parse(manifest);
  if (!HASH.test(source.gzip_sha256 || '') || digest(bytes) !== source.gzip_sha256) throw Error('Historical artifact checksum does not match its pinned manifest.');
  const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const plain = gzip ? gunzipSync(bytes, { maxOutputLength: MAX_SOURCE_BYTES }) : bytes;
  if (plain.length > MAX_SOURCE_BYTES) throw Error('Uncompressed historical source exceeds its size limit.');
  const history = JSON.parse(plain.toString('utf8'));
  validateSource(history, source);
  return { history, source };
}

function canonicalNames(history, additions, players) {
  if (!Array.isArray(players)) throw Error('A captured player registry is required.');
  const registry = new Map();
  for (const player of players) {
    if (!UUID.test(player.id || '') || typeof player.name !== 'string' || !player.name.trim() ||
        !Number.isSafeInteger(player.revision) || player.revision < 1 || registry.has(player.id)) throw Error('The player registry has invalid or duplicate identities.');
    registry.set(player.id, player);
  }
  const copies = [structuredClone(history), ...structuredClone(additions)];
  const referenced = new Set();
  const nameFor = id => {
    const player = registry.get(id);
    if (!player || player.merged_into) throw Error('A referenced player is missing or merged. Review historical identity mappings before publication.');
    referenced.add(id);
    return `${player.name}${player.nickname ? ` (${player.nickname})` : ''}`;
  };
  for (const item of copies) {
    for (const table of ['players', 'batting', 'bowling', 'fielding']) {
      for (const row of item.tables[table]) row.name = nameFor(row.player_id);
    }
    for (const match of item.tables.matches) {
      for (const field of ['winning_captain', 'losing_captain', 'slot1_captain', 'slot2_captain']) {
        if (match[`${field}_id`]) match[field] = nameFor(match[`${field}_id`]);
      }
    }
  }
  // Stable IDs make owner-approved renames safe. A merge needs separate source-overlap review.
  return { history: copies[0], additions: copies.slice(1), identityReviews: [...referenced].filter(id => registry.get(id).review_required === 1).length };
}

export function buildSnapshot({ history, source, players, finalizations = [], generation = 1,
  capturedAt = new Date().toISOString(), watermark = null }) {
  validateSource(history, source);
  if (!Number.isSafeInteger(generation) || generation < 1 || !validTime(capturedAt)) throw Error('A valid snapshot generation and capture time are required.');
  if (!Array.isArray(finalizations)) throw Error('Finalized source rows are required.');
  const latest = new Map();
  for (const row of finalizations) {
    const previous = latest.get(row.match_id);
    if (previous && previous.revision >= row.revision) throw Error('Capture must contain exactly the latest immutable revision of each match.');
    if (previous) throw Error('Multiple finalized revisions were captured for one match.');
    latest.set(row.match_id, row);
  }
  const additions = [...latest.values()].sort((a, b) => a.match_id.localeCompare(b.match_id))
    .map(row => finalizationToTables(row, { season: source.season }));
  const seasonYear = source.season.match(/^S\d+_(\d{4})/)[1];
  if (additions.some(item => item.tables.matches[0].date.slice(0, 4) !== seasonYear)) {
    throw Error('A finalized match year differs from the pinned season. Review season rollover before publication.');
  }
  const normalized = canonicalNames(history, additions, players);
  const preview = statisticsPreview(normalized.history, normalized.additions);
  const finalRevisions = Object.fromEntries([...latest.values()].sort((a, b) => a.match_id.localeCompare(b.match_id)).map(row => [row.match_id, row.revision]));
  const registryEvidence = players.map(({ id, name, nickname, revision, merged_into, review_required }) =>
    ({ id, name, nickname: nickname || '', revision, merged_into: merged_into || null, review_required: review_required || 0 })).sort((a, b) => a.id.localeCompare(b.id));
  // Explicit allowlist: never publish the full internal review, source README, checkpoint or audit log.
  const manifest = {
    format: 1, review_only: true, publication_ready: false, source_version: source.source_version,
    workbook_sha256: source.workbook_sha256, history_gzip_sha256: source.gzip_sha256,
    season: source.season, history_generated_at: history.generated_at, captured_at: capturedAt,
    player_registry_sha256: digest(JSON.stringify(registryEvidence)),
    finalized_revisions: finalRevisions, counts: preview.review.counts,
    unresolved: { season_confirmation: true, appearance_count_policy: true, player_identity_reviews: normalized.identityReviews,
      historical_reconciliation_findings: history.review.reconciliation?.mismatches?.length || 0,
      historical_repeated_keys: history.review.repeated_player_match_slots.length,
      historical_metadata_conflicts: history.review.metadata_conflicts.length,
      historical_unknown_team_rows: preview.review.historical_slot_projection.unresolved },
  };
  if (watermark) manifest.source_watermark = validateWatermark(watermark);
  const source_manifest = JSON.stringify(manifest);
  if (Buffer.byteLength(source_manifest) > 65_536) throw Error('Statistics manifest exceeds 64 KiB; previous snapshot is kept.');
  preview.data.meta.review_only = true;
  preview.data.meta.publication_ready = false;
  preview.data.meta.publication = { channel: 'review', generation, generated_at: capturedAt, source_version: source.source_version };
  const plain = Buffer.from(JSON.stringify(preview.data) + '\n');
  if (plain.length > MAX_SOURCE_BYTES) throw Error('Projected statistics exceed the reviewed size limit.');
  const compressed = gzipSync(plain);
  if (compressed.length > MAX_COMPRESSED_BYTES) throw Error('Compressed statistics exceed the D1 snapshot limit; previous snapshot is kept.');
  return { name: 'review', generation, generated_at: capturedAt, sha256: digest(compressed),
    gzip_base64: compressed.toString('base64'), source_manifest };
}

export const WATERMARK_SQL = `SELECT
  (SELECT count(*) FROM match_finalizations) AS finalizations,
  (SELECT count(*) FROM players) AS players,
  (SELECT coalesce(sum(revision),0) FROM players) AS player_revisions`;
const WATERMARK_GUARD = `(SELECT count(*) FROM match_finalizations) = ?
  AND (SELECT count(*) FROM players) = ? AND (SELECT coalesce(sum(revision),0) FROM players) = ?`;
function validateWatermark(value) {
  const copy = {};
  for (const key of ['finalizations', 'players', 'player_revisions']) {
    if (!Number.isSafeInteger(value?.[key]) || value[key] < 0) throw Error('Source watermark is invalid.');
    copy[key] = value[key];
  }
  return copy;
}

export async function query(token, sql, params = [], fetcher = fetch) {
  const result = await cloudRequest(token, SOURCE_DATABASE, 'query', { sql, params }, fetcher);
  if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0]?.results)) throw Error('Cloudflare query response was incomplete.');
  return result[0].results;
}

export async function captureSource(token, fetcher = fetch) {
  const watermark = validateWatermark((await query(token, WATERMARK_SQL, [], fetcher))[0]);
  const players = await query(token, 'SELECT id,name,nickname,revision,merged_into,review_required FROM players ORDER BY id', [], fetcher);
  const finalizations = [];
  let after = '', bytes = 0;
  for (;;) {
    // Immutable records, latest revision per match. Mutable matches/checkpoints are never read.
    const page = await query(token, `SELECT f.match_id,f.revision,f.snapshot,f.content_hash,f.created_at
      FROM match_finalizations f WHERE f.match_id > ?
      AND f.revision = (SELECT max(latest.revision) FROM match_finalizations latest WHERE latest.match_id = f.match_id)
      ORDER BY f.match_id LIMIT 10`, [after], fetcher);
    for (const row of page) {
      if (typeof row.match_id !== 'string' || row.match_id <= after || typeof row.snapshot !== 'string') throw Error('Finalized source ordering was invalid.');
      after = row.match_id;
      bytes += Buffer.byteLength(row.snapshot);
      if (bytes > MAX_SOURCE_BYTES) throw Error('Finalized source exceeds the reviewed 128 MiB limit.');
      finalizations.push(row);
    }
    if (page.length < 10) break;
  }
  const confirmed = validateWatermark((await query(token, WATERMARK_SQL, [], fetcher))[0]);
  if (!same(watermark, confirmed)) throw Error('Scoring finalizations or identities changed during capture. Retry; previous statistics are kept.');
  return { players, finalizations, watermark };
}

function checkPrevious(previous, source) {
  if (!previous) return;
  if (!Number.isSafeInteger(previous.generation) || previous.generation < 1 || !HASH.test(previous.sha256 || '')) throw Error('Existing statistics metadata is invalid.');
  const manifest = JSON.parse(previous.source_manifest);
  if (!Number.isSafeInteger(manifest.source_version) || manifest.source_version > source.source_version ||
      (manifest.source_version === source.source_version && (manifest.history_gzip_sha256 !== source.gzip_sha256 || manifest.workbook_sha256 !== source.workbook_sha256))) {
    throw Error('Historical source is older or conflicts with the published source version.');
  }
}

export async function publishReview({ token, history, source, fetcher = fetch, now = () => new Date().toISOString() }) {
  if (typeof token !== 'string' || !token) throw Error('Configure CLOUDFLARE_D1_BACKUP_TOKEN before publishing a review.');
  validateSource(history, source);
  // Read the expected destination before reading sources: a slower older job cannot supersede a newer capture.
  const rows = await query(token, "SELECT generation,sha256,source_manifest FROM public_statistics WHERE name='review'", [], fetcher);
  if (rows.length > 1) throw Error('Statistics destination is ambiguous.');
  const previous = rows[0] || null;
  checkPrevious(previous, source);
  const captured = await captureSource(token, fetcher);
  const snapshot = buildSnapshot({ history, source, ...captured, generation: (previous?.generation || 0) + 1, capturedAt: now() });
  const values = [snapshot.generation, snapshot.generated_at, snapshot.sha256, snapshot.gzip_base64, snapshot.source_manifest];
  const guard = [captured.watermark.finalizations, captured.watermark.players, captured.watermark.player_revisions];
  const committed = previous
    ? await query(token, `UPDATE public_statistics SET generation=?,generated_at=?,sha256=?,gzip_base64=?,source_manifest=?
        WHERE name='review' AND generation=? AND sha256=? AND ${WATERMARK_GUARD}
        RETURNING name,generation,sha256`, [...values, previous.generation, previous.sha256, ...guard], fetcher)
    : await query(token, `INSERT INTO public_statistics(name,generation,generated_at,sha256,gzip_base64,source_manifest)
        SELECT 'review',?,?,?,?,? WHERE ${WATERMARK_GUARD}
        ON CONFLICT(name) DO NOTHING RETURNING name,generation,sha256`, [...values, ...guard], fetcher);
  if (committed.length !== 1 || committed[0].sha256 !== snapshot.sha256 || committed[0].generation !== snapshot.generation) {
    throw Error('Statistics or source data changed before publication. Previous snapshot is kept; retry from a fresh capture.');
  }
  return { name: 'review', generation: snapshot.generation, sha256: snapshot.sha256,
    compressed_bytes: Buffer.from(snapshot.gzip_base64, 'base64').length, publication_ready: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [historyPath, manifestPath, ...extra] = process.argv.slice(2);
    if (!historyPath || !manifestPath || extra.length) throw Error('Usage: node standalone/publish-statistics.mjs PINNED_HISTORY.json.gz HISTORY_SOURCE.json');
    const pinned = await readPinnedHistory(historyPath, manifestPath);
    console.log(JSON.stringify(await publishReview({ token: process.env.CLOUDFLARE_D1_BACKUP_TOKEN, ...pinned })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
