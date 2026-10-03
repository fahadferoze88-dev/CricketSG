// Review-only projection. No network, database writes or production file updates.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import converter from '../scripts/download-mega-data.cjs';

const disciplines = ['batting', 'bowling', 'fielding'];
const displayKey = name => name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

export function statisticsPreview(history, additions = []) {
  if (!history?.provenance?.workbook_sha256 || !history.review || !history.tables) throw new Error('Use the reviewed historical importer output.');
  const tables = structuredClone(history.tables);
  // The corrected workbook mixes innings slots and own-team slots in bowling/fielding.
  // Match a player's exact permanent ID to its unambiguous batting roster; keep raw evidence.
  const battingSlots = new Map();
  for (const row of tables.batting) {
    if (!['Team 1', 'Team 2'].includes(row.team_slot)) continue;
    const key = `${row.match_id}:${row.player_id}`;
    if (!battingSlots.has(key)) battingSlots.set(key, new Set());
    battingSlots.get(key).add(row.team_slot);
  }
  const ownSlot = (match, player) => {
    const values = battingSlots.get(`${match}:${player}`);
    return values?.size === 1 ? [...values][0] : null;
  };
  const slotReview = { changed: 0, unresolved: 0 };
  for (const table of ['bowling', 'fielding']) for (const row of tables[table]) {
    row.source_team_slot = row.team_slot;
    row.team_slot = ownSlot(row.match_id, row.player_id);
    if (row.team_slot === null) slotReview.unresolved++;
    else if (row.team_slot !== row.source_team_slot) slotReview.changed++;
  }
  for (const match of tables.matches) {
    const winner = ownSlot(match.match_id, match.winning_captain_id);
    const loser = ownSlot(match.match_id, match.losing_captain_id);
    if (winner && loser && winner !== loser) {
      match.winner_slot = winner;
      for (const [slot, field] of [[winner, 'winning_captain'], [loser, 'losing_captain']]) {
        const prefix = slot === 'Team 1' ? 'slot1' : 'slot2';
        match[`${prefix}_captain`] = match[field];
        match[`${prefix}_captain_id`] = match[`${field}_id`];
        match[`${prefix}_player_runs`] = match[field === 'winning_captain' ? 'winner_player_runs' : 'loser_player_runs'];
      }
    }
  }
  const matchIds = new Set(tables.matches.map(row => row.match_id));
  if (matchIds.size !== tables.matches.length) throw new Error('Duplicate historical match ID.');
  const players = new Map();
  const addPlayer = row => {
    if (!row.player_id || typeof row.name !== 'string' || !row.name.trim()) throw new Error('Every player needs an ID and name.');
    const old = players.get(row.player_id);
    if (old && old.name !== row.name) throw new Error(`Resolve player rename before projection: ${row.player_id}`);
    players.set(row.player_id, row);
  };
  tables.players.forEach(addPlayer);
  // A newer finalized revision replaces that entire match, never appends its figures again.
  const latest = new Map();
  for (const item of additions) {
    if (item.season !== history.season) throw new Error('Choose the current season explicitly before combining finalized records.');
    if (!item.tables || item.tables.matches.length !== 1) throw new Error('Each addition must contain one finalized match.');
    const match = item.tables.matches[0];
    if (!match.match_id || !Number.isSafeInteger(match.revision) || match.revision < 1) throw new Error('Finalized match ID/revision required.');
    if (matchIds.has(match.match_id)) throw new Error('Historical/live match collision needs explicit reconciliation.');
    const previous = latest.get(match.match_id);
    if (previous && previous.tables.matches[0].revision === match.revision && JSON.stringify(previous) !== JSON.stringify(item)) throw new Error('Conflicting copies of the same finalized revision.');
    if (!previous || previous.tables.matches[0].revision < match.revision) latest.set(match.match_id, item);
  }
  for (const item of latest.values()) {
    item.tables.players.forEach(addPlayer);
    tables.matches.push(...structuredClone(item.tables.matches));
    for (const table of disciplines) {
      if (!Array.isArray(item.tables[table]) || item.tables[table].some(row => row.match_id !== item.tables.matches[0].match_id)) throw new Error('Mismatched finalized performance rows.');
      tables[table].push(...structuredClone(item.tables[table]));
    }
  }
  // Existing dashboard keys by name: disambiguate visually identical names without merging IDs.
  const names = new Map();
  for (const row of players.values()) {
    const key = displayKey(row.name);
    names.set(key, (names.get(key) || 0) + 1);
  }
  const labels = new Map([...players].map(([id, row]) => {
    const samePrefix = [...players].some(([otherId, other]) => otherId !== id && displayKey(other.name) === displayKey(row.name) && otherId.slice(0, 8) === id.slice(0, 8));
    return [id, names.get(displayKey(row.name)) > 1 ? `${row.name} [${samePrefix ? id : id.slice(0, 8)}]` : row.name];
  }));
  if (new Set(labels.values()).size !== labels.size) throw new Error('Display-label collision.');
  tables.players = [...players.values()].map(row => ({ ...row, name: labels.get(row.player_id) }));
  const validMatches = new Set(tables.matches.map(row => row.match_id));
  for (const table of disciplines) for (const row of tables[table]) {
    if (!labels.has(row.player_id) || !validMatches.has(row.match_id)) throw new Error(`Unknown player or match in ${table}.`);
    row.name = labels.get(row.player_id);
  }
  for (const row of tables.matches) for (const field of ['winning_captain', 'losing_captain', 'slot1_captain', 'slot2_captain']) {
    if (row[`${field}_id`]) {
      if (!labels.has(row[`${field}_id`])) throw new Error('Unknown captain ID.');
      row[field] = labels.get(row[`${field}_id`]);
    }
  }
  const times = [history.generated_at, ...[...latest.values()].map(item => item.generated_at)];
  if (times.some(time => typeof time !== 'string' || !Number.isFinite(Date.parse(time)))) throw new Error('Valid source timestamps required.');
  const generated_at = times.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
  const data = converter.convertTablesExport({ ...history, generated_at, tables }, { includeUnknownTotals: true });
  data.meta.review_only = true;
  data.meta.publication_ready = false;
  return { data, review: {
    publication_ready: false,
    history: history.review,
    historical_slot_projection: slotReview,
    source_sha256: history.provenance.workbook_sha256,
    historical_generated_at: history.generated_at,
    counts: Object.fromEntries(Object.entries(tables).map(([key, rows]) => [key, rows.length])),
    finalized_matches: [...latest.values()].map(item => ({ match: item.tables.matches[0].match_id, revision: item.tables.matches[0].revision, provenance: item.provenance ?? null, review: item.review ?? null })),
    identity_labels: Object.fromEntries(labels),
    note: 'Review output only. No deployment or publication; physical phone acceptance, statistical decisions and source reconciliation remain required.',
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [historyPath, outputDir, ...additionPaths] = process.argv.slice(2);
    if (!historyPath || !outputDir) throw new Error('Usage: node standalone/statistics-preview.mjs historical.json output-directory [finalized-tables.json ...]');
    const dir = resolve(outputDir);
    const forbidden = [resolve('public'), resolve('testing'), resolve('testing-host/public')];
    if (forbidden.some(path => dir === path || dir.startsWith(path + '/'))) throw new Error('Use a separate review directory, not a deployed assets directory.');
    const read = path => JSON.parse(readFileSync(path, 'utf8'));
    const preview = statisticsPreview(read(historyPath), additionPaths.map(read));
    for (const [name, value] of Object.entries(preview)) {
      const path = resolve(dir, `${name}.json`);
      if ([historyPath, ...additionPaths].some(input => resolve(input) === path)) throw new Error('Output cannot overwrite an input.');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(value) + '\n');
    }
    console.log(JSON.stringify({ output: dir, ...preview.review.counts, publication_ready: false }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
