const CACHE = "cricket-sg-shell-v10";
const shell = ["./index.html", "./styles.css", "./storage.js", "./recovery.mjs", "./app.js", "./scoring.mjs", "./players.js", "./corrections.js"];
const paths = new Set(shell.map((path) => new URL(path, self.registration.scope).pathname));

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const responses = await Promise.all(shell.map(async (path) => {
      const url = new URL(path, self.registration.scope);
      // Workers Assets redirects /index.html to /. Fetch the canonical URL but
      // keep a fixed index.html cache key for navigation fallback.
      const response = await fetch(path === "./index.html" ? new URL("./", self.registration.scope) : url,
        { cache: "reload", redirect: "error" });
      // Never store a sign-in page or an error in place of the protected app.
      if (!response.ok || response.headers.get("X-Cricket-Shell") !== "1") throw new Error("Offline shell unavailable");
      return [url.href, response];
    }));
    const cache = await caches.open(CACHE);
    await Promise.all(responses.map(([url, response]) => cache.put(url, response)));
  })());
  // Leave updates waiting until every scorer tab closes. Never replace mid-game.
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("cricket-sg-shell-") && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  const root = new URL(self.registration.scope).pathname;
  if (event.request.mode === "navigate" && (url.pathname === root || url.pathname === `${root}index.html`)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        if (response.ok && response.headers.get("X-Cricket-Shell") === "1") {
          const cache = await caches.open(CACHE);
          return await cache.match(new URL("./index.html", self.registration.scope).href) || response;
        }
        return response;
      }
      catch {
        const cache = await caches.open(CACHE);
        return await cache.match(new URL("./index.html", self.registration.scope).href) || Response.error();
      }
    })());
  } else if (paths.has(url.pathname)) {
    // Keep all script/style versions together; never cache API responses or identities.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return await cache.match(url.href) || fetch(event.request);
    })());
  }
});
