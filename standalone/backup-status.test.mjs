import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recoveryDB } from './test-db.mjs';
import { backupStatus, sourceWatermark, WATERMARK_SQL } from './backup-status.mjs';
import { recordBackupStatus, SOURCE_DATABASE, ensureMegaFolder, MEGA_PATH, shouldRunBackup } from './backup.mjs';

function fixture() {
  const { sqlite, DB } = recoveryDB();
  sqlite.exec(readFileSync(new URL('./migrations/0006_backup_status.sql', import.meta.url), 'utf8'));
  const fetcher = async (url, options) => {
    assert.ok(url.includes(`/database/${SOURCE_DATABASE}/query`));
    const { sql, params } = JSON.parse(options.body);
    sqlite.prepare(sql).run(...params);
    return Response.json({ success: true, result: [{ success: true }] });
  };
  return { sqlite, DB, fetcher };
}

test('durable status preserves last verification on failure/defer and detects exact newer revisions', async () => {
  const { sqlite, DB, fetcher } = fixture();
  try {
    const at = '2026-10-03T00:00:00.000Z';
    assert.equal((await backupStatus(DB, Date.parse(at))).lastVerified, null);
    const coverage = await sourceWatermark(sqlite.prepare(WATERMARK_SQL).get());
    await recordBackupStatus('secret', { status: 'verified', stage: 'complete', at,
      file: 'cricket-sg-beta-2026-10-03T00-00-00.000Z-aabbccdd.csgbackup', sha256: 'a'.repeat(64), bytes: 100, tableCount: 8, coverage,
      sql: 'private sql', session: 'private token' }, at, fetcher);
    let status = await backupStatus(DB, Date.parse(at));
    assert.equal(status.stale, false);
    assert.equal(status.newerCloudChanges, false);
    for (const outcome of ['running', 'failed', 'deferred']) {
      await recordBackupStatus('secret', { status: outcome, stage: 'export' }, '2026-10-03T01:00:00.000Z', fetcher);
      status = await backupStatus(DB, Date.parse(at));
      assert.equal(status.latest.status, outcome);
      assert.equal(status.lastVerified.at, at);
    }
    // An older job finishing late must not overwrite the latest attempt.
    await recordBackupStatus('secret', { status: 'failed', stage: 'setup' }, '2026-10-02T00:00:00.000Z', fetcher);
    assert.equal((await backupStatus(DB)).latest.status, 'deferred');
    sqlite.prepare("INSERT INTO matches(id,owner_email,owner_device,revision,snapshot,content_hash,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run('private-match-id', 'first@example.com', 'private-device', 1, '{}', 'content1', at);
    status = await backupStatus(DB, Date.parse(at) + 49 * 60 * 60 * 1000);
    assert.equal(status.newerCloudChanges, true);
    assert.equal(status.stale, true);
    const before = await sourceWatermark(sqlite.prepare(WATERMARK_SQL).get());
    sqlite.exec("UPDATE matches SET content_hash='content2'");
    const after = await sourceWatermark(sqlite.prepare(WATERMARK_SQL).get());
    assert.notEqual(before.sha256, after.sha256, 'hash detects changed content even when counts and revisions match');
    assert.doesNotMatch(JSON.stringify(status), /private|first@example|owner_device/);
  } finally { sqlite.close(); }
});

test('existing MEGA folder is accepted only after exact destination lookup succeeds', async () => {
  const calls = [];
  await ensureMegaFolder(async (command, args) => {
    calls.push([command, args]);
    if (command === 'mkdir') throw Error('already exists');
  });
  assert.deepEqual(calls, [['mkdir', ['-p', MEGA_PATH]], ['ls', [MEGA_PATH]]]);
  await assert.rejects(ensureMegaFolder(async () => { throw Error('destination unavailable'); }), /destination unavailable/);
  let creates = 0;
  await ensureMegaFolder(async command => { assert.equal(command, 'mkdir'); creates++; });
  assert.equal(creates, 1);
});


test('hourly preflight skips unchanged recent backups, but runs daily or when revisions change', async () => {
  const at = '2026-10-03T00:00:00.000Z', row = { matches: '[]', players: '[]' };
  const coverage = await sourceWatermark(row);
  let saved = null;
  const fetcher = async (_url, options) => {
    const { sql } = JSON.parse(options.body);
    return Response.json({ success: true, result: [{ success: true, results:
      sql.includes('last_verified') ? (saved ? [{ last_verified: JSON.stringify(saved) }] : []) : [row] }] });
  };
  const run = hours => shouldRunBackup('secret', { fetcher, now: Date.parse(at) + hours * 60 * 60 * 1000 });
  assert.equal(await run(1), true);
  saved = { status: 'verified', stage: 'complete', at, coverage,
    file: 'cricket-sg-beta-2026-10-03T00-00-00.000Z-aabbccdd.csgbackup', sha256: 'a'.repeat(64), bytes: 100, tableCount: 8 };
  assert.equal(await run(1), false);
  assert.equal(await run(24), true);
  row.matches = '[["new-match",1,0,"content",null]]';
  assert.equal(await run(1), true);
});
