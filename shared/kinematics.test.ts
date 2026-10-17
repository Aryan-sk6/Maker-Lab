// Motion checks. The key ones turn the mechanism through many angles and verify, geometrically, that
// meshing teeth never pass through each other: the derived ratios and tooth timing must be right for that.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ModelInput } from "./model3d.js";
import { buildMechanism, type Mechanism } from "./mechanism.js";
import { AXES, apply, axisAngle, basisFor, describeMotion, dot, eulerXYZ, mul, poseAt, sub, toEulerXYZ, worldPoses, type Vec3 } from "./kinematics.js";
import { gearOutline } from "../widgets/model-viewer/gear.js";
import { rackOutline } from "../widgets/model-viewer/rack.js";

/** Validate like the server does, then build. Throws with the messages if anything is wrong. */
function build(input: unknown): Mechanism {
  const parsed = ModelInput.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
  const m = buildMechanism(parsed.data);
  if ("issues" in m) throw new Error(m.issues.map((i) => i.message).join("\n"));
  return m;
}

function errorsOf(input: unknown): string[] {
  const parsed = ModelInput.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
}

const gear = (name: string, teeth: number, extra: object = {}) => ({ name, shape: { type: "gear", teeth }, ...extra });

/** World outline of a part (gear or rack) when the driver is at angle φ, in 2D coordinates of the plane ⟂ n. */
function outline2d(m: Mechanism, name: string, phi: number, n: Vec3, steps = 24): [number, number][] {
  const k = m.kinematics!;
  const poses = worldPoses(m.parts);
  const part = m.parts.find((p) => p.name === name)!;
  const { angles, slides } = poseAt(k, phi);
  let { p, R } = poses.get(name)!;
  const rotor = k.rotors.find((r) => r.parts.includes(name));
  if (rotor) {
    const pivot = poses.get(rotor.name)!.p;
    const rot = axisAngle(rotor.axis, angles.get(rotor.name)!);
    p = [...apply(rot, sub(p, pivot))].map((v, i) => v + pivot[i]!) as Vec3;
    R = mul(rot, R);
  }
  if (slides.has(name)) p = [...apply(R, [slides.get(name)!, 0, 0])].map((v, i) => v + p[i]!) as Vec3;
  const local = part.shape.type === "gear" ? gearOutline(part.shape.teeth, part.shape.module, steps) : rackOutline(part.shape as never);
  const [e1, e2] = basisFor(n);
  return local.map(([x, y]) => {
    const w = [...apply(R, [x, y, 0])].map((v, i) => v + p[i]!) as Vec3;
    return [dot(w, e1), dot(w, e2)];
  });
}

function inside([x, y]: [number, number], poly: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit; // ray casting: toggle per crossing
  }
  return hit;
}

function segmentDistance(p: [number, number], a: [number, number], b: [number, number]) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
const distanceToOutline = (p: [number, number], poly: [number, number][]) => Math.min(...poly.map((a, i) => segmentDistance(p, a, poly[(i + 1) % poly.length]!)));

/**
 * Deepest penetration (mm) of one part's outline into the other's, over a sweep of driver angles.
 * Perfectly made gears with no backlash touch exactly; drawing curves as short straight segments leaves
 * grazes of a few micrometres. A timing error shows up as millimetres.
 */
function penetration(m: Mechanism, a: string, b: string, sweep = 120, maxPhi = 2 * Math.PI): number {
  const n = m.kinematics!.rotors[0]!.axis;
  let worst = 0;
  for (let s = 0; s < sweep; s++) {
    const phi = (s / sweep) * maxPhi;
    const pa = outline2d(m, a, phi, n);
    const pb = outline2d(m, b, phi, n);
    for (const q of pa) if (inside(q, pb)) worst = Math.max(worst, distanceToOutline(q, pb));
    for (const q of pb) if (inside(q, pa)) worst = Math.max(worst, distanceToOutline(q, pa));
  }
  return worst;
}
/** 1% of the default 2 mm module. */
const GRAZE = 0.02;

describe("vector maths", () => {
  it("uses the same Euler convention as Three.js", () => {
    const deg: Vec3 = [23, -71, 140];
    const [x, y, z] = deg.map((d) => (d * Math.PI) / 180) as Vec3;
    const three = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(x, y, z, "XYZ")).elements; // column-major
    const ours = eulerXYZ(deg);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) expect(ours[3 * r + c]).toBeCloseTo(three[4 * c + r]!, 12);
    expect(toEulerXYZ(ours)).toEqual(deg.map((d) => expect.closeTo(d, 9)));
  });
});

