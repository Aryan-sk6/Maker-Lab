// Protocol-level test: connects a real MCP client to the server in memory.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createMakerLabServer } from "./mcp.js";
import { MODEL_VIEWER_URI } from "./tools/render3d.js";
import { SIMULATION_URI } from "./tools/simulation.js";
import { MOLECULE_URI } from "./tools/molecule.js";
import type { SimulationOutput } from "../shared/simulation.js";
import { DEMO_MODEL } from "../widgets/model-viewer/demo.js";

// The real widget is a build artefact; the protocol test only needs some HTML.
vi.mock("./widgets.js", () => ({ loadWidget: () => "<!doctype html><title>stub</title>" }));

let client: Client;

beforeAll(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMakerLabServer().connect(serverSide);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
});

describe("render_3d_model over MCP", () => {
  it("is listed with a widget link and read-only annotations", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "render_3d_model");
    expect(tool?._meta).toMatchObject({ ui: { resourceUri: MODEL_VIEWER_URI } });
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(tool?.inputSchema.properties).toHaveProperty("parts");
  });

  it("serves the widget as an MCP Apps resource with a CSP", async () => {
    const { contents } = await client.readResource({ uri: MODEL_VIEWER_URI });
    expect(contents[0]).toMatchObject({
      mimeType: RESOURCE_MIME_TYPE,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
    });
  });

  it("returns structured content plus a text summary", async () => {
    const result = await client.callTool({ name: "render_3d_model", arguments: DEMO_MODEL });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ units: "mm", parts: expect.any(Array) });
    expect(JSON.stringify(result.content)).toContain("7 parts");
  });

  it("returns a readable error the model can act on", async () => {
    const result = await client.callTool({
      name: "render_3d_model",
      arguments: { parts: [{ name: "g", shape: { type: "gear", teeth: 3, module: 1, thickness: 0 } }] },
    });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("a gear needs at least 6 teeth");
    expect(text).toContain("must be at least 0.1 mm");
  });
});

describe("run_simulation over MCP", () => {
  it("is listed with a widget link, read-only annotations and a top-level object schema", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "run_simulation");
    expect(tool?._meta).toMatchObject({ ui: { resourceUri: SIMULATION_URI } });
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(tool?.inputSchema.type).toBe("object");
    expect(tool?.inputSchema.properties).toHaveProperty("system");
    expect(tool?.description).toContain("never invent");
    expect(tool?.description).toContain("capacitance_F (F, default 1e-6)");
  });

  it("serves a widget resource with an empty CSP allow-list", async () => {
    const { contents } = await client.readResource({ uri: SIMULATION_URI });
    expect(contents[0]).toMatchObject({ mimeType: RESOURCE_MIME_TYPE, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } });
  });

  it("returns solver output: key values, checkpoints and a text report", async () => {
    const result = await client.callTool({
      name: "run_simulation",
      arguments: { system: "rc_circuit", parameters: { resistance_ohm: 1000, capacitance_F: 1e-6, voltage_V: 5 } },
    });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as SimulationOutput;
    expect(out.keyValues.find((k) => k.key === "tau")?.value).toBeCloseTo(1e-3, 12);
    expect(out.parameters).toMatchObject({ voltage_V: 5, vc0_V: 0 });
    expect(out.checkpoints.rows).toHaveLength(9);
    expect(out.checkpoints.rows[8]![1]).toBeGreaterThan(4.9); // V_C after 6τ
    expect(JSON.stringify(result.content)).toContain("Educational model with simplifying assumptions.");
  });

  it("returns a readable error the model can act on", async () => {
    const result = await client.callTool({ name: "run_simulation", arguments: { system: "projectile", parameters: { speed_ms: 0, angle_deg: 120 } } });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("speed_ms must be between 0.1 and 1000 m/s");
    expect(text).toContain("angle_deg must be between -90 and 90");
  });
});

describe("show_molecule over MCP (no network: only paths that never reach RCSB or PubChem)", () => {
  it("is listed with a widget link, annotations that say it uses the open internet, and an object schema", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "show_molecule");
    expect(tool?._meta).toMatchObject({ ui: { resourceUri: MOLECULE_URI } });
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    expect(tool?.inputSchema.type).toBe("object");
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(["compound_name", "pdb_id", "smiles"]);
    expect(tool?.description).toContain("do not guess");
  });

  it("declares exactly the two data hosts in the widget CSP", async () => {
    const { contents } = await client.readResource({ uri: MOLECULE_URI });
    expect(contents[0]).toMatchObject({
      mimeType: RESOURCE_MIME_TYPE,
      _meta: { ui: { csp: { connectDomains: ["https://files.rcsb.org", "https://pubchem.ncbi.nlm.nih.gov"], resourceDomains: [] } } },
    });
  });

  it("rejects bad input with a message the model can act on, before any network call", async () => {
    const both = await client.callTool({ name: "show_molecule", arguments: { pdb_id: "4HHB", smiles: "CCO" } });
    expect(both.isError).toBe(true);
    expect(JSON.stringify(both.content)).toContain("not pdb_id and smiles");

    const badId = await client.callTool({ name: "show_molecule", arguments: { pdb_id: "hemoglobin" } });
    expect(badId.isError).toBe(true);
    expect(JSON.stringify(badId.content)).toContain("pdb_id must be 4 characters");
  });
});

