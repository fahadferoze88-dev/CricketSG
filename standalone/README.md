# Cricket SG scorer and statistics integration

The protected scorer uses Cloudflare Workers and D1. Its browser saves scoring actions in IndexedDB before acknowledging a device save, then uploads checkpoints. The Vercel dashboard reads the approved primary statistics snapshot. A separate review snapshot remains available at `?stats=review`. These services run independently of a local computer or OpenClaw.

## Source and validation

- `../testing/`: scorer interface, offline shell, recovery and shared scoring rules.
- `worker.mjs`, `players.mjs`, `matches.mjs`: authenticated scorer APIs, player identities and immutable correction/finalization history.
- `history.json.gz`, `history-source.json`, `player-baseline.json`: pinned historical review data and permanent player identities. Preserve the recorded hashes and IDs.
- `publish-statistics.mjs`, `public-stats-worker.mjs`: validated finalized-match projection and read-only public statistics.
- `backup.mjs`: D1 SQL export, authenticated encryption, MEGA round-trip verification and parameterized restoration.

Use Node.js 24 or later:

```sh
npm ci --prefix standalone
npm test --prefix standalone
npm run build
```

The Python importer tests additionally require the original approved workbook and companion export in the ignored `source-check/` directory. Those private source files are deliberately not included. The Node tests use checked-in fixtures and the pinned historical artifact; mocked D1 tests are not evidence of a real hosted restore.

## Deployment configuration

The two Wrangler configurations bind the scorer and statistics Worker to the beta D1 database. Use a reviewed Wrangler installation and verify the account/database targets before deploying. Apply migrations `0001`–`0006` in order. The scorer serves assets directly from `../testing/`; the statistics Worker has no scorer assets or write endpoint.

Cloudflare Access must protect the scorer hostname. Configure the Access issuer and application audience to match `TEAM_DOMAIN` and `POLICY_AUD`; the Worker validates signed identity tokens. Provision approved scorers directly in D1 and the Access policy. Set `OWNER_EMAIL` privately as a Worker secret before deploying the scorer, for example with `wrangler secret put OWNER_EMAIL --config standalone/wrangler.jsonc`. No real scorer email or seed SQL is committed. Without that secret, player-management privileges remain disabled.

## Hosted jobs and current status

The statistics workflow checks immutable finalized match revisions hourly and atomically updates the primary channel. Manual dispatch can select review instead. Approval is pinned to the historical artifact, Season 8 (2026) and the recorded appearance-count decision. Ammar's historical career count remains 28; the disputed fielding record and catch remain present with a visible review note. Unfinalized checkpoints never enter statistics. The old MEGA-to-dashboard workflow is now manual-only.

The backup workflow checks hourly. It exports when cloud match/player revisions have changed or the last verified archive is at least 24 hours old. Unchanged checks skip MEGA installation and upload. GitHub schedules can be delayed or disabled after prolonged repository inactivity; the owner panel flags backups older than 48 hours. Keep the repository's scheduled workflows enabled.

Configure `CLOUDFLARE_D1_BACKUP_TOKEN` in the `cricket-statistics-review` environment. The `cricket-backup` environment additionally requires `MEGA_BACKUP_SESSION` and `CRICKET_BACKUP_KEY`. Use a dedicated D1-scoped token; never copy a Wrangler OAuth cache into CI. The MEGA session has account-wide access. The encryption key must be a random 32-byte value encoded as base64, with an independent recovery copy outside GitHub and MEGA. Never commit these values or include them in logs.

Only encrypted archives are uploaded under `/CricketOps/db_backup/cricket-sg-beta`. The script defers a full export when recent scoring is detected because D1 exports can briefly block database requests. Failed backups do not block device scoring or finalization. D1 retains the latest attempt and last verified receipt. The owner-only setup panel shows backup time, stale status and whether newer cloud match/player revisions are pending. Device-only changes are never implied to be backed up. Previous archives are retained; no automatic deletion is enabled.

Hosted encrypted upload/download/decryption passed in run `37103685152`; the downloaded archive also restored locally with 11 tables. An earlier real cloud restore matched the database contents, and isolated hosted run `37102053909` verified three bound values exceeding 1 MB plus audit protections through D1's API. iPhone and Android acceptance was reported complete on 3 October 2026.

To restore, retain the relevant recovery key, download an encrypted archive, and run `node standalone/backup.mjs verify ARCHIVE`. For a cloud drill use `restore ARCHIVE EMPTY_DATABASE_UUID` with the D1 token; the tool rejects the live source and nonempty targets. Verify the isolated result before any separate production recovery decision. Do not delete old archives or rotate away a key still needed to decrypt them.
