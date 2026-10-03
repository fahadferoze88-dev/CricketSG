import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { readFile, writeFile, appendFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WATERMARK_SQL, STATUS_WRITE_SQL, sourceWatermark, safeBackupReceipt } from "./backup-status.mjs";

export const ACCOUNT = "590b0bb00c33381ac900eebd768a2641";
export const SOURCE_DATABASE = "ab93c103-3ba6-47c7-acc1-41e1695dc8df";
export const MEGA_PATH = "/CricketOps/db_backup/cricket-sg-beta";
const MAGIC = Buffer.from("CRICKETSG1\n");
const MAX_BYTES = 128 * 1024 * 1024;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ident = (name) => `"${name.replaceAll('"', '""')}"`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const execute = promisify(execFile);
const requiredTables = ["scorers", "players", "player_aliases", "player_audit", "matches", "match_actions", "match_handoffs", "match_finalizations"];
const requiredTriggers = ["match_actions_no_update", "match_actions_no_delete", "match_finalizations_no_update", "match_finalizations_no_delete"];

function keyBytes(encoded) {
  if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw Error("Backup key must be a base64-encoded random 32-byte key.");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) throw Error("Invalid backup key.");
  return key;
}

export function encryptBackup(payload, encodedKey) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(encodedKey), nonce);
  cipher.setAAD(MAGIC);
  const plain = Buffer.from(JSON.stringify(payload));
  if (plain.length > MAX_BYTES) throw Error("Backup exceeds the reviewed 128 MiB archive limit.");
  const encrypted = Buffer.concat([cipher.update(gzipSync(plain)), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted]);
}

export function decryptBackup(encrypted, encodedKey) {
  if (encrypted.length > MAX_BYTES || encrypted.length <= MAGIC.length + 28 || !encrypted.subarray(0, MAGIC.length).equals(MAGIC)) throw Error("Invalid backup envelope.");
  const offset = MAGIC.length;
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(encodedKey), encrypted.subarray(offset, offset + 12));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(encrypted.subarray(offset + 12, offset + 28));
  let plain;
  try { plain = Buffer.concat([decipher.update(encrypted.subarray(offset + 28)), decipher.final()]); }
  catch { throw Error("Backup authentication failed; wrong key or damaged archive."); }
  const payload = JSON.parse(gunzipSync(plain, { maxOutputLength: MAX_BYTES }).toString("utf8"));
  if (payload.format !== 1 || payload.account !== ACCOUNT || payload.database !== SOURCE_DATABASE ||
      typeof payload.sql !== "string" || sha256(payload.sql) !== payload.sqlSha256) throw Error("Backup manifest does not match its database export.");
  return payload;
}

export function inspectSQL(sql) {
  if (typeof sql !== "string" || Buffer.byteLength(sql) > MAX_BYTES) throw Error("Database export is invalid or too large.");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(sql);
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" || db.prepare("PRAGMA foreign_key_check").all().length) throw Error("Restored database failed integrity checks.");
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid").all();
    for (const name of requiredTables) if (!schema.some((item) => item.type === "table" && item.name === name)) throw Error("Export is missing a required Cricket SG table.");
    for (const name of requiredTriggers) if (!schema.some((item) => item.type === "trigger" && item.name === name)) throw Error("Export is missing immutable-audit protections.");
    if (schema.some((item) => item.type === "table" && item.name === "public_statistics") &&
        !schema.some((item) => item.type === "trigger" && item.name === "public_statistics_monotonic")) throw Error("Export is missing statistics version protection.");
    const counts = Object.fromEntries(schema.filter((item) => item.type === "table").map(({ name }) => [name, db.prepare(`SELECT count(*) AS n FROM ${ident(name)}`).get().n]));
    return { db, schema, counts };
  } catch (error) { db.close(); throw error; }
}

