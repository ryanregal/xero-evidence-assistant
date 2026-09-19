import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { loadLocalEnv } from "./config.js";

await loadLocalEnv();

const [{ gatherResearch }, { answerQuestion }, { OllamaClient }, { loadStore, readEvents }] = await Promise.all([
  import("./research.js"),
  import("./qa.js"),
  import("./model.js"),
  import("./storage.js")
]);

const port = Number(process.env.PORT ?? 3000);
const model = new OllamaClient();

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32_000) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/") {
      const html = await fs.readFile(path.resolve("public/index.html"), "utf8");
      return send(res, 200, html, "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      const store = await loadStore();
      const events = await readEvents(80);
      return send(res, 200, {
        model: model.name,
        sources: Object.values(store.sources).map((source) => ({
          id: source.id,
          title: source.title,
          url: source.url,
          retrievedAt: source.retrievedAt,
          chunks: source.chunks.length,
          lastAttemptStatus: source.lastAttemptStatus,
          lastAttemptAt: source.lastAttemptAt,
          lastAttemptUrl: source.lastAttemptUrl,
          lastError: source.lastError
        })),
        events
      });
    }

    const sourceMatch = url.pathname.match(/^\/api\/sources\/([^/]+)$/);
    if (req.method === "GET" && sourceMatch) {
      const store = await loadStore();
      const source = store.sources[sourceMatch[1]];
      return source ? send(res, 200, source) : send(res, 404, { error: "Source not found" });
    }

    if (req.method === "POST" && url.pathname === "/api/gather") {
      return send(res, 200, { results: await gatherResearch({ refresh: false }) });
    }

    if (req.method === "POST" && url.pathname === "/api/refresh") {
      return send(res, 200, { results: await gatherResearch({ refresh: true }) });
    }

    if (req.method === "POST" && url.pathname === "/api/ask") {
      const body = await readJson(req);
      try {
        return send(res, 200, await answerQuestion(String(body?.question ?? ""), model));
      } catch (error) {
        return send(res, 502, {
          status: "failed",
          error: String(error?.message ?? error),
          message: "The external workflow failed. No unsupported answer was returned as successful."
        });
      }
    }

    return send(res, 404, { error: "Not found" });
  } catch (error) {
    return send(res, 500, { error: String(error?.message ?? error) });
  }
});

server.listen(port, () => {
  console.log(`Xero Evidence Assistant: http://localhost:${port}`);
  console.log(`Model: ${model.name}`);
});
