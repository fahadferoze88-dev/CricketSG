# Cricket SG scorer and statistics integration

The protected scorer uses Cloudflare Workers and D1. Its browser saves scoring actions in IndexedDB before acknowledging a device save, then uploads checkpoints. The Vercel dashboard can display a separate statistics review snapshot at `?stats=review`. These services run independently of a local computer or OpenClaw.

## Source and validation

- `../testing/`: scorer interface, offline shell, recovery and shared scoring rules.
- `worker.mjs`, `players.mjs`, `matches.mjs`: authenticated scorer APIs, player identities and immutable correction/finalization history.
- `history.json.gz`, `history-source.json`, `player-baseline.json`: pinned historical review data and permanent player identities. Preserve the recorded hashes and IDs.
- `publish-statistics.mjs`, `public-stats-worker.mjs`: validated finalized-match projection and read-only public review data.
- `backup.mjs`: D1 SQL export, authenticated encryption, MEGA round-trip verification and parameterized restoration.

Use Node.js 24 or later:

```sh
npm ci --prefix standalone
npm test --prefix standalone
npm run build
```

The Python importer tests additionally require the original approved workbook and companion export in the ignored `source-check/` directory. Those private source files are deliberately not included. The Node tests use checked-in fixtures and the pinned historical artifact; mocked D1 tests are not evidence of a real hosted restore.

## Deployment configuration

The two Wrangler configurations bind the scorer and statistics Worker to the beta D1 database. Use a reviewed Wrangler installation and verify the account/database targets before deploying. Apply migrations `0001`–`0005` in order. The scorer serves assets directly from `../testing/`; the statistics Worker has no scorer assets or write endpoint.

Cloudflare Access must protect the scorer hostname. Configure the Access issuer and application audience to match `TEAM_DOMAIN` and `POLICY_AUD`; the Worker validates signed identity tokens. Provision approved scorers directly in D1 and the Access policy. Set `OWNER_EMAIL` privately as a Worker secret before deploying the scorer, for example with `wrangler secret put OWNER_EMAIL --config standalone/wrangler.jsonc`. No real scorer email or seed SQL is committed. Without that secret, player-management privileges remain disabled.

## Hosted jobs and current status

The `cricket-statistics.yml` and `cricket-backup.yml` workflows accept **manual dispatch only**. Statistics publication writes the review channel; it does not replace the primary dashboard snapshot or the existing MEGA-to-dashboard sync. Historical review decisions and an explicit production cutover remain separate steps.

Configure `CLOUDFLARE_D1_BACKUP_TOKEN` in the `cricket-statistics-review` environment. The `cricket-backup` environment additionally requires `MEGA_BACKUP_SESSION` and `CRICKET_BACKUP_KEY`. Use a dedicated D1-scoped token; never copy a Wrangler OAuth cache into CI. The MEGA session has account-wide access. The encryption key must be a random 32-byte value encoded as base64, with an independent recovery copy outside GitHub and MEGA. Never commit these values or include them in logs.

Only encrypted archives are uploaded under `/CricketOps/db_backup/cricket-sg-beta`. The script defers a full export when recent scoring is detected because D1 exports can briefly block database requests. Failed backups do not block device scoring or finalization. Run receipts show verified, deferred or failed status; no automatic schedule or in-app backup-freshness indicator is active.

A manual encrypted MEGA round trip and isolated D1 restoration of the then-current database passed. That local drill does not establish unattended operation or real API restoration of future rows exceeding 1 MB. Verify both hosted jobs and the large-row cloud restore before relying on the complete automated recovery path. iPhone and Android acceptance was reported complete on 3 October 2026.