// Data stays in bound parameters: a 1 MiB match row never becomes a 1 MiB SQL statement.
export function restorePlan(sql) {
  const { db, schema, counts } = inspectSQL(sql);
  try {
    const tables = schema.filter((item) => item.type === "table");
    const tableMap = new Map(tables.map((table) => [table.name, table]));
    const ordered = [], visited = new Set(), visiting = new Set();
    const dependencies = (table) => db.prepare(`PRAGMA foreign_key_list(${ident(table)})`).all();
    function visit(name) {
      if (visited.has(name)) return;
      if (visiting.has(name)) throw Error("Cyclic table dependencies require a reviewed restore migration.");
      visiting.add(name);
      for (const link of dependencies(name)) if (link.table !== name && tableMap.has(link.table)) visit(link.table);
      visiting.delete(name); visited.add(name); ordered.push(tableMap.get(name));
    }
    for (const table of tables) visit(table.name);
    const operations = tables.map(({ sql }) => ({ sql, params: [] }));
    for (const table of ordered) {
      const columns = db.prepare(`PRAGMA table_info(${ident(table.name)})`).all().map((column) => column.name);
      const rows = db.prepare(`SELECT * FROM ${ident(table.name)}`).all();
      const selfLinks = dependencies(table.name).filter((link) => link.table === table.name);
      const rowOrder = [], done = new Set(), pending = new Set();
      function visitRow(row) {
        if (done.has(row)) return;
        if (pending.has(row)) throw Error("Cyclic player identities require review before restoring.");
        pending.add(row);
        for (const link of selfLinks) {
          if (row[link.from] === null) continue;
          // ponytail: a few hundred player rows; index parent keys if this directory grows substantially.
          const parent = rows.find((candidate) => candidate[link.to] === row[link.from]);
          if (parent && parent !== row) visitRow(parent);
        }
        pending.delete(row); done.add(row); rowOrder.push(row);
      }
      for (const row of rows) visitRow(row);
      const insert = `INSERT INTO ${ident(table.name)} (${columns.map(ident).join(",")}) VALUES (${columns.map(() => "?").join(",")})`;
      for (const row of rowOrder) operations.push({ sql: insert, params: columns.map((column) => {
        if (row[column] instanceof Uint8Array) throw Error("Binary database columns need a reviewed restore encoding.");
        return row[column];
      }) });
    }
    // Load the audited rows first. Triggers installed before insertion would fabricate duplicate audit entries.
    operations.push(...schema.filter((item) => item.type !== "table").map(({ sql }) => ({ sql, params: [] })));
    if (operations.some((operation) => Buffer.byteLength(operation.sql) >= 100_000 || operation.params.length > 100)) throw Error("A restore operation exceeds D1 statement limits.");
    return { operations, counts };
  } finally { db.close(); }
}

export async function cloudRequest(token, database, route, body, fetcher = fetch) {
  const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${database}/${route}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  }).catch(() => { throw Object.assign(Error("Cloudflare request could not complete."), { retryable: true }); });
  if (!response.ok) throw Object.assign(Error(`Cloudflare ${route} failed (HTTP ${response.status}).`), { retryable: response.status === 429 || response.status >= 500 });
  const data = await response.json();
  if (!data.success || (Array.isArray(data.result) && data.result.some((result) => result.success === false))) throw Error(`Cloudflare ${route} did not succeed.`);
  return data.result;
}

// Only read operations call this. Never automatically replay an uncertain restore write or initial export.
async function retryRead(operation, sleep) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!error.retryable || attempt === 2) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

