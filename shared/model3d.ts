// Input schema, cross-field checks and text summary for render_3d_model.
// The schema is deliberately forgiving: almost everything has a default, and parts that are linked
// (meshing gears, belts, racks, shared axles) are placed automatically by shared/mechanism.ts.

import { z } from "zod";
import { describeShape, round } from "./describe3d.js";
import { buildMechanism } from "./mechanism.js";
import { SHAPE_DEFAULTS as D } from "./defaults.js";

export const MAX_PARTS = 50;
export const MAX_LINKS = 60;
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

const module_ = z
  .number()
  .min(0.5, "module must be at least 0.5 mm")
  .max(20, "module must be at most 20 mm")
  .describe(`Tooth size in mm (default ${D.gear.module}). Gears and racks that mesh must use the same module.`);

const Vec3 = z.tuple([coord, coord, coord]);
const Euler = z.tuple([angle, angle, angle]);
const partName = z.string().trim().min(1, "part names must not be empty");

// --- Primitives -----------------------------------------------------------
// All shapes use a Z-up frame. Each shape's local origin is documented in its description.

export const BoxShape = z
  .object({ type: z.literal("box"), width: mm("width (X)"), depth: mm("depth (Y)"), height: mm("height (Z)") })
  .describe("Rectangular block centred on its origin.");

export const CylinderShape = z
  .object({ type: z.literal("cylinder"), diameter: mm("diameter"), height: mm("height (Z)") })
  .describe("Cylinder with its axis along Z, centred on its origin. Good for axles and posts.");

export const SphereShape = z.object({ type: z.literal("sphere"), diameter: mm("diameter") }).describe("Sphere centred on its origin.");

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
    teeth: z.number().int("teeth must be a whole number").min(8, "a gear needs at least 8 teeth").max(150, "a gear can have at most 150 teeth").default(D.gear.teeth),
    module: module_.default(D.gear.module),
    thickness: mm("thickness along the axle").default(D.gear.thickness),
    bore: mm("centre hole diameter").optional().describe("Omit for a solid gear."),
  })
  .describe("Spur gear with its axle along Z, centred on its origin. Size = module × teeth (pitch diameter). Defaults: 20 teeth, module 2, 6 mm thick.");

export const PulleyShape = z
  .object({
    type: z.literal("pulley"),
    diameter: mm("diameter where the belt runs").default(D.pulley.diameter),
    width: mm("width along the axle").default(D.pulley.width),
    bore: mm("centre hole diameter").optional(),
  })
  .describe("Belt pulley with its axle along Z, centred on its origin. Defaults: 40 mm diameter, 10 mm wide.");

export const RackShape = z
  .object({
    type: z.literal("rack"),
    length: mm("length (X)").default(D.rack.length),
    module: module_.default(D.rack.module),
    height: mm("height from the base to the pitch line (Y)").default(D.rack.height),
    thickness: mm("thickness (Z)").default(D.rack.thickness),
  })
  .describe("Straight toothed bar that slides along X when a gear (the pinion) turns it. Teeth point +Y; origin at the middle of the pitch line.");

export const BracketShape = z
  .object({
    type: z.literal("bracket"),
    length: mm("horizontal leg length (X)"),
    height: mm("vertical leg height (Z)"),
    width: mm("width (Y)"),
    thickness: mm("wall thickness"),
  })
  .describe("L-shaped bracket. Origin at the outside corner: horizontal leg runs along +X, vertical leg along +Z, width centred on Y.");

export const SHAPE_TYPES = ["box", "cylinder", "sphere", "cone", "gear", "pulley", "rack", "bracket"] as const;

export const Shape = z.discriminatedUnion("type", [BoxShape, CylinderShape, SphereShape, ConeShape, GearShape, PulleyShape, RackShape, BracketShape], {
  error: `shape.type must be one of: ${SHAPE_TYPES.join(", ")}`,
});

export const Joint = z
  .object({
    type: z.enum(["fixed", "rotating"]).describe("fixed: rigidly attached to the parent. rotating: spins about `axis`."),
    axis: z.enum(["x", "y", "z"]).default("z").describe("Joint axis in this part's own frame. Also the direction the part moves in exploded view."),
    angle: angle.default(0).describe("Initial joint angle in degrees (rotating joints that are not driven by links)."),
  })
  .describe("Usually leave this out: linked gears and pulleys are made free to turn automatically.");

