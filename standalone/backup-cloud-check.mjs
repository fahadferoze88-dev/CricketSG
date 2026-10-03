import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { recoveryDB } from "./test-db.mjs";
import { ACCOUNT, SOURCE_DATABASE, restorePlan, restoreD1, cloudRequest } from "./backup.mjs";

const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identifier = (name) => `"${name.replaceAll('"', '""')}"`;
const literal = (value) => value === null ? "NULL" : typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`;
const requireCheck = (condition, message) => { if (!condition) throw Error(message); };

function syntheticFixture() {
  const { sqlite } = recoveryDB();
  try {
    sqlite.exec(readFileSync(new URL("./migrations/0005_statistics.sql", import.meta.url), "utf8"));
    const matchId = randomUUID(), deviceId = randomUUID();
    const snapshot = JSON.stringify({ synthetic_restore_check: true, padding: "x".repeat(1_100_000), note: "O'Brien\nUnicode naïve 🏏" });
    // Incompressible synthetic data exercises a second >1MB parameter, using the real statistics encoding.
    const publicJSON = JSON.stringify({ synthetic_restore_check: true, payload: randomBytes(800_000).toString("base64") });
    const compressed = gzipSync(publicJSON), statistics = compressed.toString("base64");
    sqlite.prepare("INSERT INTO public_statistics VALUES(?,?,?,?,?,?)")
      .run("review", 1, "2026-10-03T00:00:00.000Z", checksum(compressed), statistics, '{"synthetic_restore_check":true}');
    const playerIds = [randomUUID(), randomUUID()];
    for (const [index, id] of playerIds.entries()) sqlite.prepare(`INSERT INTO players
      (id,name,normalized_name,creation_payload,created_at,updated_at,updated_by,reason) VALUES(?,?,?,?,?,?,?,?)`)
      .run(id, `Synthetic player ${index}`, `synthetic player ${index}`, "{}", "2026-10-03", "2026-10-03", "first@example.com", "Synthetic restore drill");
    sqlite.prepare("UPDATE players SET merged_into=?,active=0,revision=revision+1 WHERE id=?").run(playerIds[1], playerIds[0]);
    sqlite.prepare("INSERT INTO matches(id,owner_email,owner_device,revision,snapshot,content_hash,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(matchId, "first@example.com", deviceId, 1, snapshot, checksum(snapshot), "2026-10-03");
    sqlite.prepare("UPDATE matches SET finalized_revision=1,finalized_at='2026-10-03',finalized_by='first@example.com' WHERE id=?").run(matchId);
    sqlite.prepare("INSERT INTO match_actions VALUES(?,?,?,?,?,?,?)")
      .run(matchId, "synthetic-action", 1, "first@example.com", deviceId, '{"synthetic":true}', "2026-10-03");
    const schema = sqlite.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
    const statements = ["PRAGMA foreign_keys=OFF;"];
    for (const table of schema.filter((item) => item.type === "table")) {
      statements.push(`${table.sql};`);
      for (const row of sqlite.prepare(`SELECT * FROM ${identifier(table.name)}`).all()) {
        statements.push(`INSERT INTO ${identifier(table.name)} VALUES(${Object.values(row).map(literal).join(",")});`);
      }
    }
    statements.push(...schema.filter((item) => item.type !== "table").map((item) => `${item.sql};`));
    const sql = statements.join("\n");
    return { matchId, playerIds, snapshot, statistics, publicJSON,
      payload: { format: 1, account: ACCOUNT, database: SOURCE_DATABASE, sql, sqlSha256: checksum(sql) } };
  } finally { sqlite.close(); }
}

export async function restoreCheck(target, token, fetcher = fetch) {
  requireCheck(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target || "") &&
    target.toLowerCase() !== SOURCE_DATABASE, "Choose an explicit disposable empty database UUID, different from the scorer database.");
  requireCheck(typeof token === "string" && token.length > 0, "The hosted Cloudflare token is required.");
  const fixture = syntheticFixture();
  const plan = restorePlan(fixture.payload.sql);
  const largeParameters = plan.operations.flatMap((operation) => operation.params).filter((value) => typeof value === "string" && Buffer.byteLength(value) > 1_000_000);
  requireCheck(largeParameters.length >= 3 && plan.operations.every((operation) => Buffer.byteLength(operation.sql) < 100_000), "Synthetic large-parameter restore fixture is incomplete.");
  // Even an accidental future source-query addition cannot escape this target-only transport.
  const targetFetch = (url, options) => {
    requireCheck(String(url) === `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${target}/query`, "Restore drill attempted an unexpected database request.");
    return fetcher(url, options);
  };
  const result = await restoreD1(fixture.payload, target, token, targetFetch);
  const query = (sql, params = [], transport = targetFetch) => cloudRequest(token, target, "query", { sql, params }, transport);
  const row = async (sql, params) => {
    const response = await query(sql, params);
    requireCheck(response[0]?.results?.length === 1, "Restored verification row is missing.");
    return response[0].results[0];
  };
  for (const table of ["matches", "match_finalizations"]) {
    const restored = await row(`SELECT snapshot,content_hash,length(CAST(snapshot AS BLOB)) AS bytes FROM ${table} WHERE ${table === "matches" ? "id" : "match_id"}=?`, [fixture.matchId]);
    requireCheck(restored.bytes === Buffer.byteLength(fixture.snapshot) && checksum(restored.snapshot) === checksum(fixture.snapshot) &&
      restored.content_hash === checksum(fixture.snapshot), "Large match snapshot failed exact byte/checksum verification.");
  }
  const statistics = await row("SELECT gzip_base64,sha256,length(CAST(gzip_base64 AS BLOB)) AS bytes FROM public_statistics WHERE name=?", ["review"]);
  requireCheck(statistics.bytes > 1_000_000 && statistics.bytes === Buffer.byteLength(fixture.statistics) &&
    checksum(statistics.gzip_base64) === checksum(fixture.statistics), "Large statistics value failed exact byte/checksum verification.");
  const compressed = Buffer.from(statistics.gzip_base64, "base64");
  requireCheck(checksum(compressed) === statistics.sha256 && checksum(gunzipSync(compressed)) === checksum(fixture.publicJSON), "Restored statistics did not decompress to the original synthetic JSON.");
  const merged = await row("SELECT merged_into,active FROM players WHERE id=?", [fixture.playerIds[0]]);
  requireCheck(merged.merged_into === fixture.playerIds[1] && merged.active === 0, "Player identity linkage was not preserved.");
  for (const table of ["match_actions", "match_finalizations"]) for (const operation of ["UPDATE", "DELETE"]) {
    let immutableRejection = false, rejected = false;
    const inspectedFetch = async (url, options) => {
      const response = await targetFetch(url, options);
      const body = await response.clone().json().catch(() => null);
      immutableRejection = /immutable/i.test(JSON.stringify([body?.errors, body?.result]));
      return response;
    };
    try {
      await query(operation === "UPDATE" ? `UPDATE ${table} SET revision=revision+1 WHERE match_id=?` : `DELETE FROM ${table} WHERE match_id=?`, [fixture.matchId], inspectedFetch);
    } catch { rejected = true; }
    requireCheck(rejected && immutableRejection, "Restored immutable-audit protection was not positively verified.");
    const retained = await row(`SELECT count(*) AS n,min(revision) AS revision FROM ${table} WHERE match_id=?`, [fixture.matchId]);
    requireCheck(retained.n === 1 && retained.revision === 1, "Audit mutation changed the restored evidence.");
  }
  return { status: "passed", tables: result.tables, snapshot_bytes: Buffer.byteLength(fixture.snapshot),
    statistics_base64_bytes: statistics.bytes, large_parameter_values: largeParameters.length,
    checks: ["parameterized-large-values", "exact-match-and-finalization-checksums", "gzip-roundtrip", "player-merge-link", "immutable-audit-update-and-delete"] };
}

async function localCheck() {
  const target = randomUUID();
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  try {
    return await restoreCheck(target, "local-synthetic-token", async (_url, options) => {
      const { sql, params } = JSON.parse(options.body);
      try { return Response.json({ success: true, result: [{ success: true, results: db.prepare(sql).all(...params) }] }); }
      catch (error) { return Response.json({ success: false, errors: [{ message: error.message }] }, { status: 400 }); }
    });
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    requireCheck(args.length === 0 || (args.length === 1 && args[0] === "--local-check"), "Use --local-check or configure an explicit RESTORE_TARGET_DATABASE.");
    const local = args[0] === "--local-check";
    const result = local ? await localCheck() : await restoreCheck(process.env.RESTORE_TARGET_DATABASE, process.env.CLOUDFLARE_D1_BACKUP_TOKEN);
    console.log(JSON.stringify({ mode: local ? "local-synthetic" : "cloud-synthetic", ...result }));
  } catch {
    // Never print a remote body, SQL, synthetic data or credentials. Partial targets are left for inspection.
    console.error("Synthetic restore check failed. Verify the explicit empty target and token permissions; any disposable target data has been kept for inspection.");
    process.exitCode = 1;
  }
}
