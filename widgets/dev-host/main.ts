// Minimal MCP Apps host for local development (served at /dev when NODE_ENV is not "production").

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AppBridge, PostMessageTransport, getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiResourceCsp } from "@modelcontextprotocol/ext-apps";
import { DEMO_MODEL } from "../model-viewer/demo.js";

const EXAMPLES: Record<string, unknown> = {
  render_3d_model: DEMO_MODEL,
  run_simulation: { system: "pendulum", parameters: { length_m: 1, theta0_deg: 40, damping_per_s: 0.1 } },
  show_molecule: { compound_name: "caffeine" },
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const toolSelect = $<HTMLSelectElement>("tool");
const themeSelect = $<HTMLSelectElement>("theme");
const args = $<HTMLTextAreaElement>("args");
const frame = $<HTMLIFrameElement>("frame");
const status = $<HTMLParagraphElement>("status");
const text = $<HTMLPreElement>("text");

const client = new Client({ name: "maker-lab-dev-host", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", location.href)));
const { tools } = await client.listTools();

for (const tool of tools) toolSelect.add(new Option(tool.name, tool.name));
const fillExample = () => (args.value = JSON.stringify(EXAMPLES[toolSelect.value] ?? {}, null, 2));
toolSelect.addEventListener("change", fillExample);
fillExample();

let bridge: AppBridge | undefined;
themeSelect.addEventListener("change", () => {
  document.documentElement.dataset.theme = themeSelect.value;
  bridge?.setHostContext({ theme: themeSelect.value as "light" | "dark" });
});
document.documentElement.dataset.theme = themeSelect.value;

/** Build a CSP like a real host would, from the resource's _meta.ui.csp. */
function cspFor(csp: McpUiResourceCsp | undefined): string {
  const res = (csp?.resourceDomains ?? []).join(" ");
  const conn = (csp?.connectDomains ?? []).join(" ");
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${res}`,
    `style-src 'unsafe-inline' ${res}`,
    `img-src data: blob: ${res}`,
    `font-src data: ${res}`,
    `connect-src ${conn || "'none'"}`,
  ].join("; ");
}

$<HTMLButtonElement>("run").addEventListener("click", async () => {
  const tool = tools.find((t) => t.name === toolSelect.value)!;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(args.value);
  } catch (err) {
    status.textContent = `Arguments are not valid JSON: ${String(err)}`;
    return;
  }

  status.textContent = "Calling tool…";
  const result = await client.callTool({ name: tool.name, arguments: parsed });
  text.textContent = (result.content as { type: string; text?: string }[]).map((c) => c.text ?? `[${c.type}]`).join("\n");

  const uri = getToolUiResourceUri(tool);
  if (!uri) {
    status.textContent = "This tool has no widget.";
    return;
  }
  const resource = (await client.readResource({ uri })).contents[0] as { text: string; _meta?: { ui?: { csp?: McpUiResourceCsp } } };
  const csp = cspFor(resource._meta?.ui?.csp);
  const html = resource.text.replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);

  await bridge?.close();
  bridge = new AppBridge(client, { name: "maker-lab-dev-host", version: "0.1.0" }, { openLinks: {}, serverTools: {}, downloadFile: {}, logging: {} }, {
    hostContext: { theme: themeSelect.value as "light" | "dark", displayMode: "inline", availableDisplayModes: ["inline"] },
  });
  bridge.oninitialized = () => {
    bridge!.sendToolInput({ arguments: parsed });
    bridge!.sendToolResult(result as Parameters<AppBridge["sendToolResult"]>[0]);
    status.textContent = `${result.isError ? "Tool returned an error" : "Rendered"} · CSP: ${csp}`;
  };
  bridge.onsizechange = ({ height }) => {
    if (height) frame.style.height = `${Math.min(height, 900)}px`;
  };
  bridge.ondownloadfile = async ({ contents }) => {
    for (const item of contents) {
      if (item.type !== "resource" || !("blob" in item.resource)) continue;
      const bytes = Uint8Array.from(atob(item.resource.blob), (c) => c.charCodeAt(0));
      const a = Object.assign(document.createElement("a"), {
        href: URL.createObjectURL(new Blob([bytes], { type: item.resource.mimeType })),
        download: item.resource.uri.split("/").pop() ?? "download",
      });
      a.click();
      status.textContent = `Widget downloaded ${a.download} (${bytes.length} bytes)`;
    }
    return {};
  };

  // Listen before loading the widget so its ui/initialize request is not missed.
  await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  frame.srcdoc = html;
});
