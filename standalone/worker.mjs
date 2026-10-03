import { createRemoteJWKSet, jwtVerify } from "jose";
import { playerAPI } from "./players.mjs";
import { matchAPI } from "./matches.mjs";
import { backupStatus } from "./backup-status.mjs";

let keySet;
let keySetIssuer;

export default {
  async fetch(request, env) {
    const reply = (body, status) => Response.json(body, {
      status, headers: { "Cache-Control": "no-store" },
    });
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) return reply({ error: "Sign-in required" }, 403);
    if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return reply({ error: "Sign-in is not configured" }, 503);
    let identity;
    try {
      // Static Assets' internal router does not forward ctx.access. Verify the
      // signed assertion instead; an email header alone never establishes identity.
      if (keySetIssuer !== env.TEAM_DOMAIN) {
        keySet = createRemoteJWKSet(new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`));
        keySetIssuer = env.TEAM_DOMAIN;
      }
      ({ payload: identity } = await jwtVerify(token, keySet, {
        issuer: env.TEAM_DOMAIN,
        audience: env.POLICY_AUD,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "email"],
      }));
    } catch {
      return reply({ error: "Sign-in could not be verified. Please retry." }, 403);
    }
    try {
      if (typeof identity?.email !== "string") return reply({ error: "Sign-in required" }, 403);
      const scorer = await env.DB.prepare(
        "SELECT display_name, can_correct FROM scorers WHERE email = ? AND enabled = 1"
      ).bind(identity.email.toLowerCase()).first();
      if (!scorer) return reply({ error: "Scorer access required" }, 403);
      const path = new URL(request.url).pathname;
      const isOwner = typeof env.OWNER_EMAIL === "string" && identity.email.toLowerCase() === env.OWNER_EMAIL.trim().toLowerCase();
      if (path === "/api/matches" || path.startsWith("/api/matches/")) return await matchAPI(request, env, identity.email.toLowerCase(), scorer.can_correct === 1);
      if (path === "/api/players" || path.startsWith("/api/players/")) return await playerAPI(request, env, identity.email.toLowerCase());
      if (!["GET", "HEAD"].includes(request.method)) return reply({ error: "Method not allowed" }, 405);
      if (path === "/api/session") {
        return reply({ name: scorer.display_name, canCorrect: scorer.can_correct === 1, storage: "device-and-cloud", canViewBackups: isOwner }, 200);
      }
      if (path === "/api/backup-status") {
        if (!isOwner) return reply({ error: "Owner access required" }, 403);
        return reply(await backupStatus(env.DB), 200);
      }
      if (path.startsWith("/api/")) return reply({ error: "Not found" }, 404);
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      if (asset.ok && ["/", "/index.html", "/styles.css", "/storage.js", "/app.js", "/recovery.mjs", "/sw.js", "/scoring.mjs", "/players.js", "/corrections.js"].includes(path)) {
        response.headers.set("X-Cricket-Shell", "1");
        response.headers.set("Cache-Control", "no-cache");
      }
      return response;
    } catch {
      return reply({ error: "Scorer temporarily unavailable. Please retry." }, 503);
    }
  },
};
