// Builds the Maker Lab MCP server. A fresh instance is created per HTTP request (stateless).

import { McpServer } from "@modelcontextprotocol/server";
import { registerRender3d } from "./tools/render3d.js";
import { registerMolecule } from "./tools/molecule.js";
import { registerSimulation } from "./tools/simulation.js";

export const SERVER_INFO = { name: "maker-lab", version: "0.4.0" };

export function createMakerLabServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Maker Lab renders educational visualisations. Results are approximate and for learning only: " +
      "never present them as accurate, safe, or suitable for engineering or medical use.",
  });
  registerRender3d(server);
  registerSimulation(server);
  registerMolecule(server);
  return server;
}