describe("two meshing gears from a minimal description", () => {
  const m = build({ parts: [gear("big", 40), gear("small", 10)], links: [{ type: "mesh", a: "big", b: "small" }] });

  it("places the small gear exactly one pitch-radius sum away and lets both turn", () => {
    const small = m.parts.find((p) => p.name === "small")!;
    expect(small.position[0]).toBeCloseTo(2 * (40 + 10) / 2, 9); // module 2 by default
    expect(small.autoPlaced).toBe(true);
    expect(m.parts.every((p) => p.joint?.type === "rotating")).toBe(true);
    expect(m.parts.map((p) => p.color)).toEqual(["#3b82f6", "#f59e0b"]);
  });

  it("makes the small gear turn 4 times as fast, the other way", () => {
    const small = m.kinematics!.rotors.find((r) => r.name === "small")!;
    expect(small.ratio).toBeCloseTo(-4, 12);
    expect(small.direction).toBe("opposite");
    expect(describeMotion(m.kinematics!)).toContain(`"small" turns 4 times for every turn of "big", the other way (120 rpm).`);
  });

  it("never lets teeth pass through each other while turning", () => {
    expect(penetration(m, "big", "small")).toBeLessThan(GRAZE);
  });

  it("the overlap test is sensitive: shifting the timing by half a tooth makes teeth collide by more than 0.5 mm", () => {
    const k = m.kinematics!;
    const wrong: Mechanism = { ...m, kinematics: { ...k, rotors: k.rotors.map((r) => (r.name === "small" ? { ...r, offset: r.offset + Math.PI / 10 } : r)) } };
    expect(penetration(wrong, "big", "small", 20)).toBeGreaterThan(0.5);
  });
});

describe("meshing holds for awkward layouts", () => {
  it.each([
    ["17 and 31 teeth at 37°", { parts: [gear("a", 17), gear("b", 31)], links: [{ type: "mesh", a: "a", b: "b", angle: 37 }] }],
    ["a pre-rotated driver", { parts: [gear("a", 24, { rotation: [0, 0, 13] }), gear("b", 15)], links: [{ type: "mesh", a: "a", b: "b", angle: 200 }] }],
    ["gears standing upright", { parts: [gear("a", 30, { rotation: [90, 0, 0] }), gear("b", 18)], links: [{ type: "mesh", a: "a", b: "b", angle: 60 }] }],
    [
      "one gear flipped upside down, placed by hand",
      { parts: [gear("a", 20), gear("b", 28, { position: [48, 0, 0], rotation: [180, 0, 7] })], links: [{ type: "mesh", a: "a", b: "b" }] },
    ],
  ])("%s", (_label, input) => {
    const m = build(input);
    expect(penetration(m, "a", "b")).toBeLessThan(GRAZE);
  });

  it("a three-gear chain: the idler reverses direction twice, so the last gear turns with the first", () => {
    const m = build({ parts: [gear("in", 20), gear("idler", 13), gear("out", 40)], links: [{ type: "mesh", a: "in", b: "idler" }, { type: "mesh", a: "idler", b: "out" }] });
    const out = m.kinematics!.rotors.find((r) => r.name === "out")!;
    expect(out.ratio).toBeCloseTo(0.5, 12); // idlers do not change the overall ratio
    expect(out.direction).toBe("same");
    expect(penetration(m, "in", "idler")).toBeLessThan(GRAZE);
    expect(penetration(m, "idler", "out")).toBeLessThan(GRAZE);
    expect(m.notes.join()).not.toContain("overlap");
  });
});

describe("compound train on a shared axle", () => {
  const m = build({
    parts: [gear("A", 12), gear("B", 36), gear("C", 12), gear("D", 36)],
    links: [
      { type: "mesh", a: "A", b: "B" },
      { type: "axle", a: "B", b: "C" },
      { type: "mesh", a: "C", b: "D" },
    ],
  });

  it("multiplies the ratios: (12/36) × (12/36) = 1/9", () => {
    const d = m.kinematics!.rotors.find((r) => r.name === "D")!;
    expect(d.ratio).toBeCloseTo(1 / 9, 12);
    expect(describeMotion(m.kinematics!).join("\n")).toContain(`"D" turns once for every 9 turns of "A", the same way (3.33 rpm)`);
  });

  it("stacks C on B's axle and keeps every pair meshing", () => {
    const c = m.parts.find((p) => p.name === "C")!;
    expect(c).toMatchObject({ parent: "B", joint: { type: "fixed" } });
    expect(c.position).toEqual([0, 0, 8]); // 6/2 + 6/2 + 2 mm gap
    expect(penetration(m, "A", "B")).toBeLessThan(GRAZE);
    expect(penetration(m, "C", "D")).toBeLessThan(GRAZE);
  });

  it("does not put D on top of A when choosing where it goes", () => {
    expect(m.notes.join()).not.toContain("overlap");
  });
});

