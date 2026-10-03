import test from 'node:test';
import assert from 'node:assert/strict';
import { statisticsPreview } from './statistics-preview.mjs';
import converter from '../scripts/download-mega-data.cjs';
const player = (id, name) => ({ player_id: id, name });
function history() {
  return { generated_at: '2026-09-06T00:00:00Z', season: 'S8_2026', provenance: { workbook_sha256: 'fixture' }, review: { publication_ready: false }, tables: {
    players: [player('a', 'Ali L'), player('b', 'Ali\u00a0L')],
    matches: [{ match_id: 'old', date: '20260828', season: 'S8_2026', winning_captain: 'Ali L', winning_captain_id: 'a', winner_player_runs: 9 }],
    batting: [{ match_id: 'old', player_id: 'a', name: 'Ali L', runs: 9, balls_faced: 3, team_slot: 'Team 1' }, { match_id: 'old', player_id: 'b', name: 'Ali\u00a0L', runs: 2, balls_faced: 3, team_slot: 'Team 2' }], bowling: [], fielding: [],
  } };
}
function addition(revision, runs) {
  return { season: 'S8_2026', generated_at: '2026-09-29T00:00:00Z', tables: { players: [player('a', 'Ali L')], matches: [{ match_id: 'new', revision, date: '20260929', season: 'S8_2026', slot1_total: runs, slot2_total: 0, slot1_leg_byes: 2, slot1_run_out_penalty: -5, slot2_leg_byes: 0, slot2_run_out_penalty: 0 }], batting: [{ match_id: 'new', player_id: 'a', name: 'Ali L', team_slot: 'Team 1', runs, balls_faced: 1 }], bowling: [{ match_id: 'new', player_id: 'a', name: 'Ali L', team_slot: 'Team 2', runs: runs + 3, balls: 1 }], fielding: [] } };
}
test('preview preserves unknown historical totals, captain and distinct player identities', () => {
  const { data, review } = statisticsPreview(history());
  assert.equal(data.matches[0].has_true_totals, false);
  assert.equal(data.matches[0].winner_player_runs, 9);
  assert.equal(data.matches[0].winning_captain, 'Ali L [a]');
  assert.equal(data.views.recent_days.length, 1);
  assert.equal(Object.keys(data.views.player_records).length, 2);
  assert.equal(review.publication_ready, false);
});
test('latest revision replaces all old match performances; conflicts reject', () => {
  const old = addition(1, 3), corrected = addition(2, 8);
  const { data, review } = statisticsPreview(history(), [corrected, old, corrected]);
  assert.equal(review.counts.matches, 2);
  assert.equal(review.counts.batting, 3);
  const current = data.views.recent_days.at(-1).matches[0];
  assert.equal(current.team_totals['Team 1'], 8);
  assert.equal(current.innings[0].bowling_leg_byes, 2);
  assert.equal(current.innings[0].bowling_run_outs, -5);
  assert.throws(() => statisticsPreview(history(), [old, addition(1, 9)]), /Conflicting/);
  const collision = addition(3, 8); collision.tables.matches[0].match_id = 'old';
  assert.throws(() => statisticsPreview(history(), [collision]), /collision/);
  const unknown = history(); unknown.tables.batting[0].player_id = 'missing';
  assert.throws(() => statisticsPreview(unknown), /Unknown player/);
});
test('default converter keeps old recent-match inclusion behavior and handles special names', () => {
  const source = history();
  assert.equal(converter.convertTablesExport(source).views.recent_days.length, 0);
  source.tables.players[0].name = 'constructor'; source.tables.batting[0].name = 'constructor';
  assert.doesNotThrow(() => converter.convertTablesExport(source));
});
test('historical bowling slots follow proven own-team membership, without changing source', () => {
  const source = history();
  source.tables.matches[0].losing_captain = 'Ali\u00a0L';
  source.tables.matches[0].losing_captain_id = 'b';
  source.tables.bowling.push({ match_id: 'old', player_id: 'b', name: 'Ali\u00a0L', team_slot: 'Team 1', balls: 6, runs: 9, wides: 2 });
  const { data, review } = statisticsPreview(source);
  const match = data.views.recent_days[0].matches[0];
  assert.equal(match.bowling[0].team_slot, 'Team 2');
  assert.equal(match.bowling[0].extras, 2);
  assert.equal(match.winner_slot, 'Team 1');
  assert.equal(match.has_true_totals, false);
  assert.equal(review.historical_slot_projection.changed, 1);
  assert.equal(source.tables.bowling[0].team_slot, 'Team 1');
});

test('unknown boundary figures remain unknown and mixed season input rejects', () => {
  const source = history(); source.tables.batting[0].fours = null;
  assert.equal(statisticsPreview(source).data.views.player_records['Ali L [a]'].batting.fours, null);
  const added = addition(1, 8); added.season = 'S9_2027';
  assert.throws(() => statisticsPreview(source, [added]), /season/);
  const valid = statisticsPreview(source, [addition(1, 8)]);
  assert.equal(valid.data.meta.generated_at, '2026-09-29T00:00:00Z');
});
