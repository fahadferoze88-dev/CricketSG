import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "./public-stats-worker.mjs";

const publicData = { meta: { schema_version: 3 }, players: [{ name: "Player One" }], matches: [] };
const gzip = gzipSync(JSON.stringify(publicData));
const publication = {
  generation: 1, generated_at: "2026-10-02T10:00:00.000Z",
  sha256: createHash("sha256").update(gzip).digest("hex"), gzip_base64: gzip.toString("base64"),
  source_manifest: JSON.stringify({ private_operator: "must-not-be-served@example.test" }),
};
function environment(rows = new Map([["review", publication]])) {
  const queries = [];
  return { queries, DB: { prepare(sql) {
    assert.equal(sql, "SELECT generation, generated_at, sha256, gzip_base64 FROM public_statistics WHERE name = ?");
    return { bind(name) { queries.push({ sql, name }); return { first: async () => rows.get(name) || null }; } };
  } } };
}
const request = (path = "/review/data.json", options) => new Request(`https://stats.example${path}`, options);

test("public review GET and HEAD serve exact gzip bytes, metadata and fixed non-credentialed CORS", async () => {
  const env = environment();
  const response = await worker.fetch(request(undefined, { headers: { Origin: "https://cricket-sg.vercel.app" } }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Encoding"), "gzip");
  assert.equal(response.headers.get("Content-Length"), String(gzip.length));
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://cricket-sg.vercel.app");
  assert.equal(response.headers.has("Access-Control-Allow-Credentials"), false);
  assert.equal(response.headers.get("X-Statistics-Generation"), "1");
  assert.equal(response.headers.get("X-Statistics-Generated-At"), publication.generated_at);
  assert.match(response.headers.get("Cache-Control"), /max-age=60/);
  const body = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(body, gzip);
  assert.deepEqual(JSON.parse(gunzipSync(body)), publicData);
  assert.equal(gunzipSync(body).toString().includes("private_operator"), false);
  const head = await worker.fetch(request(undefined, { method: "HEAD", headers: { Origin: "https://other.example" } }), env);
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(head.headers.get("Content-Length"), String(gzip.length));
  assert.equal(head.headers.get("Access-Control-Allow-Origin"), "https://cricket-sg.vercel.app", "never reflect an unapproved origin");
  assert.equal(head.headers.get("ETag"), response.headers.get("ETag"));
});

test("review publication cannot populate primary; missing snapshots and DB errors fail without private details", async () => {
  const env = environment();
  const primary = await worker.fetch(request("/data.json"), env);
  assert.equal(primary.status, 503);
  assert.equal(primary.headers.get("Cache-Control"), "no-store");
  assert.equal(primary.headers.get("Retry-After"), "60");
  assert.equal(env.queries.at(-1).name, "primary");
  const failing = { DB: { prepare() { throw new Error("private token and database trace"); } } };
  const response = await worker.fetch(request(), failing);
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("private"), false);
  const head = await worker.fetch(request("/data.json", { method: "HEAD" }), env);
  assert.equal(head.status, 503);
  assert.equal(await head.text(), "");
});

test("precompressed snapshots disable Workers automatic body encoding", async () => {
  const NativeResponse = globalThis.Response;
  const encodings = [];
  globalThis.Response = class extends NativeResponse {
    constructor(body, options) {
      if (new Headers(options?.headers).get("Content-Encoding") === "gzip") encodings.push(options.encodeBody);
      super(body, options);
    }
  };
  try {
    for (const method of ["GET", "HEAD"]) assert.equal((await worker.fetch(request(undefined, { method }), environment())).status, 200);
    assert.deepEqual(encodings, ["manual", "manual"], "workerd must send already compressed bytes without recompressing them");
  } finally { globalThis.Response = NativeResponse; }
});

test("conditional GET/HEAD revalidate snapshots and non-read methods/other routes never touch D1", async () => {
  const env = environment();
  const first = await worker.fetch(request(), env);
  const etag = first.headers.get("ETag");
  for (const method of ["GET", "HEAD"]) for (const condition of [etag, `"old", W/${etag}`, "*"]) {
    const response = await worker.fetch(request(undefined, { method, headers: { "If-None-Match": condition } }), env);
    assert.equal(response.status, 304);
    assert.equal(await response.text(), "");
    assert.equal(response.headers.get("ETag"), etag);
  }
  assert.equal((await worker.fetch(request(undefined, { headers: { "If-None-Match": '"older-snapshot"' } }), env)).status, 200);
  const before = env.queries.length;
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
    const response = await worker.fetch(request(undefined, { method }), env);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "GET, HEAD");
  }
  for (const path of ["/", "/api/session", "/api/matches", "/source_manifest", "/data.json/private", "/review/other.json"]) {
    assert.equal((await worker.fetch(request(path), env)).status, 404);
  }
  assert.equal(env.queries.length, before);
});

test("malformed stored snapshots fail closed and migration enforces size, generations and atomic retry guards", async () => {
  for (const override of [{ generation: 0 }, { sha256: "oops" }, { generated_at: "bad" }, { gzip_base64: "!".repeat(28) }, { gzip_base64: Buffer.alloc(24).toString("base64") }]) {
    const response = await worker.fetch(request(), environment(new Map([["review", { ...publication, ...override }]])));
    assert.equal(response.status, 503);
  }
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync(new URL("./migrations/0005_statistics.sql", import.meta.url), "utf8"));
    const insert = db.prepare("INSERT INTO public_statistics VALUES(?, ?, ?, ?, ?, ?)");
    const values = ["review", publication.generation, publication.generated_at, publication.sha256, publication.gzip_base64, publication.source_manifest];
    insert.run(...values);
    assert.equal(db.prepare("SELECT count(*) AS n FROM public_statistics WHERE name='primary'").get().n, 0);
    assert.throws(() => insert.run("private", ...values.slice(1)), /CHECK/);
    assert.throws(() => insert.run("primary", 1, publication.generated_at, publication.sha256, "A".repeat(1800004), "{}"), /CHECK/);
    assert.throws(() => db.prepare("UPDATE public_statistics SET generation=1 WHERE name='review'").run(), /must increase/);
    const update = db.prepare("UPDATE public_statistics SET generation=?,generated_at=?,sha256=?,gzip_base64=?,source_manifest=? WHERE name=? AND generation=? AND sha256=?");
    assert.equal(update.run(2, ...values.slice(2), "review", 1, publication.sha256).changes, 1);
    assert.equal(update.run(3, ...values.slice(2), "review", 1, publication.sha256).changes, 0, "a stale job cannot replace the current snapshot");
    assert.equal(db.prepare("SELECT generation FROM public_statistics WHERE name='review'").get().generation, 2);
  } finally { db.close(); }
});
