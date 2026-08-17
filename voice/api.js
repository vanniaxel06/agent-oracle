import http from "http";
import fs from "fs";
import { listMisses, resolveMiss } from "./misses.js";

const GRAMMAR = new URL("./grammar.json", import.meta.url).pathname;

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  });
  res.end(payload);
}

function body(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => {
      d += c;
      if (d.length > 2_000_000) reject(new Error("too large"));
    });
    req.on("end", () => {
      try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); }
    });
  });
}

export function startApi({ port = 8788, token, onGrammarChange } = {}) {
  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") return json(res, 204, {});

    const url = new URL(req.url, "http://x");
    const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (token && auth !== token) return json(res, 401, { error: "unauthorised" });

    try {
      if (req.method === "GET" && url.pathname === "/misses") {
        return json(res, 200, { misses: listMisses(url.searchParams.get("status") || "open") });
      }

      if (req.method === "POST" && url.pathname.startsWith("/misses/")) {
        const id = url.pathname.split("/")[2];
        const b = await body(req);
        const row = resolveMiss(id, b.status || "mapped", b.note);
        return row ? json(res, 200, row) : json(res, 404, { error: "not found" });
      }

      if (req.method === "GET" && url.pathname === "/grammar") {
        return json(res, 200, JSON.parse(fs.readFileSync(GRAMMAR, "utf8")));
      }

      if (req.method === "PUT" && url.pathname === "/grammar") {
        const next = await body(req);
        if (!next.intents || !next.slots) return json(res, 400, { error: "bad grammar" });
        fs.copyFileSync(GRAMMAR, GRAMMAR + ".bak");
        fs.writeFileSync(GRAMMAR, JSON.stringify(next, null, 2));
        onGrammarChange?.();
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  });

  server.listen(port, () => console.log(`triage api on :${port}`));
  return server;
}
