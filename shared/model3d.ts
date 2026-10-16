// Input schema, cross-field checks and text summary for render_3d_model.
// Shared by the MCP server (validation) and the widget (types only).

import { z } from "zod";
import { describeShape, round } from "./describe3d.js";

export const MAX_PARTS = 50;
export const MIN_MM = 0.1;
export const MAX_MM = 1000;
/** Positions may sit further out than a single part is large, but not unboundedly. */
export const MAX_POSITION_MM = 5000;

export const DISCLAIMER =
  "Approximate model from a parametric description. Not an engineering drawing. Check dimensions before printing.";

const mm = (what: string) =>
  z
    .number()
    .min(MIN_MM, `${what} must be at least ${MIN_MM} mm`)
    .max(MAX_MM, `${what} must be at most ${MAX_MM} mm`)
    .describe(`${what} in mm (${MIN_MM}–${MAX_MM})`);

const coord = z
  .number()
  .min(-MAX_POSITION_MM, `coordinates must be within ±${MAX_POSITION_MM} mm`)
  .max(MAX_POSITION_MM, `coordinates must be within ±${MAX_POSITION_MM} mm`);

const angle = z
  .number()
  .min(-360, "angles must be between -360 and 360 degrees")
  .max(360, "angles must be between -360 and 360 degrees");

const Vec3 = z.tuple([coord, coord, coord]);
const Euler = z.tuple([angle, angle, angle]);

// --- Primitives -----------------------------------------------------------
// All shapes use a Z-up frame. Each shape's local origin is documented in
// its description so the model can place parts predictably.

export const BoxShape = z
  .object({
    type: z.literal("box"),
    width: mm("width (X)"),
    depth: mm("depth (Y)"),
    height: mm("height (Z)"),
  })
  .describe("Rectangular block centred on its origin.");

export const CylinderShape = z
  .object({
    type: z.literal("cylinder"),
    diameter: mm("diameter"),
    height: mm("height (Z)"),
  })
  .describe("Cylinder with its axis along Z, centred on its origin.");

export const SphereShape = z
  .object({
    type: z.literal("sphere"),
    diameter: mm("diameter"),
  })
  .describe("Sphere centred on its origin.");

export const ConeShape = z
  .object({
    type: z.literal("cone"),
    baseDiameter: mm("base diameter"),
    topDiameter: mm("top diameter").optional().describe("Omit for a pointed cone; set for a truncated cone (frustum)."),
    height: mm("height (Z)"),
  })
  .describe("Cone with its axis along Z, base at -height/2 and top at +height/2.");

export const GearShape = z
  .object({
    type: z.literal("gear"),
    teeth: z
      .number()
      .int("teeth must be a whole number")
      .min(6, "a gear needs at least 6 teeth")
      .max(200, "a gear can have at most 200 teeth"),
    module: z
      .number()
      .min(0.1, "module must be at least 0.1 mm")
      .max(50, "module must be at most 50 mm")
      .describe("Gear module in mm (pitch diameter = module × teeth). Typical 3D-printed gears use 1–3."),
    thickness: mm("face width / thickness (Z)"),
    bore: mm("bore (centre hole) diameter").optional().describe("Omit for a solid gear."),
  })
  .describe(
    "Involute spur gear (20° pressure angle) with its axis along Z, centred on its origin. " +
      "Outside diameter = module × (teeth + 2).",
  );

export const BracketShape = z
  .object({
    type: z.literal("bracket"),
    length: mm("horizontal leg length (X)"),
    height: mm("vertical leg height (Z)"),
    width: mm("width (Y)"),
    thickness: mm("wall thickness"),
  })
  .describe(
    "L-shaped bracket. Origin at the outside corner: horizontal leg runs along +X, vertical leg along +Z, width centred on Y.",
  );

export const SHAPE_TYPES = ["box", "cylinder", "sphere", "cone", "gear", "bracket"] as const;

export const Shape = z.discriminatedUnion(
  "type",
  [BoxShape, CylinderShape, SphereShape, ConeShape, GearShape, BracketShape],
  { error: `shape.type must be one of: ${SHAPE_TYPES.join(", ")}` },
);

export const Joint = z
  .object({
    type: z
      .enum(["fixed", "rotating"])
      .describe("fixed: rigidly attached to the parent. rotating: spins about `axis` (the viewer shows an angle slider)."),
    axis: z
      .enum(["x", "y", "z"])
      .default("z")
      .describe("Joint axis in this part's own frame. Also the direction the part moves in exploded view."),
    angle: angle.default(0).describe("Initial joint angle in degrees (rotating joints only)."),
  })
  .describe("How this part connects to its parent.");