describe("belts", () => {
  const pulley = (name: string, diameter: number) => ({ name, shape: { type: "pulley", diameter } });

  it("an open belt turns both pulleys the same way; ratio = diameter ratio", () => {
    const m = build({ parts: [pulley("motor", 20), pulley("wheel", 80)], links: [{ type: "belt", a: "motor", b: "wheel" }] });
    const wheel = m.kinematics!.rotors.find((r) => r.name === "wheel")!;
    expect(wheel.ratio).toBeCloseTo(0.25, 12);
    expect(wheel.direction).toBe("same");
  });

  it("a crossed belt reverses the direction", () => {
    const m = build({ parts: [pulley("a", 40), pulley("b", 40)], links: [{ type: "belt", a: "a", b: "b", crossed: true }] });
    expect(m.kinematics!.rotors.find((r) => r.name === "b")!.direction).toBe("opposite");
  });

  it.each([false, true])("belt length formula matches the drawn loop (crossed: %s)", (crossed) => {
    const m = build({ parts: [pulley("a", 30), pulley("b", 70)], links: [{ type: "belt", a: "a", b: "b", crossed, distance: 120 }] });
    const belt = m.kinematics!.belts[0]!;
    let drawn = 0;
    for (let i = 0; i < belt.points.length; i++) {
      const [p, q] = [belt.points[i]!, belt.points[(i + 1) % belt.points.length]!];
      drawn += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    }
    expect(Math.abs(drawn - belt.length) / belt.length).toBeLessThan(0.002); // arcs drawn as short chords
  });
});

describe("rack and pinion", () => {
  const m = build({
    parts: [gear("pinion", 16), { name: "rack", shape: { type: "rack", length: 150 } }],
    links: [{ type: "rack", pinion: "pinion", rack: "rack" }],
  });

  it("slides π × module × teeth per turn of the pinion", () => {
    expect(describeMotion(m.kinematics!).join("\n")).toContain(`"rack" slides 101 mm for every turn of "pinion"`); // π × 2 × 16
  });

  it("keeps pinion teeth in the rack's gaps while it slides", () => {
    expect(penetration(m, "pinion", "rack", 120, Math.PI)).toBeLessThan(GRAZE);
  });

  it("reports how far the rack can travel", () => {
    expect(m.notes.join()).toMatch(/"rack" can slide about \d+(\.\d)? mm/);
  });
});

describe("explaining what is wrong", () => {
  it("gears placed by hand at the wrong distance get the right distance in the message", () => {
    const [msg] = errorsOf({ parts: [gear("a", 20, { position: [0, 0, 0] }), gear("b", 20, { position: [41, 0, 0] })], links: [{ type: "mesh", a: "a", b: "b" }] });
    expect(msg).toContain(`"a" and "b" are 41 mm apart but must be 40 mm apart to mesh`);
    expect(msg).toContain("Leave out the position");
  });

  it("different tooth sizes cannot mesh", () => {
    expect(errorsOf({ parts: [gear("a", 20), { name: "b", shape: { type: "gear", teeth: 20, module: 3 } }], links: [{ type: "mesh", a: "a", b: "b" }] })[0]).toContain("need the same module");
  });

  it("a loop of three meshing gears would jam", () => {
    const msg = errorsOf({
      parts: [gear("a", 20, { position: [0, 0, 0] }), gear("b", 20, { position: [40, 0, 0] }), gear("c", 20, { position: [20, 34.641016, 0] })],
      links: [{ type: "mesh", a: "a", b: "b" }, { type: "mesh", a: "b", b: "c" }, { type: "mesh", a: "c", b: "a" }],
    }).join();
    expect(msg).toContain("would jam");
  });

  it("a rack linked with the wrong link type gets the right one in the message", () => {
    const msg = errorsOf({ parts: [gear("p", 16), { name: "r", shape: { type: "rack" } }], links: [{ type: "mesh", a: "p", b: "r" }] }).join();
    expect(msg).toContain(`{"type":"rack","pinion":"p","rack":"r"}`);
  });

  it("a fixed gear cannot turn", () => {
    const msg = errorsOf({
      parts: [{ name: "frame", shape: { type: "box", width: 100, depth: 100, height: 4 } }, gear("a", 20, { parent: "frame", joint: { type: "fixed" } }), gear("b", 20)],
      links: [{ type: "mesh", a: "a", b: "b" }],
    }).join();
    expect(msg).toContain(`"a" cannot turn`);
  });

  it("names a link to a part that does not exist", () => {
    expect(errorsOf({ parts: [gear("a", 20)], links: [{ type: "mesh", a: "a", b: "ghost" }] })[0]).toContain(`"ghost", which is not a part`);
  });

  it("a gear linked to nothing the driver turns is reported", () => {
    const msg = errorsOf({
      parts: [gear("a", 20), gear("b", 20), gear("c", 20), gear("d", 20)],
      links: [{ type: "mesh", a: "a", b: "b" }, { type: "mesh", a: "c", b: "d" }],
      driver: { part: "a" },
    }).join();
    expect(msg).toContain("not connected to the driver");
  });
});

describe("static models still work as before", () => {
  it("no links means no motion, and parts without a position sit at the origin", () => {
    const m = build({ parts: [{ name: "block", shape: { type: "box", width: 10, depth: 10, height: 10 } }] });
    expect(m.kinematics).toBeUndefined();
    expect(m.parts[0]!.position).toEqual([0, 0, 0]);
  });
});

describe("unused helpers stay consistent", () => {
  it("AXES are unit vectors", () => {
    for (const v of Object.values(AXES)) expect(Math.hypot(...v)).toBe(1);
  });
});
