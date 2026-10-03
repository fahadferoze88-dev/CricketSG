import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "./worker.mjs";

test("static-asset requests verify signed Access tokens without ctx.access, rejecting invalid identities", async (t) => {
  const issuer = "https://access.example.com";
  const audience = "beta-app";
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const untrusted = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256", use: "sig" };
  let keyFetches = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(String(url), `${issuer}/cdn-cgi/access/certs`);
    keyFetches++;
    return Response.json({ keys: [jwk] });
  });
  const now = Math.floor(Date.now() / 1000);
  const sign = (overrides = {}, key = privateKey) => new SignJWT({
    iss: issuer, aud: [audience], email: "Scorer@Example.com", iat: now, exp: now + 3600, ...overrides,
  }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(key);
  let lookups = 0;
  let assetReads = 0;
  let enabled = true;
  let databaseFails = false;
  const env = {
    TEAM_DOMAIN: issuer, POLICY_AUD: audience,
    DB: { prepare(sql) {
      assert.match(sql, /enabled = 1/);
      return { bind(email) {
        assert.equal(email, "scorer@example.com");
        return { async first() {
          lookups++;
          if (databaseFails) throw new Error("Private database details");
          return enabled ? { display_name: "Test scorer", can_correct: 1 } : null;
        } };
      } };
    } },
    ASSETS: { async fetch() { assetReads++; return new Response("Scorer app"); } },
  };
  const request = (token, path = "/api/session", method = "GET") => new Request(`https://beta.example${path}`, {
    method, headers: {
      "Cf-Access-Authenticated-User-Email": "scorer@example.com",
      ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}),
    },
  });
  for (const token of [undefined, "fake", await sign({ iss: "https://wrong.example" }),
    await sign({ aud: "another-app" }), await sign({ exp: now - 1 }),
    await sign({ nbf: now + 3600 }), await sign({ exp: undefined }),
    await sign({ email: undefined }), await sign({}, untrusted.privateKey)]) {
    assert.equal((await worker.fetch(request(token), env, {})).status, 403);
  }
  assert.equal(lookups, 0, "invalid tokens must not reach the scorer database");
  assert.equal(assetReads, 0);
  const token = await sign();
  const session = await worker.fetch(request(token), env, {});
  assert.equal(session.status, 200, "valid signed requests work without ctx.access");
  assert.equal(session.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await session.json(), { name: "Test scorer", canCorrect: true, storage: "device-and-cloud" });
  assert.equal(await (await worker.fetch(request(token, "/"), env, {})).text(), "Scorer app");
  assert.equal((await worker.fetch(request(token, "/api/unrecognized", "POST"), env, {})).status, 405);
  assert.equal((await worker.fetch(request(token, "/api/unrecognized"), env, {})).status, 404);
  enabled = false;
  assert.equal((await worker.fetch(request(token), env, {})).status, 403);
  assert.equal(assetReads, 1);
  databaseFails = true;
  const unavailable = await worker.fetch(request(token), env, {});
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(await unavailable.text(), /Private database details/);
  assert.equal(assetReads, 1);
  assert.equal(keyFetches, 1, "public signing keys are cached across requests");
});