export async function exportSQL(token, { fetcher = fetch, sleep = delay, attempts = 60 } = {}) {
  const active = await retryRead(() => cloudRequest(token, SOURCE_DATABASE, "query", {
    sql: "SELECT count(*) AS n FROM matches WHERE coalesce(json_extract(snapshot,'$.matchStatus'),'playing') = 'playing' AND updated_at > ?",
    params: [new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()],
  }, fetcher), sleep);
  if (active[0]?.results?.[0]?.n !== 0) throw Object.assign(Error("Full backup deferred: a match has recent scoring activity. Retry in an idle window."), { code: "SCORING_ACTIVE" });
  let bookmark;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const poll = () => cloudRequest(token, SOURCE_DATABASE, "export", { output_format: "polling", ...(bookmark ? { current_bookmark: bookmark } : {}) }, fetcher);
    const result = await (bookmark ? retryRead(poll, sleep) : poll());
    if (result.error || result.status === "error") throw Error("Cloudflare database export failed.");
    bookmark = result.at_bookmark || bookmark;
    if (result.status === "complete") {
      const url = new URL(result.result?.signed_url);
      if (url.protocol !== "https:") throw Error("The export download must use HTTPS.");
      // A signed download URL is already authorized; never forward the Cloudflare bearer token.
      const sql = await retryRead(async () => {
        const response = await fetcher(url, { signal: AbortSignal.timeout(60_000), redirect: "error" })
          .catch(() => { throw Object.assign(Error("Export download could not complete."), { retryable: true }); });
        if (!response.ok) throw Object.assign(Error("Export download failed."), { retryable: response.status === 429 || response.status >= 500 });
        if (Number(response.headers.get("content-length")) > MAX_BYTES) throw Error("Export exceeds the backup size limit.");
        const chunks = []; let bytes = 0;
        try {
          for await (const chunk of response.body) {
            bytes += chunk.length;
            if (bytes > MAX_BYTES) throw Object.assign(Error("Database export exceeds the backup size limit."), { code: "TOO_LARGE" });
            chunks.push(chunk);
          }
        } catch (error) {
          if (error.code === "TOO_LARGE") throw error;
          throw Object.assign(Error("Export download was interrupted."), { retryable: true });
        }
        return Buffer.concat(chunks).toString("utf8");
      }, sleep);
      return { sql, bookmark };
    }
    if (!bookmark) throw Error("Export did not supply a polling bookmark.");
    await sleep(1000);
  }
  throw Error("Database export timed out; backup remains incomplete.");
}

export async function backupSources() {
  const files = ["standalone/worker.mjs", "standalone/matches.mjs", "standalone/players.mjs", "standalone/backup.mjs",
    "standalone/package.json", "standalone/package-lock.json", "standalone/wrangler.jsonc", "standalone/README.md",
    "standalone/player-baseline.json", "standalone/import_history.py", "standalone/history-source.json",
    "standalone/statistics-preview.mjs", "standalone/finalized-stats.mjs", "standalone/public-stats-worker.mjs", "standalone/wrangler-stats.jsonc",
    "standalone/publish-statistics.mjs", "standalone/backup-status.mjs", "scripts/download-mega-data.cjs"];
  for (const name of await readdir(join(root, "standalone/migrations"))) if (/^\d+_[a-z_]+\.sql$/.test(name)) files.push(`standalone/migrations/${name}`);
  for (const name of await readdir(join(root, "testing"))) if (/^[a-z-]+\.(?:js|mjs|html|css|json)$/.test(name)) files.push(`testing/${name}`);
  const sources = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(join(root, file), "utf8")])));
  const history = await readFile(join(root, "standalone/history.json.gz"));
  sources["standalone/history.json.gz"] = { encoding: "base64", sha256: sha256(history), content: history.toString("base64") };
  return sources;
}

async function mega(command, args) {
  const env = { ...process.env };
  for (const name of ["CLOUDFLARE_D1_BACKUP_TOKEN", "MEGA_BACKUP_SESSION", "CRICKET_BACKUP_KEY"]) delete env[name];
  try { return await execute(`mega-${command}`, args, { env, timeout: 120_000, maxBuffer: 1024 * 1024 }); }
  catch { throw Error(`MEGA ${command} failed. Backup was not acknowledged.`); }
}

