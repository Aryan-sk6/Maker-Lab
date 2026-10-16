// Tool 1: render_3d_model. Validates a parametric part list and hands it to the Three.js widget.

import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { DISCLAIMER, MAX_PARTS, MAX_MM, MIN_MM, ModelInput, Part, summarizeModel } from "../../shared/model3d.js";
import { loadWidget } from "../widgets.js";

// Bump the version suffix whenever the widget changes in a breaking way: hosts cache by URI.
export const MODEL_VIEWER_URI = "ui://maker-lab/model-viewer-v1.html";

const ModelOutput = z.object({
  title: z.string().optional(),
  units: z.literal("mm"),
  disclaimer: z.string(),
  parts: z.array(Part),
});

const DESCRIPTION = `Show an interactive 3D preview of a simple mechanical assembly built from parametric primitives.

Use this when the user wants to see, sketch or iterate on a physical object (enclosure, bracket, gear train, toy, jig) and the shape can be described with these primitives: box, cylinder, sphere, cone, gear (involute spur gear) and bracket (L-shaped). Do not use it for organic shapes, text, threads or anything that needs CAD-level precision.

Units are millimetres. The frame is Z-up. Every dimension must be between ${MIN_MM} and ${MAX_MM} mm, and a model has at most ${MAX_PARTS} parts. Shape origins: box, cylinder, sphere, cone and gear are centred on their origin (cylinder, cone and gear axes along Z); bracket has its origin at the outside corner with legs along +X and +Z.

To attach a part to another, set "parent" to the parent's name; "position" and "rotation" are then relative to the parent, and the part moves with it. Use joint.type "rotating" for wheels, gears and hinges so the user can turn them. For two meshing spur gears with the same module, place their centres module × (teeth1 + teeth2) / 2 apart.

The widget offers orbit/zoom, an exploded view, a part list and client-side STL export. The result is an approximate visual model, not an engineering drawing; never claim it is accurate, safe or ready to manufacture.`;

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
      title: "Render 3D model",
      description: DESCRIPTION,
      inputSchema: ModelInput,
      outputSchema: ModelOutput,
      annotations: {
        title: "Render 3D model",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: MODEL_VIEWER_URI } },
    },
    async (model) => ({
      content: [{ type: "text", text: summarizeModel(model) }],
      structuredContent: {
        title: model.title,
        units: "mm" as const,
        disclaimer: DISCLAIMER,
        parts: model.parts,
      },
    }),
  );
}
