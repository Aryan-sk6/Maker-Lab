// HTTP entry point: serves the MCP endpoint at /mcp over Streamable HTTP.

import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMakerLabServer, SERVER_INFO } from "./mcp.js";
import { loadWidget } from "./widgets.js";

const PORT = Number(process.env.PORT ?? 8787);
// 127.0.0.1 locally (with DNS-rebinding protection). Set HOST=0.0.0.0 and ALLOWED_HOSTS when deploying.
const HOST = process.env.HOST ?? "127.0.0.1";
const ALLOWED_HOSTS = process.env.ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean);

const app = createMcpExpressApp({ host: HOST, allowedHosts: ALLOWED_HOSTS });

// One server instance per request: no sessions, no stored user data.
const mcp = toNodeHandler(
  createMcpHandler(() => createMakerLabServer(), {
    onerror: (err) => console.error("[mcp]", err.message),
  }),
);
app.all("/mcp", (req, res) => mcp(req, res, req.body));

// Local test host (see widgets/dev-host). Not served in production.
if (process.env.NODE_ENV !== "production") {
  app.get("/dev", (_req, res) => {
    res.type("html").send(loadWidget("dev-host"));
  });
}

app.get("/", (_req, res) => {
  res.type("text/plain").send(`${SERVER_INFO.name} ${SERVER_INFO.version}. MCP endpoint: /mcp`);
});

app.listen(PORT, HOST, () => {
  const base = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
  console.log(`Maker Lab MCP server on ${base}/mcp`);
  if (process.env.NODE_ENV !== "production") console.log(`Local test host on ${base}/dev`);
});
