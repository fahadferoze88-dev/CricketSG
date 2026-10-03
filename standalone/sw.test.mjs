import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../testing/sw.js", import.meta.url), "utf8");

test("offline shell is complete, excludes login/API data, and keeps one asset version until tabs close", async () => {
  const handlers = {}, contents = new Map();
  let mode = "online", fetches = 0;
  const cache = {
    put: async (url, response) => contents.set(url, response.clone()),
    match: async (url) => contents.get(url)?.clone(),
  };
  const scope = "https://beta.example/";
  const context = vm.createContext({
    URL, Response,
    self: {
      registration: { scope }, location: { origin: "https://beta.example" },
      clients: { claim: async () => {} },
      addEventListener: (name, handler) => { handlers[name] = handler; },
    },
    caches: { open: async () => cache, keys: async () => ["cricket-sg-shell-v10"], delete: async () => {} },
    fetch: async (request) => {
      fetches++;
      if (mode === "offline") throw new TypeError("Network unavailable");
      if (mode === "denied") return new Response("Access denied", { status: 403 });
      if (mode === "login") return new Response("Sign in");
      return new Response(mode === "updated" ? "New app version" : String(request), { headers: { "X-Cricket-Shell": "1" } });
    },
  });
  vm.runInContext(source, context);
  const install = () => {
    let result;
    handlers.install({ waitUntil(promise) { result = promise; } });
    return result;
  };
  mode = "login";
  await assert.rejects(install());
  assert.equal(contents.size, 0, "sign-in HTML cannot replace any offline asset");
  mode = "online";
  await install();
  assert.equal(contents.size, 8);
  const request = (path, navigation = false) => {
    let result;
    handlers.fetch({ request: { url: scope + path, method: "GET", mode: navigation ? "navigate" : "cors" }, respondWith(promise) { result = promise; } });
    return result;
  };
  mode = "offline";
  assert.equal(await (await request("", true)).text(), scope);
  assert.equal(await (await request("app.js")).text(), scope + "app.js");
  assert.equal(request("api/session"), undefined);
  mode = "updated";
  assert.equal(await (await request("", true)).text(), scope, "cached HTML and scripts stay on same version");
  mode = "denied";
  assert.equal((await request("", true)).status, 403, "explicit online denial is not converted into offline success");
  assert.equal(fetches, 19);
});
