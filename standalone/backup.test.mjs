import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recoveryDB } from "./test-db.mjs";
import { ACCOUNT, SOURCE_DATABASE, MEGA_PATH, encryptBackup, decryptBackup, inspectSQL, restorePlan, restoreD1, exportSQL, uploadAndVerify, writeBackupReceipt, backupSources } from "./backup.mjs";

const checksum = (text) => createHash("sha256").update(text).digest("hex");
const quote = (value) => value === null ? "NULL" : typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`;
function fixture() {
  const { sqlite } = recoveryDB();
  sqlite.exec(readFileSync(new URL("./migrations/0005_statistics.sql", import.meta.url), "utf8"));
  const publicJSON = JSON.stringify({ players: [{ name: randomBytes(800_000).toString("base64") }] });
  const compressed = gzipSync(publicJSON), publicStats = compressed.toString("base64");
  sqlite.prepare("INSERT INTO public_statistics VALUES(?,?,?,?,?,?)")
    .run("review", 1, "2026-09-30T00:00:00.000Z", checksum(compressed), publicStats, "{}");
  const ids = [randomUUID(), randomUUID()];
  const large = JSON.stringify({ recovery: "x".repeat(1_100_000), note: "O'Brien\nUnicode naïve 🏏" });
  for (const [index, id] of ids.entries()) sqlite.prepare(`INSERT INTO players
    (id,name,normalized_name,creation_payload,created_at,updated_at,updated_by,reason) VALUES(?,?,?,?,?,?,?,?)`)
    .run(id, `Player ${index}`, `player ${index}`, "{}", "2026-09-29", "2026-09-29", "first@example.com", "QA seed");
  sqlite.prepare("UPDATE players SET merged_into=?,active=0,revision=revision+1 WHERE id=?").run(ids[1], ids[0]);
  sqlite.prepare("INSERT INTO matches(id,owner_email,owner_device,revision,snapshot,content_hash,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run(randomUUID(), "first@example.com", randomUUID(), 1, large, checksum(large), "2026-09-29");
  sqlite.exec("UPDATE matches SET finalized_revision=1,finalized_at='2026-09-29',finalized_by='first@example.com'");
  sqlite.exec("INSERT INTO match_actions SELECT id,'qa-action',1,owner_email,owner_device,'{}',updated_at FROM matches");
  const schema = sqlite.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
  const pieces = ["PRAGMA foreign_keys=OFF;"];
  for (const table of schema.filter((item) => item.type === "table")) {
    pieces.push(`${table.sql};`);
    for (const row of sqlite.prepare(`SELECT * FROM "${table.name}"`).all()) pieces.push(`INSERT INTO "${table.name}" VALUES(${Object.values(row).map(quote).join(",")});`);
  }
  pieces.push(...schema.filter((item) => item.type !== "table").map((item) => `${item.sql};`));
  sqlite.close();
  const sql = pieces.join("\n");
  return { large, publicJSON, publicStats, ids, sql, payload: { format: 1, account: ACCOUNT, database: SOURCE_DATABASE, createdAt: "2026-09-29", bookmark: "test-bookmark", sql, sqlSha256: checksum(sql), sources: {} } };
}

test("backup encryption authenticates contents, uses unique nonces, and fails closed on wrong keys and tampering", () => {
  const { payload } = fixture(), key = randomBytes(32).toString("base64");
  const first = encryptBackup(payload, key), second = encryptBackup(payload, key);
  assert.notDeepEqual(first, second);
  assert.deepEqual(decryptBackup(first, key), payload);
  assert.equal(first.includes(Buffer.from("O'Brien")), false);
  assert.throws(() => decryptBackup(first, randomBytes(32).toString("base64")), /authentication failed/);
  const damaged = Buffer.from(first); damaged[damaged.length - 1] ^= 1;
  assert.throws(() => decryptBackup(damaged, key), /authentication failed/);
  assert.throws(() => encryptBackup(payload, "password"), /32-byte/);
  assert.throws(() => decryptBackup(encryptBackup({ ...payload, sqlSha256: "wrong" }, key), key), /manifest/);
});

test("large snapshot restores through short SQL and bound values, preserving merges and immutable audit rows", () => {
  const { sql, large, publicStats, publicJSON } = fixture();
  const verified = inspectSQL(sql); verified.db.close();
  const { operations, counts } = restorePlan(sql);
  assert.ok(operations.every((operation) => Buffer.byteLength(operation.sql) < 100_000));
  assert.ok(operations.some((operation) => operation.params.some((param) => typeof param === "string" && Buffer.byteLength(param) > 1_000_000)));
  const restored = new DatabaseSync(":memory:");
  restored.exec("PRAGMA foreign_keys=ON");
  try {
    for (const { sql: statement, params } of operations) restored.prepare(statement).run(...params);
    assert.equal(restored.prepare("SELECT snapshot FROM matches").get().snapshot, large);
    const published = restored.prepare("SELECT gzip_base64 FROM public_statistics").get().gzip_base64;
    assert.equal(published, publicStats);
    assert.equal(gunzipSync(Buffer.from(published, "base64")).toString("utf8"), publicJSON);
    assert.throws(() => restored.exec("UPDATE public_statistics SET generation=1"), /generation must increase/);
    assert.equal(restored.prepare("SELECT count(*) n FROM player_audit").get().n, counts.player_audit);
    assert.equal(restored.prepare("SELECT count(*) n FROM match_finalizations").get().n, 1);
    assert.deepEqual(restored.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => restored.exec("DELETE FROM match_finalizations"), /immutable/);
    assert.throws(() => restored.exec("UPDATE match_actions SET revision=2"), /immutable/);
  } finally { restored.close(); }
});

test("remote restore refuses source/nonempty targets and verifies parameterized restoration into an empty target", async () => {
  const { payload, large, publicStats } = fixture(), target = randomUUID();
  let called = 0;
  const remote = new DatabaseSync(":memory:"); remote.exec("PRAGMA foreign_keys=ON");
  const fetcher = async (url, options) => {
    called++;
    assert.ok(url.includes(`/${target}/query`));
    const { sql, params } = JSON.parse(options.body);
    assert.ok(Buffer.byteLength(sql) < 100_000);
    const rows = remote.prepare(sql).all(...params);
    return Response.json({ success: true, result: [{ success: true, results: rows }] });
  };
  try {
    await assert.rejects(restoreD1(payload, SOURCE_DATABASE, "test-token", fetcher), /different, empty/);
    assert.equal(called, 0);
    const result = await restoreD1(payload, target, "test-token", fetcher);
    assert.ok(result.tables >= 8);
    assert.equal(remote.prepare("SELECT snapshot FROM matches").get().snapshot, large);
    assert.equal(remote.prepare("SELECT gzip_base64 FROM public_statistics").get().gzip_base64, publicStats);
    await assert.rejects(restoreD1(payload, target, "test-token", fetcher), /not empty/);
    assert.throws(() => remote.exec("DELETE FROM match_finalizations"), /immutable/);
  } finally { remote.close(); }
});

test("export polls a fixed bookmark, keeps credentials off signed downloads, and defers when a game is active", async () => {
  const { sql } = fixture();
  let polls = 0, downloads = 0;
  const fetcher = async (url, options) => {
    url = String(url);
    if (url.endsWith("/query")) return Response.json({ success: true, result: [{ success: true, results: [{ n: 0 }] }] });
    if (url.endsWith("/export")) {
      const body = JSON.parse(options.body);
      if (polls++) assert.equal(body.current_bookmark, "same-bookmark");
      return Response.json({ success: true, result: polls === 1 ? { at_bookmark: "same-bookmark" } :
        { at_bookmark: "same-bookmark", status: "complete", result: { signed_url: "https://download.example/private-export" } } });
    }
    downloads++;
    assert.equal(options.headers, undefined, "download host must not receive the Cloudflare token");
    assert.equal(options.redirect, "error");
    return new Response(sql);
  };
  const exported = await exportSQL("test-token", { fetcher, sleep: async () => {} });
  assert.equal(exported.sql, sql); assert.equal(exported.bookmark, "same-bookmark"); assert.equal(downloads, 1);
  let calls = 0;
  await assert.rejects(exportSQL("test-token", { fetcher: async () => {
    calls++; return Response.json({ success: true, result: [{ success: true, results: [{ n: 1 }] }] });
  } }), /deferred/);
  assert.equal(calls, 1, "an active match stops the export before it can block the database");
  await assert.rejects(exportSQL("test-token", { fetcher: async (url) => Response.json({ success: true, result: String(url).endsWith("/query") ?
    [{ success: true, results: [{ n: 0 }] }] : { at_bookmark: "still-running" } }), sleep: async () => {}, attempts: 1 }), /timed out/);
});

test("transient read failures retry, while initial exports and permanent permission failures do not", async () => {
  let queries = 0, exports = 0, downloads = 0;
  const sleeps = [];
  const fetcher = async (url, options) => {
    if (String(url).endsWith("/query")) {
      if (++queries === 1) return new Response("unavailable", { status: 503 });
      return Response.json({ success: true, result: [{ success: true, results: [{ n: 0 }] }] });
    }
    if (String(url).endsWith("/export")) {
      exports++;
      const request = JSON.parse(options.body);
      if (exports === 1) return Response.json({ success: true, result: { at_bookmark: "fixed" } });
      assert.equal(request.current_bookmark, "fixed");
      if (exports === 2) throw Error("Private network detail must not escape");
      return Response.json({ success: true, result: { status: "complete", at_bookmark: "fixed", result: { signed_url: "https://download.example/private" } } });
    }
    assert.equal(options.headers, undefined);
    if (++downloads === 1) return new Response("rate limited", { status: 429 });
    return new Response("valid sql");
  };
  assert.equal((await exportSQL("test-token", { fetcher, sleep: async (ms) => sleeps.push(ms) })).sql, "valid sql");
  assert.deepEqual([queries, exports, downloads], [2, 3, 2]);
  assert.equal(sleeps.length, 4); // Three retry waits plus the normal export poll.
  for (const status of [403, 503]) {
    let initialExports = 0;
    await assert.rejects(exportSQL("test-token", { fetcher: async (url) => {
      if (String(url).endsWith("/query")) return Response.json({ success: true, result: [{ success: true, results: [{ n: 0 }] }] });
      initialExports++;
      return new Response("secret error body", { status });
    }, sleep: async () => assert.fail("An uncertain initial export must not be replayed") }), new RegExp(`HTTP ${status}`));
    assert.equal(initialExports, 1);
  }
  let attempts = 0;
  await assert.rejects(exportSQL("test-token", { fetcher: async () => {
    attempts++;
    return new Response("private permission error", { status: 403 });
  }, sleep: async () => assert.fail("Permission failures do not retry") }), /HTTP 403/);
  assert.equal(attempts, 1);
});

test("an uncertain upload is verified without uploading twice, and failed downloads never acknowledge a backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cricket-backup-test-"));
  const key = randomBytes(32).toString("base64"), encrypted = encryptBackup(fixture().payload, key);
  const local = join(directory, "cricket-sg-beta-2026-09-30T00-00-00.000Z-aabbccdd.csgbackup");
  const calls = [];
  try {
    await writeFile(local, encrypted, { mode: 0o600 });
    let gets = 0;
    await uploadAndVerify(encrypted, key, local, { sleep: async () => {}, runMega: async (command, args) => {
      calls.push(command);
      if (command === "put") {
        assert.equal(args[1], `${MEGA_PATH}/${local.split("/").at(-1)}`);
        throw Error("Lost upload response");
      }
      if (++gets === 1) { await writeFile(args[1], "partial"); throw Error("Interrupted download"); }
      await assert.rejects(readFile(args[1]), { code: "ENOENT" }, "remove partial downloads before retrying");
      await writeFile(args[1], encrypted);
    } });
    assert.deepEqual(calls, ["put", "get", "get"]);
    let failedPuts = 0, failedGets = 0;
    await assert.rejects(uploadAndVerify(encrypted, key, local, { sleep: async () => {}, runMega: async (command) => {
      if (command === "put") failedPuts++;
      else failedGets++;
      throw Error("Unavailable");
    } }), /remains unverified/);
    assert.deepEqual([failedPuts, failedGets], [1, 3]);
    let corruptGets = 0;
    await assert.rejects(uploadAndVerify(encrypted, key, local, { sleep: async () => assert.fail("Integrity failures never retry"), runMega: async (command, args) => {
      if (command === "get") { corruptGets++; await writeFile(args[1], "wrong ciphertext"); }
    } }), /checksum/);
    assert.equal(corruptGets, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("public run receipts contain only verified metadata or a safe failure stage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cricket-receipt-test-"));
  const summaryPath = join(directory, "summary.md"), logs = [];
  try {
    const result = await writeBackupReceipt({ status: "verified", stage: "complete", file: "cricket-sg-beta-2026-09-30T00-00-00.000Z-aabbccdd.csgbackup",
      bytes: 100, sha256: "a".repeat(64), tableCount: 8, sql: "private-database", session: "private-session" }, { summaryPath, log: (line) => logs.push(line) });
    assert.equal(result.status, "verified");
    await writeBackupReceipt({ status: "deferred", stage: "export", error: "private signed URL", file: "unverified" }, { summaryPath, log: (line) => logs.push(line) });
    await writeBackupReceipt({ status: "failed", stage: "mega-login", error: "private session" }, { summaryPath, log: (line) => logs.push(line) });
    assert.equal(JSON.parse(logs[1]).file, undefined);
    assert.equal(JSON.parse(logs[2]).status, "failed");
    assert.doesNotMatch(`${logs.join("\n")}\n${await readFile(summaryPath, "utf8")}`, /private|unverified/);
    await assert.rejects(writeBackupReceipt({ status: "verified", stage: "complete", file: "fake" }, { summaryPath, log: () => assert.fail("Invalid receipt cannot be logged") }), /Invalid verified/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("source recovery bundle includes historical binary provenance without credential caches or private seed SQL", async () => {
  const sources = await backupSources();
  const history = sources["standalone/history.json.gz"];
  assert.equal(history.encoding, "base64");
  assert.equal(checksum(Buffer.from(history.content, "base64")), history.sha256);
  assert.equal(typeof sources["standalone/history-source.json"], "string");
  assert.equal(typeof sources["standalone/player-baseline.json"], "string");
  assert.equal(typeof sources["standalone/public-stats-worker.mjs"], "string");
  assert.equal(typeof sources["standalone/publish-statistics.mjs"], "string");
  assert.equal(typeof sources["scripts/download-mega-data.cjs"], "string");
  assert.ok(Object.keys(sources).every((name) => !/(?:^|\/)(?:\.env|\.git|\.wrangler|seed-players\.sql)|session|credential/.test(name)));
});
