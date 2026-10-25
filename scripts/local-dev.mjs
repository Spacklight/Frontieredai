import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const root = fileURLToPath(new URL("..", import.meta.url));
const publicDir = resolve(root, "public");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function loadEnv() {
  const env = {
    GITHUB_OWNER: "your-github-username",
    GITHUB_REPO: "aidata",
    GITHUB_BRANCH: "main",
    GEMINI_MODEL: "gemini-3.5-flash-lite",
  };
  const file = join(root, ".dev.vars");
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[trimmed.slice(0, eq).trim()] = value;
  }
  return env;
}

function serveAsset(request) {
  const url = new URL(request.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";
  const file = resolve(publicDir, pathname.replace(/^\/+/, ""));
  if (file !== publicDir && !file.startsWith(publicDir + sep)) {
    return new Response("Forbidden", { status: 403 });
  }
  let target = file;
  if (!existsSync(target) || !statSync(target).isFile()) {
    if (!extname(pathname)) target = join(publicDir, "index.html");
    else return new Response("Not found", { status: 404 });
  }
  const type = mime[extname(target)] || "application/octet-stream";
  return new Response(readFileSync(target), { headers: { "content-type": type } });
}

const env = loadEnv();
env.ASSETS = { fetch: serveAsset };
const worker = (await import(new URL("../worker.js", import.meta.url))).default;
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || "0.0.0.0";
const skipHeaders = new Set(["host", "connection", "content-length", "transfer-encoding"]);

const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null || skipHeaders.has(key.toLowerCase())) continue;
      if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
      else headers.set(key, value);
    }
    const init = { method: req.method || "GET", headers };
    if (req.method !== "GET" && req.method !== "HEAD" && body.length) {
      init.body = body;
      init.duplex = "half";
    }
    const hostHeader = req.headers.host || `${host}:${port}`;
    const request = new Request(`http://${hostHeader}${req.url}`, init);
    const response = await worker.fetch(request, env, {
      waitUntil(task) {
        Promise.resolve(task).catch((err) => console.error(err));
      },
    });
    const out = {};
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "transfer-encoding") return;
      out[key] = value;
    });
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Local server error");
  }
});

server.listen(port, host, () => {
  console.log(`Study Helper on http://${host}:${port}`);
});
