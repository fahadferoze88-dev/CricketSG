const origin = "https://cricket-sg.vercel.app";
const names = new Map([["/data.json", "primary"], ["/review/data.json", "review"]]);

export default {
  async fetch(request, env) {
    const common = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Expose-Headers": "ETag, X-Statistics-Generation, X-Statistics-Generated-At",
      "X-Content-Type-Options": "nosniff",
    };
    const error = (status, message, extra = {}) => new Response(request.method === "HEAD" ? null : JSON.stringify({ error: message }), {
      status, headers: { ...common, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
    });
    const name = names.get(new URL(request.url).pathname);
    if (!name) return error(404, "Not found");
    if (!["GET", "HEAD"].includes(request.method)) return error(405, "Method not allowed", { Allow: "GET, HEAD" });
    try {
      // No match/player/authentication data or source manifest can be requested through this endpoint.
      const row = await env.DB.prepare("SELECT generation, generated_at, sha256, gzip_base64 FROM public_statistics WHERE name = ?").bind(name).first();
      if (!row) return error(503, "Statistics have not been published yet.", { "Retry-After": "60" });
      if (!Number.isSafeInteger(row.generation) || row.generation < 1 ||
          typeof row.generated_at !== "string" || !Number.isFinite(Date.parse(row.generated_at)) ||
          !/^[a-f0-9]{64}$/.test(row.sha256 || "") || typeof row.gzip_base64 !== "string" ||
          row.gzip_base64.length < 28 || row.gzip_base64.length > 1800000 || row.gzip_base64.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(row.gzip_base64)) throw new Error("Invalid publication");
      const etag = `"sha256-${row.sha256}"`;
      const headers = {
        ...common, "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip",
        "Cache-Control": "public, max-age=60, must-revalidate, no-transform", ETag: etag,
        "X-Statistics-Generation": String(row.generation),
        "X-Statistics-Generated-At": new Date(row.generated_at).toISOString(),
      };
      const matches = request.headers.get("If-None-Match")?.split(",").some((tag) => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag);
      if (matches) return new Response(null, { status: 304, headers, encodeBody: "manual" });
      const binary = atob(row.gzip_base64);
      if (binary.length < 20 || binary.charCodeAt(0) !== 0x1f || binary.charCodeAt(1) !== 0x8b || binary.charCodeAt(2) !== 8) throw new Error("Invalid gzip snapshot");
      headers["Content-Length"] = String(binary.length);
      if (request.method === "HEAD") return new Response(null, { headers, encodeBody: "manual" });
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      // Workers otherwise compress again according to Content-Encoding, corrupting pre-gzipped JSON.
      return new Response(bytes, { headers, encodeBody: "manual" });
    } catch {
      return error(503, "Statistics are temporarily unavailable. Please retry.", { "Retry-After": "60" });
    }
  },
};
