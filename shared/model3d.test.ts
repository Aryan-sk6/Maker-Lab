import { describe, expect, it } from "vitest";
import { MAX_PARTS, ModelInput, summarizeModel } from "./model3d.js";
import { buildMechanism } from "./mechanism.js";
import { describeMotion } from "./kinematics.js";
import { DEMO_MODEL } from "../widgets/model-viewer/demo.js";

const box = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  shape: { type: "box", width: 10, depth: 10, height: 10 },
  ...extra,
});

/** Parse and return the error messages (with paths), or [] if valid. */
function errors(input: unknown): string[] {
  const result = ModelInput.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("render_3d_model input validation", () => {
  it("accepts the demo model", () => {
    expect(errors(DEMO_MODEL)).toEqual([]);
  });

  it("fills in defaults for rotation, joint axis and shape sizes; leaves position for the layout", () => {
    const model = ModelInput.parse({ parts: [box("a"), box("b", { parent: "a", joint: { type: "rotating" } }), { name: "g", shape: { type: "gear" } }] });
    expect(model.parts[0]).toMatchObject({ rotation: [0, 0, 0] });
    expect(model.parts[0]?.position).toBeUndefined();
    expect(model.parts[1]?.joint).toEqual({ type: "rotating", axis: "z", angle: 0 });
    expect(model.parts[2]?.shape).toEqual({ type: "gear", teeth: 20, module: 2, thickness: 6 });
    expect(model.links).toEqual([]);
  });

  it("accepts the shortest possible mechanism: two gear names and a link", () => {
    expect(errors({ parts: [{ name: "a", shape: { type: "gear" } }, { name: "b", shape: { type: "gear" } }], links: [{ type: "mesh", a: "a", b: "b" }] })).toEqual([]);
  });

  it(`rejects more than ${MAX_PARTS} parts`, () => {
    const parts = Array.from({ length: MAX_PARTS + 1 }, (_, i) => box(`p${i}`));
    expect(errors({ parts })).toEqual([expect.stringContaining(`at most ${MAX_PARTS} parts`)]);
  });

  it("rejects an empty part list", () => {
    expect(errors({ parts: [] })[0]).toContain("at least one part");
  });

  it.each([
    [0.05, "at least 0.1 mm"],
    [1000.5, "at most 1000 mm"],
  ])("rejects dimension %s mm", (width, message) => {
    const result = errors({ parts: [{ name: "a", shape: { type: "box", width, depth: 10, height: 10 } }] });
    expect(result).toEqual([`parts.0.shape.width: width (X) must be ${message}`]);
  });

  it("names the allowed shape types when the type is unknown", () => {
    const result = errors({ parts: [{ name: "a", shape: { type: "torus", diameter: 10 } }] });
    expect(result[0]).toContain("box, cylinder, sphere, cone, gear, pulley, rack, bracket");
  });

  it("rejects bad colours with an example of a good one", () => {
    expect(errors({ parts: [box("a", { color: "red" })] })[0]).toContain("#3b82f6");
  });

  it("rejects duplicate names", () => {
    expect(errors({ parts: [box("a"), box("a")] })[0]).toContain('duplicate part name "a"');
  });

  it("rejects a parent that does not exist and lists valid names", () => {
    const [message] = errors({ parts: [box("a"), box("b", { parent: "c" })] });
    expect(message).toContain('parent "c" does not match');
    expect(message).toContain("a, b");
  });

  it("rejects self-parenting and parent cycles", () => {
    expect(errors({ parts: [box("a", { parent: "a" })] }).join()).toContain("cannot be its own parent");
    expect(errors({ parts: [box("a", { parent: "b" }), box("b", { parent: "a" })] }).join()).toContain("loops back");
  });

  it("rejects a fixed joint without a parent, but lets a part turn on its own", () => {
    expect(errors({ parts: [box("a", { joint: { type: "fixed" } })] })[0]).toContain("fixed joint but no parent");
    expect(errors({ parts: [box("a", { joint: { type: "rotating" } })] })).toEqual([]);
  });

  it("names unknown link types and unknown parts", () => {
    expect(errors({ parts: [box("a")], links: [{ type: "chain", a: "a", b: "a" }] })[0]).toContain("mesh, belt, rack, axle");
    expect(errors({ parts: [box("a")], driver: { part: "motor" } })[0]).toContain(`driver "motor" is not a part`);
  });

  it("rejects gears whose outside diameter exceeds the limit", () => {
    const gear = { name: "g", shape: { type: "gear", teeth: 150, module: 10, thickness: 5 } };
    expect(errors({ parts: [gear] })[0]).toContain("use fewer teeth or a smaller module");
  });

  it("rejects a gear bore larger than the root circle allows", () => {
    const gear = { name: "g", shape: { type: "gear", teeth: 10, module: 1, thickness: 5, bore: 9 } };
    expect(errors({ parts: [gear] })[0]).toContain("use at most 6 mm or leave bore out");
  });

  it("rejects non-integer tooth counts", () => {
    const gear = { name: "g", shape: { type: "gear", teeth: 12.5, module: 1, thickness: 5 } };
    expect(errors({ parts: [gear] })[0]).toContain("whole number");
  });

  it("rejects a bracket thicker than its legs", () => {
    const bracket = { name: "b", shape: { type: "bracket", length: 10, height: 20, width: 10, thickness: 10 } };
    expect(errors({ parts: [bracket] })[0]).toContain("must be smaller than both length");
  });

  it("produces a text summary that explains the motion in plain sentences", () => {
    const m = buildMechanism(ModelInput.parse(DEMO_MODEL));
    if ("issues" in m) throw new Error(m.issues[0]!.message);
    const text = summarizeModel(m, describeMotion(m.kinematics!), m.notes);
    expect(text).toContain("8 parts, units mm");
    expect(text).toContain("gear, 12 teeth, module 2");
    expect(text).toContain(`"motor gear" is the driver, turning at 60 rpm.`);
    expect(text).toContain(`"rack" slides`);
    expect(text).toContain("Not an engineering drawing");
  });
});