export async function uploadAndVerify(encrypted, key, local, { runMega = mega, sleep = delay } = {}) {
  const remote = `${MEGA_PATH}/${local.split(/[\\/]/).at(-1)}`;
  // A failed upload response is ambiguous: verify that exact name before considering the run failed.
  // Never replay put automatically: MEGA can create duplicate names after a lost acknowledgement.
  try { await runMega("put", [local, remote]); } catch { /* The download below resolves an uncertain upload. */ }
  const downloaded = join(dirname(local), "roundtrip.csgbackup");
  for (let attempt = 0; attempt < 3; attempt++) {
    await rm(downloaded, { force: true });
    try { await runMega("get", [remote, downloaded]); }
    catch {
      if (attempt === 2) throw Error("MEGA round-trip download failed; uploaded backup remains unverified.");
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const roundtrip = await readFile(downloaded);
    if (sha256(roundtrip) !== sha256(encrypted)) throw Error("Uploaded backup checksum did not match.");
    decryptBackup(roundtrip, key);
    return;
  }
}

export async function writeBackupReceipt(receipt, { summaryPath = process.env.GITHUB_STEP_SUMMARY, log = console.log } = {}) {
  const safe = safeBackupReceipt(receipt);
  const json = JSON.stringify(safe);
  if (summaryPath) await appendFile(summaryPath, `### Cricket SG encrypted backup\n\n\`\`\`json\n${json}\n\`\`\`\n\n${safe.status === "verified" ? "Ciphertext was downloaded again, checksum matched, and decryption succeeded. This receipt does not establish that a real D1 restore has passed." : "No new backup was verified by this run. Existing archives were kept. Retry manually in an idle window after resolving the failed stage."}\n`);
  log(json);
  return safe;
}

export async function recordBackupStatus(token, receipt, attemptedAt, fetcher = fetch) {
  const safe = safeBackupReceipt(receipt, receipt.at || new Date().toISOString());
  if (!Number.isFinite(Date.parse(attemptedAt))) throw Error("Invalid backup attempt time.");
  await cloudRequest(token, SOURCE_DATABASE, "query", { sql: STATUS_WRITE_SQL,
    params: [attemptedAt, safe.status, JSON.stringify(safe), safe.status === "verified" ? JSON.stringify(safe) : null] }, fetcher);
  return safe;
}

export async function shouldRunBackup(token, { fetcher = fetch, now = Date.now() } = {}) {
  const result = await cloudRequest(token, SOURCE_DATABASE, "query", {
    sql: "SELECT last_verified FROM backup_status WHERE id = ?", params: [1],
  }, fetcher);
  const saved = result[0]?.results?.[0]?.last_verified;
  if (!saved) return true;
  const receipt = JSON.parse(saved), verified = safeBackupReceipt(receipt, receipt.at);
  if (verified.status !== "verified" || !verified.coverage || now - Date.parse(verified.at) >= 24 * 60 * 60 * 1000) return true;
  const current = await cloudRequest(token, SOURCE_DATABASE, "query", { sql: WATERMARK_SQL, params: [] }, fetcher);
  return verified.coverage.sha256 !== (await sourceWatermark(current[0].results[0])).sha256;
}

export async function ensureMegaFolder(runMega = mega) {
  try { await runMega("mkdir", ["-p", MEGA_PATH]); }
  catch {
    // MEGAcmd returns an error for an existing folder. Resolve that exact destination before proceeding.
    await runMega("ls", [MEGA_PATH]);
  }
}

export async function backup() {
  let directory, stage = "configuration";
  const attemptedAt = new Date().toISOString(), token = process.env.CLOUDFLARE_D1_BACKUP_TOKEN;
  try {
    if (token) await recordBackupStatus(token, { status: "running", stage }, attemptedAt);
    const session = process.env.MEGA_BACKUP_SESSION, key = process.env.CRICKET_BACKUP_KEY;
    if (!token || !session) throw Error("Hosted Cloudflare and MEGA backup credentials are required.");
    keyBytes(key);
    directory = await mkdtemp(join(tmpdir(), "cricket-backup-"));
    stage = "export";
    const { sql, bookmark } = await exportSQL(token);
    stage = "validation";
    const { db, counts } = inspectSQL(sql);
    let coverage;
    try { coverage = await sourceWatermark(db.prepare(WATERMARK_SQL).get()); } finally { db.close(); }
    restorePlan(sql); // A successful download alone does not establish recoverability.
    const payload = { format: 1, createdAt: new Date().toISOString(), account: ACCOUNT, database: SOURCE_DATABASE,
      bookmark, commit: process.env.GITHUB_SHA || null, sqlSha256: sha256(sql), counts, sql, sources: await backupSources() };
    stage = "encryption";
    const encrypted = encryptBackup(payload, key);
    const filename = `cricket-sg-beta-${payload.createdAt.replaceAll(":", "-")}-${randomBytes(4).toString("hex")}.csgbackup`;
    const local = join(directory, filename);
    await writeFile(local, encrypted, { mode: 0o600 });
    stage = "mega-login";
    await mega("login", [session]);
    stage = "mega-folder";
    await ensureMegaFolder();
    stage = "upload-verification";
    await uploadAndVerify(encrypted, key, local);
    // Fixed destination and safe counts only. Never emit SQL, signed URLs, credentials or account session details.
    const receipt = await writeBackupReceipt({ status: "verified", stage: "complete", file: filename, bytes: encrypted.length, sha256: sha256(encrypted), tableCount: Object.keys(counts).length, coverage });
    await recordBackupStatus(token, receipt, attemptedAt);
    return receipt;
  } catch (error) {
    const deferred = error.code === "SCORING_ACTIVE";
    const receipt = await writeBackupReceipt({ status: deferred ? "deferred" : "failed", stage });
    if (token) {
      try { await recordBackupStatus(token, receipt, attemptedAt); }
      catch { console.error("Backup status could not be saved. Check this workflow run; the previous verified receipt was kept."); }
    }
    // Raw network/SQLite/MEGAcmd errors can contain private URLs or row values; emit only a fixed stage.
    throw Error(deferred ? "Full backup deferred because scoring is active. Retry in an idle window." : `Backup did not complete during ${stage}. Existing archives were kept.`);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    // Do not mega-logout: it would revoke the reusable hosted session. Runner destruction removes its cache.
  }
}

export async function restoreD1(payload, target, token, fetcher = fetch) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target || "") || target.toLowerCase() === SOURCE_DATABASE) throw Error("Restore requires a different, empty D1 database.");
  const { operations, counts } = restorePlan(payload.sql);
  const existing = await cloudRequest(token, target, "query", { sql: "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'", params: [] }, fetcher);
  if (!Array.isArray(existing[0]?.results) || existing[0].results.length) throw Error("Restore target is not empty. Existing data was kept.");
  // The target is disposable until all checks pass; a partial failure never affects the source database.
  for (const operation of operations) await cloudRequest(token, target, "query", operation, fetcher);
  for (const [table, count] of Object.entries(counts)) {
    const result = await cloudRequest(token, target, "query", { sql: `SELECT count(*) AS n FROM ${ident(table)}`, params: [] }, fetcher);
    if (result[0]?.results?.[0]?.n !== count) throw Error("Restored table count does not match the manifest.");
  }
  const integrity = await cloudRequest(token, target, "query", { sql: "PRAGMA foreign_key_check", params: [] }, fetcher);
  if (!Array.isArray(integrity[0]?.results) || integrity[0].results.length) throw Error("Restored foreign keys failed validation.");
  return { tables: Object.keys(counts).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  try {
    const [command = "backup", archive, target] = process.argv.slice(2);
    if (command === "backup") await backup();
    else if (command === "should-run") {
      if (!process.env.CLOUDFLARE_D1_BACKUP_TOKEN) throw Error("Cloudflare status token is required.");
      const needed = await shouldRunBackup(process.env.CLOUDFLARE_D1_BACKUP_TOKEN);
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `needed=${needed}\n`);
      console.log(JSON.stringify({ needed }));
    }
    else if (command === "failure-status") {
      if (!process.env.CLOUDFLARE_D1_BACKUP_TOKEN) throw Error("Cloudflare status token is required.");
      const receipt = await writeBackupReceipt({ status: "failed", stage: "setup" });
      await recordBackupStatus(process.env.CLOUDFLARE_D1_BACKUP_TOKEN, receipt, receipt.at);
    }
    else if (["verify", "restore"].includes(command) && archive) {
      const payload = decryptBackup(await readFile(archive), process.env.CRICKET_BACKUP_KEY);
      if (command === "verify") { const { db, counts } = inspectSQL(payload.sql); db.close(); restorePlan(payload.sql); console.log(JSON.stringify({ verified: true, tableCount: Object.keys(counts).length })); }
      else {
        if (!process.env.CLOUDFLARE_D1_BACKUP_TOKEN) throw Error("Cloudflare restore token is required.");
        console.log(JSON.stringify(await restoreD1(payload, target, process.env.CLOUDFLARE_D1_BACKUP_TOKEN)));
      }
    } else throw Error("Use: backup.mjs backup | should-run | failure-status | verify ARCHIVE | restore ARCHIVE EMPTY_DATABASE_ID");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
