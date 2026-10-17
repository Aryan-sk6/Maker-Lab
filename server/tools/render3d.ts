// Tool 1: render_3d_model. Builds a 3D model, and for mechanisms (gears, belts, racks) works out the layout and
// the motion, then hands it to the Three.js widget where students can turn it.

import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { DISCLAIMER, Driver, Link, MAX_PARTS, ModelInput, Part, summarizeModel } from "../../shared/model3d.js";
import { buildMechanism } from "../../shared/mechanism.js";
import { describeMotion } from "../../shared/kinematics.js";
import { loadWidget } from "../widgets.js";

// Bump the version suffix whenever the widget changes in a breaking way: hosts cache by URI.
export const MODEL_VIEWER_URI = "ui://maker-lab/model-viewer-v2.html";

const ModelOutput = z.object({
  title: z.string().optional(),
  units: z.literal("mm"),
  disclaimer: z.string(),
  parts: z.array(Part.extend({ autoPlaced: z.boolean().optional() })).describe("Every part with its final position, rotation, joint and colour."),
  links: z.array(Link),
  driver: Driver.optional(),
  motion: z
    .object({
      driver: z.object({ part: z.string(), rpm: z.number() }),
      turning: z.array(z.object({ part: z.string(), turnsPerDriverTurn: z.number(), rpm: z.number(), direction: z.enum(["driver", "same", "opposite"]), carries: z.array(z.string()) })),
      sliding: z.array(z.object({ part: z.string(), mmPerDriverTurn: z.number(), mmPerSecond: z.number(), travelMm: z.number() })),
      belts: z.array(z.object({ a: z.string(), b: z.string(), crossed: z.boolean(), lengthMm: z.number() })),
      explanation: z.array(z.string()).describe("One plain sentence per moving part, computed from tooth counts and sizes."),
    })
    .nullable()
    .describe("Null for a model with no links."),
  notes: z.array(z.string()).describe("What the layout did automatically, and warnings."),
});

const DESCRIPTION = `Build an interactive 3D model, including working mechanisms (gears, belts, racks) that the user can turn.

Use this whenever someone wants to see or play with a physical thing or a machine: "make a big gear turn a small one", "show me a gear train", "how does a bike chain change speed", "build a box with a lid", "a car steering rack". Users may be children giving vague instructions: just pick sensible parts and sizes yourself and call the tool. Do not ask them for measurements.

KEEP IT SIMPLE. For mechanisms you only list parts and say how they connect. Leave out position, rotation, joint and color: linked parts are placed automatically at exactly the right distance, set free to turn, and coloured. Shape fields have defaults too (gear: 20 teeth, module 2; pulley: 40 mm; rack: 120 mm).

Recipes:
- Two gears: parts [{"name":"big","shape":{"type":"gear","teeth":40}}, {"name":"small","shape":{"type":"gear","teeth":10}}], links [{"type":"mesh","a":"big","b":"small"}]
- Gear train (two gears on one axle turn together): add {"type":"axle","a":"big2","b":"small2"} between meshes, e.g. mesh A–B, axle B–C, mesh C–D.
- Belt drive: two parts with shape {"type":"pulley","diameter":30} and {"type":"pulley","diameter":90}, link {"type":"belt","a":...,"b":...}. Add "crossed": true to reverse direction.
- Rack and pinion (turning becomes sliding): a gear and {"type":"rack","length":150}, link {"type":"rack","pinion":"gear name","rack":"rack name"}.
- Choose who turns it: "driver": {"part":"name","rpm":30}. Otherwise the first part of the first link drives.
Gears that mesh must have the same module (leave module out and they will). Avoid loops of three meshing gears: they jam.

Static models: box, cylinder, sphere, cone, bracket (and the parts above) with "position" [x,y,z] in mm and "rotation" in degrees. Z is up. Use "parent" to attach a part to another. At most ${MAX_PARTS} parts.

The result says, in plain sentences, how fast and which way every part turns (computed, not guessed): use those sentences when explaining. In the widget the user can press Play, drag a slider to turn the driver, click a part to see its speed, and press − / + to change a gear's teeth and watch the mechanism rearrange. If the tool returns an error, it says exactly what to change: fix that and call again.

This is an approximate learning model, not an engineering drawing; never claim it is accurate, safe or ready to manufacture.`;

export function registerRender3d(server: McpServer): void {
  registerAppResource(
    server,
    "Maker Lab 3D model viewer",
    MODEL_VIEWER_URI,
    { description: "Three.js viewer for render_3d_model results.", mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: MODEL_VIEWER_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: loadWidget("model-viewer"),
          _meta: {
            ui: {
              // Three.js is bundled into the HTML and STL export happens in the browser,
              // so this widget needs no network access at all.
              csp: { connectDomains: [], resourceDomains: [] },
              prefersBorder: true,
            },
          },
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "render_3d_model",
    {
      title: "Build 3D model or mechanism",
      description: DESCRIPTION,
      inputSchema: ModelInput,
      outputSchema: ModelOutput,
      annotations: {
        title: "Build 3D model or mechanism",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: MODEL_VIEWER_URI } },
    },
    async (input) => {
      const m = buildMechanism(input);
      if ("issues" in m) throw new Error(m.issues.map((i) => i.message).join("; ")); // unreachable: the schema already ran this
      const k = m.kinematics;
      const explanation = k ? describeMotion(k) : [];
      return {
        content: [{ type: "text" as const, text: summarizeModel(m, explanation, m.notes) }],
        structuredContent: {
          title: m.title,
          units: "mm" as const,
          disclaimer: DISCLAIMER,
          parts: m.parts,
          links: m.links,
          ...(m.driver ? { driver: m.driver } : {}),
          motion: k
            ? {
                driver: { part: k.driver.part, rpm: k.driver.rpm },
                turning: k.rotors.map((r) => ({
                  part: r.name,
                  turnsPerDriverTurn: Math.abs(r.ratio),
                  rpm: Math.abs(r.ratio) * k.driver.rpm,
                  direction: r.direction,
                  carries: r.parts.filter((p) => p !== r.name),
                })),
                sliding: k.racks.map((rk) => {
                  const perTurn = Math.abs(rk.mmPerRad * k.rotors.find((r) => r.name === rk.rotor)!.ratio * 2 * Math.PI);
                  return { part: rk.name, mmPerDriverTurn: perTurn, mmPerSecond: (perTurn * k.driver.rpm) / 60, travelMm: rk.maxD - rk.minD };
                }),
                belts: k.belts.map((b) => ({ a: b.a, b: b.b, crossed: b.crossed, lengthMm: b.length })),
                explanation,
              }
            : null,
          notes: m.notes,
        },
      };
    },
  );
}
