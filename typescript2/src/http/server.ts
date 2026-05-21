// HTTP server + SSE event stream + static UI (Section 13.7 extension).

import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { log, getRecentLogLines } from "../logging/logger.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WEB_DIR_CANDIDATES = [
  path.resolve(__dirname, "../../web"),
  path.resolve(__dirname, "../../../web"),
  path.resolve(__dirname, "../web"),
];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

export interface HttpServerOptions {
  port: number;
  host: string;
}

export class SymphonyHttpServer {
  private server: http.Server | null = null;
  private sseClients = new Set<http.ServerResponse>();
  private snapshotTimer: NodeJS.Timeout | null = null;
  private webDir: string | null = null;

  constructor(private orchestrator: Orchestrator, private opts: HttpServerOptions) {
    orchestrator.on("snapshot", () =>
      this.broadcast({ type: "snapshot", data: orchestrator.snapshot() }),
    );
    orchestrator.on("agent_event", (e) => this.broadcast({ type: "agent_event", data: e }));
  }

  async start(): Promise<void> {
    this.webDir = await resolveWebDir();
    const server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port, this.opts.host, () => resolve());
    });
    this.server = server;
    // periodic heartbeat snapshot for clients (also keeps proxies alive)
    this.snapshotTimer = setInterval(() => {
      this.broadcast({ type: "snapshot", data: this.orchestrator.snapshot() });
    }, 5000);
    log.info("http_listening", { host: this.opts.host, port: this.opts.port });
  }

  async stop(): Promise<void> {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    for (const c of this.sseClients) c.end();
    this.sseClients.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    res.setHeader("Cache-Control", "no-store");
    try {
      if (url.pathname === "/api/v1/state" && req.method === "GET") {
        return sendJson(res, 200, this.orchestrator.snapshot());
      }
      if (url.pathname === "/api/v1/logs" && req.method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") || "200", 10);
        return sendJson(res, 200, { lines: getRecentLogLines(limit) });
      }
      if (url.pathname === "/api/v1/refresh" && req.method === "POST") {
        await this.orchestrator.forceRefresh();
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === "/api/v1/events" && req.method === "GET") {
        return this.handleSse(req, res);
      }
      if (url.pathname.startsWith("/api/v1/issue/")) {
        const ident = decodeURIComponent(url.pathname.slice("/api/v1/issue/".length));
        const entry = this.orchestrator.findRunningByIdentifier(ident);
        if (!entry) return sendJson(res, 404, { error: "not_running" });
        const snap = this.orchestrator.snapshot();
        const match = snap.running.find((r) => r.issue_identifier === ident);
        return sendJson(res, 200, match || { error: "not_found" });
      }
      // static files
      return await this.serveStatic(url.pathname, res);
    } catch (e: any) {
      log.warn("http_handler_error", { error: e?.message, path: url.pathname });
      sendJson(res, 500, { error: e?.message || "internal_error" });
    }
  }

  private handleSse(req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    res.write(`: connected\n\n`);
    // initial snapshot
    res.write(`event: snapshot\ndata: ${JSON.stringify(this.orchestrator.snapshot())}\n\n`);
    this.sseClients.add(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {}
    }, 15000);
    req.on("close", () => {
      clearInterval(keepAlive);
      this.sseClients.delete(res);
      try {
        res.end();
      } catch {}
    });
  }

  private broadcast(payload: { type: string; data: unknown }) {
    const line = `event: ${payload.type}\ndata: ${JSON.stringify(payload.data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(line);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  private async serveStatic(reqPath: string, res: http.ServerResponse) {
    if (!this.webDir) return sendJson(res, 404, { error: "ui_not_found" });
    let rel = reqPath === "/" || reqPath === "" ? "/index.html" : reqPath;
    if (rel.includes("..")) return sendJson(res, 400, { error: "bad_path" });
    const file = path.join(this.webDir, rel);
    try {
      const data = await fs.readFile(file);
      const mime = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      res.end(data);
    } catch {
      if (rel !== "/index.html") {
        // SPA fallback
        try {
          const idx = await fs.readFile(path.join(this.webDir, "index.html"));
          res.writeHead(200, { "Content-Type": MIME[".html"] });
          res.end(idx);
          return;
        } catch {}
      }
      sendJson(res, 404, { error: "not_found", path: reqPath });
    }
  }
}

async function resolveWebDir(): Promise<string | null> {
  for (const dir of WEB_DIR_CANDIDATES) {
    try {
      const stat = await fs.stat(path.join(dir, "index.html"));
      if (stat.isFile()) return dir;
    } catch {}
  }
  return null;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": MIME[".json"] });
  res.end(JSON.stringify(body, null, 2));
}