export const Part = z.object({
  name: z
    .string()
    .trim()
    .min(1, "name must not be empty")
    .max(40, "name must be at most 40 characters")
    .describe("Unique part name, used for `parent` references and the part list."),
  shape: Shape,
  position: Vec3.default([0, 0, 0]).describe(
    "[x, y, z] in mm. Relative to the parent's origin when `parent` is set, otherwise world coordinates.",
  ),
  rotation: Euler.default([0, 0, 0]).describe("[rx, ry, rz] Euler angles in degrees, applied in XYZ order."),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "color must be a hex colour like #3b82f6")
    .default("#9aa4b2")
    .describe("Hex colour like #3b82f6."),
  parent: z.string().optional().describe("Name of the parent part. The part moves and rotates with its parent."),
  joint: Joint.optional().describe("Only valid together with `parent`. Defaults to a fixed joint about Z."),
});

export const ModelInput = z
  .object({
    title: z.string().trim().max(80, "title must be at most 80 characters").optional(),
    parts: z
      .array(Part)
      .min(1, "a model needs at least one part")
      .max(MAX_PARTS, `a model can have at most ${MAX_PARTS} parts; merge or drop parts and retry`),
  })
  .superRefine((model, ctx) => {
    for (const issue of checkModel(model)) ctx.addIssue({ code: "custom", ...issue });
  });

export type ModelInput = z.infer<typeof ModelInput>;
export type PartInput = z.infer<typeof Part>;
export type ShapeInput = z.infer<typeof Shape>;

interface ModelIssue {
  path: (string | number)[];
  message: string;
}

/** Cross-field rules that a per-field schema cannot express. */
export function checkModel(model: { parts: PartInput[] }): ModelIssue[] {
  const issues: ModelIssue[] = [];
  const byName = new Map<string, number>();

  model.parts.forEach((part, i) => {
    if (byName.has(part.name)) {
      issues.push({
        path: ["parts", i, "name"],
        message: `duplicate part name "${part.name}" (also used by parts[${byName.get(part.name)}]); give every part a unique name`,
      });
    } else {
      byName.set(part.name, i);
    }
  });

  model.parts.forEach((part, i) => {
    const at = (field: string) => ["parts", i, field];
    const s = part.shape;

    if (part.parent !== undefined) {
      if (part.parent === part.name) {
        issues.push({ path: at("parent"), message: `part "${part.name}" cannot be its own parent` });
      } else if (!byName.has(part.parent)) {
        issues.push({
          path: at("parent"),
          message: `parent "${part.parent}" does not match any part name; use one of: ${[...byName.keys()].join(", ")}`,
        });
      }
    }
    if (part.joint && part.parent === undefined) {
      issues.push({ path: at("joint"), message: `part "${part.name}" has a joint but no parent; add "parent" or remove "joint"` });
    }

    if (s.type === "gear") {
      const outside = s.module * (s.teeth + 2);
      const root = s.module * (s.teeth - 2.5);
      if (outside > MAX_MM) {
        issues.push({
          path: at("shape"),
          message: `gear "${part.name}" outside diameter is ${round(outside)} mm (module × (teeth + 2)), above the ${MAX_MM} mm limit; reduce module or teeth`,
        });
      }
      if (s.bore !== undefined && s.bore > 0.8 * root) {
        issues.push({
          path: at("shape"),
          message: `gear "${part.name}" bore ${s.bore} mm is too large for a root diameter of ${round(root)} mm; use a bore of at most ${round(0.8 * root)} mm`,
        });
      }
    }
    if (s.type === "bracket" && (s.thickness >= s.length || s.thickness >= s.height)) {
      issues.push({
        path: at("shape"),
        message: `bracket "${part.name}" thickness (${s.thickness} mm) must be smaller than both length (${s.length} mm) and height (${s.height} mm)`,
      });
    }
  });

  // Parent cycles (a → b → a). Only meaningful when all parents exist.
  model.parts.forEach((part, i) => {
    const seen = new Set<string>([part.name]);
    let cursor = part.parent;
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        issues.push({
          path: ["parts", i, "parent"],
          message: `parent chain starting at "${part.name}" loops back on itself; parents must form a tree`,
        });
        break;
      }
      seen.add(cursor);
      const next = byName.get(cursor);
      cursor = next === undefined ? undefined : model.parts[next]?.parent;
    }
  });

  return issues;
}

/** Plain-text fallback for clients that cannot show the widget. */
export function summarizeModel(model: ModelInput): string {
  const lines = model.parts.map((p) => {
    const link = p.parent ? ` (on "${p.parent}", ${p.joint?.type ?? "fixed"} joint)` : "";
    return `- ${p.name}: ${describeShape(p.shape)}${link}`;
  });
  const heading = `${model.title ?? "Model"}: ${model.parts.length} part${model.parts.length === 1 ? "" : "s"}, units mm.`;
  return [heading, ...lines, DISCLAIMER].join("\n");
}