export const Part = z.object({
  name: z.string().trim().min(1, "name must not be empty").max(40, "name must be at most 40 characters").describe("Unique part name, used by links, `parent` and the part list."),
  shape: Shape,
  position: Vec3.optional().describe(
    "[x, y, z] in mm, relative to the parent if there is one. Leave it out for linked parts: they are placed automatically so they mesh. Unlinked parts without a position go to [0, 0, 0].",
  ),
  rotation: Euler.default([0, 0, 0]).describe("[rx, ry, rz] Euler angles in degrees, XYZ order."),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must be a hex colour like #3b82f6").optional().describe("Hex colour like #3b82f6. Omit for an automatic colour."),
  parent: z.string().optional().describe("Name of a part this one is attached to; it moves with that part."),
  joint: Joint.optional(),
});

const linkAngle = angle.optional().describe("Direction in degrees from the first part to the second, in the first part's plane (0 = its +X). Omit to let the layout pick a free spot.");

export const Link = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("mesh"), a: partName, b: partName, angle: linkAngle }).describe("Gear a and gear b mesh (their teeth interlock)."),
    z
      .object({
        type: z.literal("belt"),
        a: partName,
        b: partName,
        crossed: z.boolean().default(false).describe("Crossed belt: the second pulley turns the other way."),
        distance: mm("distance between pulley centres").optional().describe("Omit for a sensible default."),
        angle: linkAngle,
      })
      .describe("A belt joins pulley a and pulley b."),
    z.object({ type: z.literal("rack"), pinion: partName, rack: partName, angle: linkAngle }).describe("Gear `pinion` drives the rack, which slides."),
    z
      .object({
        type: z.literal("axle"),
        a: partName,
        b: partName,
        offset: z.number().min(-1000).max(1000).optional().describe("Distance in mm along the axle from a to b. Omit to stack b right next to a."),
      })
      .describe("Part b is fixed on the same axle as part a, so they turn together (for compound gear trains)."),
  ],
  { error: "each link's type must be one of: mesh, belt, rack, axle" },
);

export const Driver = z
  .object({
    part: partName.describe("The gear or pulley the student turns (usually the first one)."),
    rpm: z.number().min(1, "rpm must be at least 1").max(600, "rpm must be at most 600").default(30).describe("Speed of the driver when the animation plays (default 30)."),
  })
  .describe("Optional. Defaults to the first part of the first link.");

export const ModelInput = z
  .object({
    title: z.string().trim().max(80, "title must be at most 80 characters").optional(),
    parts: z.array(Part).min(1, "a model needs at least one part").max(MAX_PARTS, `a model can have at most ${MAX_PARTS} parts; merge or drop parts and retry`),
    links: z.array(Link).max(MAX_LINKS, `at most ${MAX_LINKS} links`).default([]).describe("How parts connect and drive each other. Leave out for a model that does not move."),
    driver: Driver.optional(),
  })
  .superRefine((model, ctx) => {
    const basic = checkModel(model);
    for (const issue of basic) ctx.addIssue({ code: "custom", ...issue });
    if (basic.length > 0) return;
    const built = buildMechanism(model);
    if ("issues" in built) for (const issue of built.issues) ctx.addIssue({ code: "custom", ...issue });
  });

export type ModelInput = z.infer<typeof ModelInput>;
export type PartInput = z.infer<typeof Part>;
export type ShapeInput = z.infer<typeof Shape>;
export type LinkInput = z.infer<typeof Link>;

interface ModelIssue {
  path: (string | number)[];
  message: string;
}

