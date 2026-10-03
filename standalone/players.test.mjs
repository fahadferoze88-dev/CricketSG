import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import { randomUUID } from 'node:crypto';
import { recoveryDB } from './test-db.mjs';
import { playerAPI } from './players.mjs';

test('player IDs survive retries, renames and reviewed merges; roles and revisions protect history', async () => {
  const { DB, sqlite } = recoveryDB();
  const env = { DB, OWNER_EMAIL: 'FIRST@example.com' };
  const call = (method, path = '', body, owner = false, headers = {}) => playerAPI(new Request(`https://beta.example/api/players${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), env, owner ? 'first@example.com' : 'second@example.com');
  const ali = { id: randomUUID(), name: 'Ali Rizvi', nickname: 'Ali' };
  assert.equal((await call('POST', '', ali)).status, 201);
  assert.equal((await call('POST', '', ali)).status, 200, 'retry does not create another player');
  assert.equal((await call('POST', '', { ...ali, name: 'Different person' })).status, 409);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM player_audit').get().n, 1);
  const sameName = { id: randomUUID(), name: 'Ali Rizvi', nickname: 'Junior' };
  let added = await (await call('POST', '', sameName)).json();
  assert.equal(added.player.reviewRequired, true, 'same names are permitted but need review');
  assert.deepEqual(added.warnings.map((row) => row.id), [ali.id]);
  const misspelling = { id: randomUUID(), name: 'Ali Rizvi', nickname: '' };
  const near = await (await call('POST', '', { ...misspelling, name: 'Ali Rizviq' })).json();
  assert.equal(near.player.reviewRequired, true);
  assert.equal(near.warnings.length, 2);
  const list = await (await call('GET')).json();
  assert.equal(list.players.length, 3);
  assert.equal(list.canManage, false);
  assert.equal((await (await call('GET', '', undefined, true)).json()).canManage, true);
  assert.equal((await call('PATCH', `/${ali.id}`, { revision: 1, name: 'Ali R', reason: 'Spelling' })).status, 403);
  assert.equal((await call('PATCH', `/${ali.id}`, { revision: 1, name: 'Ali R', reason: '' }, true)).status, 400);
  let changed = await (await call('PATCH', `/${ali.id}`, { revision: 1, name: 'Ali R', reason: 'Preferred spelling', actor_email: 'forged@example.com' }, true)).json();
  assert.equal(changed.player.revision, 2);
  assert.deepEqual(changed.player.aliases.map((row) => row.name), ['Ali R', 'Ali Rizvi']);
  assert.equal(sqlite.prepare('SELECT actor_email FROM player_audit WHERE player_id=? AND revision=2').get(ali.id).actor_email, 'first@example.com');
  assert.equal((await call('PATCH', `/${ali.id}`, { revision: 1, name: 'Stale edit', reason: 'Old screen' }, true)).status, 409);
  assert.equal((await call('POST', '', ali)).status, 200, 'retry of original creation still succeeds after owner rename');
  changed = await (await call('PATCH', `/${sameName.id}`, { revision: 1, reviewRequired: false, reason: 'Confirmed a different person' }, true)).json();
  assert.equal(changed.player.reviewRequired, false);
  assert.equal((await call('POST', `/${misspelling.id}/merge`, { targetId: ali.id, revision: 1, reason: 'Duplicate' })).status, 403);
  assert.equal((await call('POST', `/${misspelling.id}/merge`, { targetId: misspelling.id, revision: 1, reason: 'Duplicate' }, true)).status, 400);
  assert.equal((await call('POST', `/${misspelling.id}/merge`, { targetId: randomUUID(), revision: 1, reason: 'Duplicate' }, true)).status, 409);
  const merged = await (await call('POST', `/${misspelling.id}/merge`, { targetId: ali.id, revision: 1, reason: 'Confirmed duplicate profile' }, true)).json();
  assert.equal(merged.player.mergedInto, ali.id);
  assert.equal(merged.player.active, false);
  assert.equal(merged.target.id, ali.id);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM players').get().n, 3, 'merge retains source identity');
  assert.equal((await call('PATCH', `/${misspelling.id}`, { revision: 2, active: true, reason: 'Reactivate' }, true)).status, 409);
  assert.equal((await call('POST', `/${ali.id}/merge`, { targetId: misspelling.id, revision: 2, reason: 'Cycle' }, true)).status, 409);
  assert.equal((await call('PATCH', `/${ali.id}`, { revision: 2, active: false, reason: 'No longer attending' }, true)).status, 200);
  assert.equal((await call('PATCH', `/${ali.id}`, { revision: 3, active: true, reason: 'Returned' }, true)).status, 200);
  const oldNameAddition = await (await call('POST', '', { id: randomUUID(), name: 'Ali Rizviq' })).json();
  assert.equal(oldNameAddition.player.reviewRequired, true, 'aliases of merged profiles still suggest the surviving identity');
  assert.ok(oldNameAddition.warnings.some((row) => row.id === ali.id));
  assert.equal((await call('DELETE', `/${ali.id}`, undefined, true)).status, 405);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM matches').get().n, 0);
  sqlite.close();
});

test('player writes reject cross-origin, malformed and oversized input; audit failures roll back changes', async () => {
  const { DB, sqlite } = recoveryDB();
  const env = { DB, OWNER_EMAIL: 'first@example.com' };
  const call = (body, headers = {}, method = 'POST', path = '') => playerAPI(new Request(`https://beta.example/api/players${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }), env, 'first@example.com');
  const player = { id: randomUUID(), name: 'New Player', nickname: '' };
  assert.equal((await call(player, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(player, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await call(player, { 'Content-Type': 'text/plain' })).status, 400);
  assert.equal((await call({ ...player, padding: 'x'.repeat(4096) })).status, 400);
  for (const invalid of [null, [], { ...player, name: '  ' }, { ...player, name: 'x'.repeat(101) }, { ...player, name: 'a\u0000b' }, { ...player, id: 'not-uuid' }, { ...player, nickname: {} }]) {
    assert.equal((await call(invalid)).status, 400);
  }
  assert.equal((await call(player)).status, 201);
  sqlite.exec("CREATE TRIGGER fail_player_audit BEFORE INSERT ON player_audit WHEN NEW.revision > 1 BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
  await assert.rejects(() => call({ revision: 1, name: 'Changed', reason: 'Test audit atomicity' }, {}, 'PATCH', `/${player.id}`));
  assert.equal(sqlite.prepare('SELECT name FROM players WHERE id=?').get(player.id).name, 'New Player');
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM player_aliases').get().n, 1);
  sqlite.close();
});

test('offline player additions survive restarts, concurrent tabs and partial acknowledgements', async () => {
  const context = vm.createContext({ indexedDB: new IDBFactory(), crypto, structuredClone });
  vm.runInContext(readFileSync(new URL('../testing/storage.js', import.meta.url), 'utf8'), context);
  const first = await context.CricketStore.open();
  const second = await context.CricketStore.open();
  const p1 = { id: randomUUID(), name: 'First player', nickname: '' };
  const p2 = { id: randomUUID(), name: 'Second player', nickname: '' };
  await Promise.all([first.addPlayer(p1), second.addPlayer(p2)]);
  assert.equal((await first.players()).pending.length, 2);
  await first.cachePlayers({ players: [{ ...p1, revision: 1, active: true }], canManage: true }, [p1.id]);
  const pool = await second.players();
  assert.equal(pool.pending.length, 1);
  assert.equal(pool.pending[0].id, p2.id);
  assert.equal(pool.players.length, 2, 'refresh must retain a concurrent unsynced addition');
  await assert.rejects(() => first.addPlayer(p1));
  // Failure to cache a malformed server response aborts the transaction, retaining the outbox.
  await assert.rejects(() => first.cachePlayers({ players: null }, [p2.id]));
  assert.equal((await first.players()).pending.length, 1);
  const match = randomUUID();
  await first.save(match, 0, { test: true }, 0, true);
  await first.save(match, 1, { test: false });
  assert.equal((await first.get(match)).localOnly, true, 'recovery copies remain local through later saves');
  first.close(); second.close();
  const reopened = await context.CricketStore.open();
  assert.equal((await reopened.players()).pending[0].id, p2.id);
  await reopened.cachePlayers({ players: [{ ...p1, revision: 1 }, { ...p2, revision: 1 }], canManage: false }, [p2.id]);
  assert.equal((await reopened.players()).pending.length, 0);
  reopened.close();
});

test('concurrent near-name additions cannot both bypass identity review', async () => {
  const { DB, sqlite } = recoveryDB();
  const add = (name) => playerAPI(new Request('https://beta.example/api/players', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: randomUUID(), name }),
  }), { DB, OWNER_EMAIL: 'first@example.com' }, 'second@example.com');
  const responses = await Promise.all([add('Kashif'), add('Kashiff')]);
  for (const response of responses) assert.equal(response.status, 201);
  assert.ok(sqlite.prepare('SELECT sum(review_required) AS n FROM players').get().n >= 1);
  sqlite.close();
});
