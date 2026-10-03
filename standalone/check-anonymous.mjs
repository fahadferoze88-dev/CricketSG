import assert from "node:assert/strict";

const origin = "https://cricket-sg-beta.cricket-sg-fahad.workers.dev";
const loginHost = "divine-snowflake-82f2.cloudflareaccess.com";
for (const path of ["/", "/app.js", "/sw.js", "/api/session", "/api/matches", "/api/players", "/players.js", "/scoring.mjs", "/corrections.js"]) {
  for (const forged of [false, true]) {
    const response = await fetch(origin + path, {
      redirect: "manual",
      headers: forged ? {
        "Cf-Access-Authenticated-User-Email": "scorer@example.com",
        "Cf-Access-Jwt-Assertion": "fake",
      } : {},
    });
    assert.equal(response.status, 302, `${path}: unsigned request must go to sign-in`);
    const redirect = new URL(response.headers.get("location"));
    assert.equal(redirect.protocol, "https:");
    assert.equal(redirect.hostname, loginHost);
    console.log(`Protected: ${path}${forged ? " (forged headers)" : ""}`);
  }
}
