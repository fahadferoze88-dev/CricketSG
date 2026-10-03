// These two directories define the backup's match/player coverage. Device-only edits are never included.
export const WATERMARK_SQL = `SELECT
 (SELECT json_group_array(json_array(id,revision,generation,content_hash,finalized_revision))
  FROM (SELECT id,revision,generation,content_hash,finalized_revision FROM matches ORDER BY id)) AS matches,
 (SELECT json_group_array(json_array(id,revision))
  FROM (SELECT id,revision FROM players ORDER BY id)) AS players`;

export async function sourceWatermark(row) {
  const matches = JSON.parse(row.matches), players = JSON.parse(row.players);
  const bytes = new TextEncoder().encode(JSON.stringify([matches, players]));
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  return { sha256: hash, matches: matches.length, players: players.length };
}

export function safeBackupReceipt(receipt, at = new Date().toISOString()) {
  const stages = ['setup', 'configuration', 'export', 'validation', 'encryption', 'mega-login', 'mega-folder', 'upload-verification', 'complete'];
  if (!['running', 'verified', 'deferred', 'failed'].includes(receipt.status) || !stages.includes(receipt.stage) ||
      !Number.isFinite(Date.parse(at))) throw Error('Invalid backup receipt status.');
  const safe = { status: receipt.status, at, stage: receipt.stage };
  if (receipt.status === 'verified') {
    if (receipt.stage !== 'complete' || !/^cricket-sg-beta-[\dTZ.-]+-[a-f0-9]{8}\.csgbackup$/.test(receipt.file || '') ||
        !/^[a-f0-9]{64}$/.test(receipt.sha256 || '') || !Number.isSafeInteger(receipt.bytes) || receipt.bytes <= 0 ||
        !Number.isSafeInteger(receipt.tableCount) || receipt.tableCount < 8) throw Error('Invalid verified backup receipt.');
    Object.assign(safe, { file: receipt.file, bytes: receipt.bytes, sha256: receipt.sha256, tableCount: receipt.tableCount });
    if (receipt.coverage !== undefined) {
      const value = receipt.coverage;
      if (!/^[a-f0-9]{64}$/.test(value?.sha256 || '') || !Number.isSafeInteger(value.matches) || value.matches < 0 ||
          !Number.isSafeInteger(value.players) || value.players < 0) throw Error('Invalid backup coverage.');
      safe.coverage = { sha256: value.sha256, matches: value.matches, players: value.players };
    }
  }
  return safe;
}

export const STATUS_WRITE_SQL = `INSERT INTO backup_status(id,attempted_at,status,latest_receipt,last_verified)
 VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET attempted_at=excluded.attempted_at,
 status=excluded.status,latest_receipt=excluded.latest_receipt,
 last_verified=coalesce(excluded.last_verified,backup_status.last_verified)
 WHERE excluded.attempted_at >= backup_status.attempted_at`;

export async function backupStatus(DB, now = Date.now()) {
  const row = await DB.prepare('SELECT latest_receipt,last_verified FROM backup_status WHERE id = ?').bind(1).first();
  const latest = row ? safeBackupReceipt(JSON.parse(row.latest_receipt), JSON.parse(row.latest_receipt).at) : null;
  const saved = row?.last_verified ? JSON.parse(row.last_verified) : null;
  const verified = saved ? safeBackupReceipt(saved, saved.at) : null;
  const current = await sourceWatermark(await DB.prepare(WATERMARK_SQL).bind().first());
  return { latest, lastVerified: verified, checkedAt: new Date(now).toISOString(),
    stale: !verified || now - Date.parse(verified.at) > 48 * 60 * 60 * 1000,
    newerCloudChanges: verified?.coverage ? verified.coverage.sha256 !== current.sha256 : null,
    coverage: 'Cloud match and player revisions only; device-only changes are not in this backup.' };
}