/** Cross-field rules that a per-field schema cannot express. Motion checks happen later, in buildMechanism. */
export function checkModel(model: { parts: PartInput[]; links?: LinkInput[]; driver?: { part: string } }): ModelIssue[] {
  const issues: ModelIssue[] = [];
  const byName = new Map<string, number>();

  model.parts.forEach((part, i) => {
    if (byName.has(part.name)) {
      issues.push({ path: ["parts", i, "name"], message: `duplicate part name "${part.name}" (also used by parts[${byName.get(part.name)}]); give every part a unique name` });
    } else {
      byName.set(part.name, i);
    }
  });
  const known = (name: string) => byName.has(name);
  const listNames = () => [...byName.keys()].join(", ");

  model.parts.forEach((part, i) => {
    const at = (field: string) => ["parts", i, field];
    const s = part.shape;

    if (part.parent !== undefined) {
      if (part.parent === part.name) issues.push({ path: at("parent"), message: `part "${part.name}" cannot be its own parent` });
      else if (!known(part.parent)) issues.push({ path: at("parent"), message: `parent "${part.parent}" does not match any part name; use one of: ${listNames()}` });
    }
    if (part.joint?.type === "fixed" && part.parent === undefined) {
      issues.push({ path: at("joint"), message: `part "${part.name}" has a fixed joint but no parent; add "parent" or remove "joint"` });
    }

    if (s.type === "gear") {
      const outside = s.module * (s.teeth + 2);
      const root = s.module * (s.teeth - 2.5);
      if (outside > MAX_MM) {
        issues.push({ path: at("shape"), message: `gear "${part.name}" is ${round(outside)} mm across (module × (teeth + 2)), above the ${MAX_MM} mm limit; use fewer teeth or a smaller module` });
      }
      if (s.bore !== undefined && s.bore > 0.8 * root) {
        issues.push({ path: at("shape"), message: `gear "${part.name}" centre hole (${s.bore} mm) is too big; use at most ${round(0.8 * root)} mm or leave bore out` });
      }
    }
    if (s.type === "pulley" && s.bore !== undefined && s.bore > 0.8 * s.diameter) {
      issues.push({ path: at("shape"), message: `pulley "${part.name}" centre hole must be smaller than ${round(0.8 * s.diameter)} mm` });
    }
    if (s.type === "rack") {
      if (s.height < 1.5 * s.module) issues.push({ path: at("shape"), message: `rack "${part.name}" height must be at least ${round(1.5 * s.module)} mm (1.5 × module) to have room for its teeth` });
      if (s.length < 3 * Math.PI * s.module) issues.push({ path: at("shape"), message: `rack "${part.name}" is too short for 3 teeth; make it at least ${round(3 * Math.PI * s.module)} mm long` });
    }
    if (s.type === "bracket" && (s.thickness >= s.length || s.thickness >= s.height)) {
      issues.push({ path: at("shape"), message: `bracket "${part.name}" thickness (${s.thickness} mm) must be smaller than both length (${s.length} mm) and height (${s.height} mm)` });
    }
  });

  // Parent cycles (a → b → a).
  model.parts.forEach((part, i) => {
    const seen = new Set<string>([part.name]);
    let cursor = part.parent;
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        issues.push({ path: ["parts", i, "parent"], message: `parent chain starting at "${part.name}" loops back on itself; parents must form a tree` });
        break;
      }
      seen.add(cursor);
      const next = byName.get(cursor);
      cursor = next === undefined ? undefined : model.parts[next]?.parent;
    }
  });

  (model.links ?? []).forEach((link, i) => {
    const ends: [string, string][] =
      link.type === "rack" ? [["pinion", link.pinion], ["rack", link.rack]] : [["a", link.a], ["b", link.b]];
    for (const [field, name] of ends) {
      if (!known(name)) issues.push({ path: ["links", i, field], message: `link ${i} refers to "${name}", which is not a part; use one of: ${listNames()}` });
    }
    const [[, first], [, second]] = ends as [[string, string], [string, string]];
    if (first === second) issues.push({ path: ["links", i], message: `link ${i} connects "${first}" to itself` });
  });
  if (model.driver && !known(model.driver.part)) {
    issues.push({ path: ["driver", "part"], message: `driver "${model.driver.part}" is not a part; use one of: ${listNames()}` });
  }
  return issues;
}

/** Plain-text fallback for clients that cannot show the widget. */
export function summarizeModel(
  model: { title?: string; parts: { name: string; shape: ShapeInput; parent?: string; joint?: { type: string } }[] },
  motionLines: string[],
  notes: string[],
): string {
  const lines = model.parts.map((p) => {
    const link = p.parent ? ` (on "${p.parent}"${p.joint?.type === "rotating" ? ", turns" : ""})` : p.joint?.type === "rotating" ? " (turns)" : "";
    return `- ${p.name}: ${describeShape(p.shape)}${link}`;
  });
  const heading = `${model.title ?? "Model"}: ${model.parts.length} part${model.parts.length === 1 ? "" : "s"}, units mm.`;
  return [
    heading,
    ...lines,
    ...(motionLines.length ? ["", "How it moves (computed from the tooth counts and sizes):", ...motionLines.map((l) => `- ${l}`)] : []),
    ...(notes.length ? ["", "Notes:", ...notes.map((n) => `- ${n}`)] : []),
    "",
    DISCLAIMER,
  ].join("\n");
}
