// How a mechanism moves: which parts turn, how fast, in which direction, and how gear teeth line up.
// Pure maths (no zod, no Three.js) so the server and the widget compute exactly the same motion.
//
// Vocabulary
//   rotor   a part with a rotating joint. Everything rigidly attached to it turns with it.
//   driver  the rotor the student turns. Every other rotor's angle is  θ = ratio·φ + offset,  where φ is the driver angle.
//   link    a connection between two parts: gears meshing, a belt between pulleys, or a pinion driving a rack.

import type { LinkInput, ShapeInput } from "./model3d.js";

export type Vec3 = [number, number, number];
/** 3×3 rotation matrix, row-major. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export interface KPart {
  name: string;
  shape: ShapeInput;
  position: Vec3;
  rotation: Vec3;
  parent?: string;
  joint?: { type: "fixed" | "rotating"; axis: "x" | "y" | "z"; angle: number };
}

export interface Issue {
  path: (string | number)[];
  message: string;
}

// --- Small vector library ------------------------------------------------------------

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => scale(a, 1 / (length(a) || 1));

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[3 * i + j]! += a[3 * i + k]! * b[3 * k + j]!;
  return r;
}
export const apply = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
export const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

const rotX = (a: number): Mat3 => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const rotY = (a: number): Mat3 => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
export const rotZ = (a: number): Mat3 => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
const DEG = Math.PI / 180;

/** Euler angles in degrees, XYZ order: the same convention as Three.js (matrix = Rx·Ry·Rz). */
export const eulerXYZ = (deg: Vec3): Mat3 => mul(rotX(deg[0] * DEG), mul(rotY(deg[1] * DEG), rotZ(deg[2] * DEG)));

/** The inverse of eulerXYZ (as Three.js Euler.setFromRotationMatrix does for "XYZ"). */
export function toEulerXYZ(m: Mat3): Vec3 {
  const y = Math.asin(Math.max(-1, Math.min(1, m[2])));
  const [x, z] = Math.abs(m[2]) < 0.9999999 ? [Math.atan2(-m[5], m[8]), Math.atan2(-m[1], m[0])] : [Math.atan2(m[7], m[4]), 0];
  const clean = (r: number) => Math.round((r / DEG) * 1e9) / 1e9 || 0;
  return [clean(x), clean(y), clean(z)];
}

/** Rotation by `a` radians about a unit axis (Rodrigues' formula). */
export function axisAngle(axis: Vec3, a: number): Mat3 {
  const [x, y, z] = axis;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}

export const AXES: Record<"x" | "y" | "z", Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** Two unit vectors perpendicular to n, forming a right-handed basis (e1, e2, n). */
export function basisFor(n: Vec3): [Vec3, Vec3] {
  const t: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = normalize(sub(t, scale(n, dot(t, n))));
  return [e1, cross(n, e1)];
}

// --- Where every part is ----------------------------------------------------------------

export interface Pose {
  p: Vec3;
  R: Mat3;
}

/** World position and orientation of every part with all joints at angle 0 (the reference pose). */
export function worldPoses(parts: KPart[]): Map<string, Pose> {
  const byName = new Map(parts.map((p) => [p.name, p]));
  const poses = new Map<string, Pose>();
  const visit = (part: KPart, depth = 0): Pose => {
    const known = poses.get(part.name);
    if (known) return known;
    const local: Pose = { p: part.position, R: eulerXYZ(part.rotation) };
    const parent = part.parent ? byName.get(part.parent) : undefined;
    let pose = local;
    if (parent && depth < parts.length) {
      const pp = visit(parent, depth + 1);
      pose = { p: add(pp.p, apply(pp.R, local.p)), R: mul(pp.R, local.R) };
    }
    poses.set(part.name, pose);
    return pose;
  };
  for (const part of parts) visit(part);
  return poses;
}

/** The rotor a part turns with: itself or its nearest ancestor with a rotating joint. */
export function rotorOf(byName: Map<string, KPart>, name: string): string | undefined {
  for (let cur = byName.get(name), guard = 0; cur && guard <= byName.size; cur = cur.parent ? byName.get(cur.parent) : undefined, guard++) {
    if (cur.joint?.type === "rotating") return cur.name;
  }
  return undefined;
}

// --- Gear and rack geometry the motion depends on ---------------------------------------------------

export const pitchRadius = (s: { module: number; teeth: number }) => (s.module * s.teeth) / 2;

/** A rack has whole teeth, centred on its origin, one every π·module along local X. */
export function rackLayout(s: { length: number; module: number }) {
  const pitch = Math.PI * s.module;
  const teeth = Math.max(1, Math.floor(s.length / pitch));
  return { pitch, teeth, length: teeth * pitch, firstToothX: (-(teeth - 1) / 2) * pitch };
}

/** Rough radius of a round part, for collision checks when placing parts automatically. */
export function outerRadius(s: ShapeInput): number | undefined {
  if (s.type === "gear") return (s.module * (s.teeth + 2)) / 2;
  if (s.type === "pulley") return (s.diameter / 2) * 1.12;
  return undefined;
}

/** Thickness along a round part's axis. */
export function axialThickness(s: ShapeInput): number {
  if (s.type === "gear") return s.thickness;
  if (s.type === "pulley") return s.width;
  if (s.type === "cylinder") return s.height;
  if (s.type === "rack") return s.thickness;
  return 5;
}

// --- Solving the motion -----------------------------------------------------------------

export interface RotorMotion {
  name: string;
  /** Rotation axis in world coordinates (unit). */
  axis: Vec3;
  ratio: number;
  /** Angle offset in radians, so that meshing teeth interlock. */
  offset: number;
  /** Parts that turn with this rotor. */
  parts: string[];
  direction: "driver" | "same" | "opposite";
}

export interface RackMotion {
  name: string;
  pinion: string;
  rotor: string;
  /** Rack displacement along its own X:  d = d0 + mmPerRad·θ_rotor. */
  d0: number;
  mmPerRad: number;
  /** Displacements at which the pinion reaches the ends of the rack. */
  minD: number;
  maxD: number;
}

export interface BeltMotion {
  a: string;
  b: string;
  crossed: boolean;
  length: number;
  /** Closed loop of world points (reference pose), traversed counter-clockwise around pulley a's rotor axis. */
  points: Vec3[];
  rotor: string;
  /** Belt travel along `points` per radian of `rotor`. */
  mmPerRad: number;
}

export interface Kinematics {
  driver: { part: string; rotor: string; rpm: number };
  rotors: RotorMotion[];
  racks: RackMotion[];
  belts: BeltMotion[];
  notes: string[];
}

interface Edge {
  from: string;
  to: string;
  /** θ_to = k·θ_from + c */
  k: number;
  c: number;
  link: number;
}

const TOL_PARALLEL = 0.999;
const distanceTolerance = (expected: number) => Math.max(0.05, expected * 0.005);
const posMod = (a: number, m: number) => ((a % m) + m) % m;
const r1 = (n: number) => Math.round(n * 10) / 10;

export function solveKinematics(parts: KPart[], links: LinkInput[], driver?: { part: string; rpm: number }): { kinematics: Kinematics } | { issues: Issue[] } {
  const issues: Issue[] = [];
  const notes: string[] = [];
  const byName = new Map(parts.map((p) => [p.name, p]));
  const poses = worldPoses(parts);
  const pose = (n: string) => poses.get(n)!;
  const shapeAxis = (n: string) => normalize(apply(pose(n).R, AXES.z));

  /** Rotation axis of a rotor in world coordinates. */
  const rotorAxis = (rotor: string) => normalize(apply(pose(rotor).R, AXES[byName.get(rotor)!.joint!.axis]));

  /** Check that a gear/pulley turns with a rotor about its own centre; return the rotor. */
  function mountedRotor(name: string, path: (string | number)[]): string | undefined {
    const rotor = rotorOf(byName, name);
    if (!rotor) {
      issues.push({ path, message: `"${name}" cannot turn: it has a fixed joint. Remove its "joint" (or use type "rotating") so it can spin` });
      return undefined;
    }
    const above = byName.get(rotor)!.parent;
    if (above && rotorOf(byName, above)) {
      issues.push({ path, message: `"${name}" turns with "${rotor}", which is itself carried by another turning part; gears riding on turning parts (like planetary gears) are not supported yet` });
      return undefined;
    }
    const axis = rotorAxis(rotor);
    if (Math.abs(dot(axis, shapeAxis(name))) < TOL_PARALLEL) {
      issues.push({ path, message: `"${name}" is tilted relative to the axis it turns about (the joint axis of "${rotor}"); its own Z axis must line up with that axis` });
      return undefined;
    }
    const offAxis = length(sub(sub(pose(name).p, pose(rotor).p), scale(axis, dot(sub(pose(name).p, pose(rotor).p), axis))));
    if (offAxis > 0.1) {
      issues.push({ path, message: `"${name}" is ${r1(offAxis)} mm off the axis of "${rotor}", so it would wobble; centre it on that axis` });
      return undefined;
    }
    return rotor;
  }

  const edges: Edge[] = [];
  const racks: (Omit<RackMotion, "minD" | "maxD"> & { limits: [number, number] })[] = [];
  const belts: Omit<BeltMotion, "mmPerRad">[] = [];
  const beltRadii: number[] = [];

  links.forEach((link, i) => {
    const at = (field: string) => ["links", i, field];
    if (link.type === "mesh") {
      const a = byName.get(link.a)!;
      const b = byName.get(link.b)!;
      if (a.shape.type !== "gear" || b.shape.type !== "gear") {
        const other = a.shape.type === "gear" ? b : a;
        const hint =
          other.shape.type === "rack"
            ? `; for a gear driving a rack use {"type":"rack","pinion":"${other === a ? b.name : a.name}","rack":"${other.name}"}`
            : other.shape.type === "pulley"
              ? `; pulleys are joined with {"type":"belt"}`
              : "";
        issues.push({ path: at("type"), message: `a mesh link needs two gears; "${other.name}" is a ${other.shape.type}${hint}` });
        return;
      }
      const ga = a.shape;
      const gb = b.shape;
      const ra = mountedRotor(a.name, at("a"));
      const rb = mountedRotor(b.name, at("b"));
      if (!ra || !rb) return;
      if (ra === rb) {
        issues.push({ path: at("b"), message: `"${a.name}" and "${b.name}" turn together on the same part, so they cannot drive each other` });
        return;
      }
      if (Math.abs(ga.module - gb.module) > 1e-9) {
        issues.push({ path: at("b"), message: `"${a.name}" (module ${ga.module}) and "${b.name}" (module ${gb.module}) cannot mesh: meshing gears need the same module. Leave "module" out on both to use the default` });
        return;
      }
      const n = rotorAxis(ra);
      if (Math.abs(dot(n, rotorAxis(rb))) < TOL_PARALLEL) {
        issues.push({ path: at("b"), message: `"${a.name}" and "${b.name}" do not have parallel axes; spur gears only mesh side by side` });
        return;
      }
      const d = sub(pose(b.name).p, pose(a.name).p);
      const axial = dot(d, n);
      const radial = length(sub(d, scale(n, axial)));
      const expected = pitchRadius(ga) + pitchRadius(gb);
      if (Math.abs(radial - expected) > distanceTolerance(expected)) {
        issues.push({
          path: at("b"),
          message: `"${a.name}" and "${b.name}" are ${r1(radial)} mm apart but must be ${r1(expected)} mm apart to mesh (module × (teeth₁ + teeth₂) / 2). Leave out the position of "${b.name}" and it will be placed automatically`,
        });
        return;
      }
      if (Math.abs(axial) >= (ga.thickness + gb.thickness) / 2) {
        issues.push({ path: at("b"), message: `"${a.name}" and "${b.name}" are side by side along their axes (${r1(Math.abs(axial))} mm apart), so their teeth do not touch; put them in the same plane` });
        return;
      }
      // Phase: put a tooth of A opposite a gap of B along the line of centres (see ARCHITECTURE.md for the derivation).
      const [e1, e2] = basisFor(n);
      const angleOf = (v: Vec3) => Math.atan2(dot(v, e2), dot(v, e1));
      const psi = angleOf(d);
      const chiA = angleOf(apply(pose(a.name).R, AXES.x));
      const chiB = angleOf(apply(pose(b.name).R, AXES.x));
      const sA = Math.sign(dot(rotorAxis(ra), n));
      const sB = Math.sign(dot(rotorAxis(rb), n));
      const q = ga.teeth / gb.teeth;
      const C = psi * (1 + q) + Math.PI * (1 - 1 / gb.teeth);
      edges.push({ from: ra, to: rb, k: -sA * sB * q, c: sB * (-q * chiA + C - chiB), link: i });
      if (ga.teeth < 12 || gb.teeth < 12) notes.push(`Gears with fewer than 12 teeth need specially shaped teeth in real life; here they are drawn approximately.`);
    } else if (link.type === "belt") {
      const a = byName.get(link.a)!;
      const b = byName.get(link.b)!;
      if (a.shape.type !== "pulley" || b.shape.type !== "pulley") {
        const other = a.shape.type === "pulley" ? b : a;
        issues.push({ path: at("type"), message: `a belt link needs two pulleys; "${other.name}" is a ${other.shape.type}${other.shape.type === "gear" ? `; gears are joined with {"type":"mesh"}` : `; use shape {"type":"pulley"}`}` });
        return;
      }
      const ra = mountedRotor(a.name, at("a"));
      const rb = mountedRotor(b.name, at("b"));
      if (!ra || !rb) return;
      if (ra === rb) {
        issues.push({ path: at("b"), message: `"${a.name}" and "${b.name}" turn together on the same part, so a belt between them does nothing` });
        return;
      }
      const n = rotorAxis(ra);
      if (Math.abs(dot(n, rotorAxis(rb))) < TOL_PARALLEL) {
        issues.push({ path: at("b"), message: `"${a.name}" and "${b.name}" must have parallel axes for a flat belt` });
        return;
      }
      const rA = a.shape.diameter / 2;
      const rB = b.shape.diameter / 2;
      const d = sub(pose(b.name).p, pose(a.name).p);
      const axial = dot(d, n);
      const dist = length(sub(d, scale(n, axial)));
      const crossed = link.crossed ?? false;
      const needed = crossed ? rA + rB : Math.abs(rA - rB);
      if (dist <= needed + 1) {
        issues.push({ path: at("b"), message: `"${a.name}" and "${b.name}" are too close for a belt (${r1(dist)} mm between centres; it must be more than ${r1(needed + 1)} mm)` });
        return;
      }
      if (Math.abs(axial) >= (a.shape.width + b.shape.width) / 2) {
        issues.push({ path: at("b"), message: `"${a.name}" and "${b.name}" are not in the same plane (${r1(Math.abs(axial))} mm apart along their axes), so a belt cannot reach both` });
        return;
      }
      const sA = Math.sign(dot(rotorAxis(ra), n));
      const sB = Math.sign(dot(rotorAxis(rb), n));
      edges.push({ from: ra, to: rb, k: (crossed ? -1 : 1) * sA * sB * (rA / rB), c: 0, link: i });

      // Belt drawing: a loop in the plane halfway between the pulleys.
      const [e1, e2] = basisFor(n);
      const origin = add(pose(a.name).p, scale(n, axial / 2));
      const bx = dot(d, e1);
      const by = dot(d, e2);
      const { points2d, length: beltLength } = beltLoop(rA, [bx, by], rB, crossed);
      belts.push({ a: a.name, b: b.name, crossed, length: beltLength, rotor: ra, points: points2d.map(([x, y]) => add(origin, add(scale(e1, x), scale(e2, y)))) });
      beltRadii.push(rA * sA);
    } else if (link.type === "rack") {
      const pin = byName.get(link.pinion)!;
      const rack = byName.get(link.rack)!;
      if (pin.shape.type !== "gear") {
        issues.push({ path: at("pinion"), message: `the pinion "${pin.name}" must be a gear` });
        return;
      }
      if (rack.shape.type !== "rack") {
        issues.push({ path: at("rack"), message: `"${rack.name}" must be a rack (shape type "rack")` });
        return;
      }
      if (rotorOf(byName, rack.name)) {
        issues.push({ path: at("rack"), message: `"${rack.name}" slides, so it must not have a rotating joint or sit on a turning part` });
        return;
      }
      const g = pin.shape;
      const rs = rack.shape;
      if (Math.abs(g.module - rs.module) > 1e-9) {
        issues.push({ path: at("rack"), message: `the pinion (module ${g.module}) and the rack (module ${rs.module}) need the same module` });
        return;
      }
      const rotor = mountedRotor(pin.name, at("pinion"));
      if (!rotor) return;
      const Rr = pose(rack.name).R;
      const n = apply(Rr, AXES.z);
      if (Math.abs(dot(n, rotorAxis(rotor))) < TOL_PARALLEL) {
        issues.push({ path: at("rack"), message: `the pinion's axis must be parallel to the rack's Z axis (across the rack's width)` });
        return;
      }
      const rel = apply(transpose(Rr), sub(pose(pin.name).p, pose(rack.name).p)); // pinion centre in the rack's frame
      const r = pitchRadius(g);
      if (Math.abs(rel[1] - r) > distanceTolerance(r)) {
        issues.push({
          path: at("pinion"),
          message: `the pinion's centre must be ${r1(r)} mm above the rack's pitch line (on the rack's +Y side), but it is at ${r1(rel[1])} mm. Leave out the rack's position and it will be placed automatically`,
        });
        return;
      }
      if (Math.abs(rel[2]) >= (g.thickness + rs.thickness) / 2) {
        issues.push({ path: at("pinion"), message: `the pinion and the rack are not in the same plane (${r1(Math.abs(rel[2]))} mm apart across the rack)` });
        return;
      }
      const layout = rackLayout(rs);
      if (Math.abs(rel[0]) > layout.length / 2) {
        issues.push({ path: at("pinion"), message: `the pinion is beyond the end of the rack; move it within ${r1(layout.length / 2)} mm of the rack's centre` });
        return;
      }
      // Phase: a pinion tooth at the contact point must sit in a rack gap.
      const [ex, ey] = [apply(Rr, AXES.x), apply(Rr, AXES.y)];
      const chi = Math.atan2(dot(apply(pose(pin.name).R, AXES.x), ey), dot(apply(pose(pin.name).R, AXES.x), ex));
      const tau = Math.sign(dot(rotorAxis(rotor), n));
      const p = (2 * Math.PI) / g.teeth;
      const eps = posMod(chi + Math.PI / 2 + p / 2, p) - p / 2; // nearest tooth's angle from the contact direction (−Y)
      const toothX = rel[0] + r * eps;
      const raw = toothX - layout.pitch / 2 - layout.firstToothX;
      const d0 = posMod(raw + layout.pitch / 2, layout.pitch) - layout.pitch / 2;
      racks.push({ name: rack.name, pinion: pin.name, rotor, d0, mmPerRad: r * tau, limits: [rel[0] - layout.length / 2, rel[0] + layout.length / 2] });
    } else {
      // "axle" links are resolved by the layout step (shared/mechanism.ts) before motion is solved.
    }
  });
  if (issues.length > 0) return { issues };

  // Driver: the requested part's rotor, or the first linked rotor.
  const linkedRotors = [...new Set(edges.flatMap((e) => [e.from, e.to]).concat(racks.map((r) => r.rotor)))];
  if (linkedRotors.length === 0) return { issues: [] }; // nothing moves together; caller treats this as "no mechanism"
  let driverRotor = linkedRotors[0]!;
  let driverPart = driverRotor;
  if (driver) {
    const rotor = rotorOf(byName, driver.part);
    if (!rotor) return { issues: [{ path: ["driver", "part"], message: `the driver "${driver.part}" cannot turn; choose a gear or pulley that turns` }] };
    driverRotor = rotor;
    driverPart = driver.part;
  } else {
    notes.push(`No driver was chosen, so "${driverPart}" drives the mechanism.`);
  }

  // Walk the links outward from the driver, giving every rotor its ratio and offset.
  const solved = new Map<string, { ratio: number; offset: number }>([[driverRotor, { ratio: 1, offset: 0 }]]);
  const queue = [driverRotor];
  let phaseClash = false;
  while (queue.length > 0) {
    const u = queue.shift()!;
    const su = solved.get(u)!;
    for (const e of edges) {
      const [v, k, c] = e.from === u ? [e.to, e.k, e.c] : e.to === u ? [e.from, 1 / e.k, -e.c / e.k] : [undefined, 0, 0];
      if (!v) continue;
      const next = { ratio: k * su.ratio, offset: k * su.offset + c };
      const existing = solved.get(v);
      if (!existing) {
        solved.set(v, next);
        queue.push(v);
      } else if (Math.abs(existing.ratio - next.ratio) > 1e-9 * Math.max(1, Math.abs(next.ratio))) {
        return { issues: [{ path: ["links", e.link], message: `these links form a loop that would jam: "${v}" would have to turn at two different speeds at once. Remove one link from the loop` }] };
      } else if (Math.abs(Math.sin((existing.offset - next.offset) / 2)) > 1e-6) {
        phaseClash = true;
      }
    }
  }
  if (phaseClash) notes.push("The gears form a loop whose teeth cannot all line up perfectly; some teeth may look like they overlap.");

  for (const e of edges) {
    for (const rotor of [e.from, e.to]) {
      if (!solved.has(rotor)) {
        return { issues: [{ path: ["links", e.link], message: `"${rotor}" is not connected to the driver "${driverPart}" through any chain of links, so nothing turns it. Link it to the rest, or choose a different driver` }] };
      }
    }
  }
  for (const rk of racks) {
    if (!solved.has(rk.rotor)) {
      return { issues: [{ path: ["links"], message: `the pinion "${rk.pinion}" is not connected to the driver "${driverPart}"` }] };
    }
  }

  const driverAxis = rotorAxis(driverRotor);
  const rotors: RotorMotion[] = [...solved].map(([name, s]) => ({
    name,
    axis: rotorAxis(name),
    ratio: s.ratio,
    offset: s.offset,
    parts: parts.filter((p) => rotorOf(byName, p.name) === name).map((p) => p.name),
    direction: name === driverRotor ? "driver" : s.ratio * dot(rotorAxis(name), driverAxis) > 0 ? "same" : "opposite",
  }));
  const rackMotions: RackMotion[] = racks.map(({ limits, ...rk }) => {
    const minD = Math.min(...limits);
    const maxD = Math.max(...limits);
    notes.push(`"${rk.name}" can slide about ${r1(maxD - minD)} mm before the pinion reaches an end of the rack.`);
    return { ...rk, minD, maxD };
  });
  return {
    kinematics: {
      driver: { part: driverPart, rotor: driverRotor, rpm: driver?.rpm ?? 30 },
      rotors,
      racks: rackMotions,
      belts: belts.map((b, i) => ({ ...b, mmPerRad: beltRadii[i]! })),
      notes: [...new Set(notes)],
    },
  };
}

/** Angles (radians) of every linked rotor and displacements (mm) of every rack when the driver is at angle φ. */
export function poseAt(k: Kinematics, phi: number) {
  const angles = new Map(k.rotors.map((r) => [r.name, r.ratio * phi + r.offset]));
  const slides = new Map(k.racks.map((r) => [r.name, r.d0 + r.mmPerRad * angles.get(r.rotor)!]));
  const belts = k.belts.map((b) => b.mmPerRad * angles.get(b.rotor)!);
  return { angles, slides, belts };
}

// --- Belt loop -------------------------------------------------------------------------------------

/**
 * Closed belt path around pulley A (radius ra, at the origin) and pulley B (radius rb, at `b`), counter-clockwise
 * around A. Open belts wrap the outside of both pulleys; crossed belts make a figure of eight.
 */
export function beltLoop(ra: number, b: [number, number], rb: number, crossed: boolean) {
  const dist = Math.hypot(b[0], b[1]);
  const psi = Math.atan2(b[1], b[0]);
  const pts: [number, number][] = [];
  const arc = (cx: number, cy: number, r: number, from: number, to: number) => {
    const steps = Math.max(8, Math.ceil((Math.abs(to - from) / (2 * Math.PI)) * 64));
    for (let i = 0; i <= steps; i++) {
      const t = from + ((to - from) * i) / steps;
      pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
    }
  };
  let len: number;
  if (!crossed) {
    const beta = Math.acos((ra - rb) / dist); // tangent points sit at ψ ± β on both pulleys
    arc(b[0], b[1], rb, psi - beta, psi + beta); // around the far side of B
    arc(0, 0, ra, psi + beta, psi - beta + 2 * Math.PI); // around the far side of A
    len = 2 * Math.sqrt(dist * dist - (ra - rb) ** 2) + ra * (2 * Math.PI - 2 * beta) + rb * 2 * beta;
  } else {
    const beta = Math.acos((ra + rb) / dist);
    arc(b[0], b[1], rb, psi + Math.PI - beta, psi - Math.PI + beta); // B is wrapped clockwise
    arc(0, 0, ra, psi + beta, psi - beta + 2 * Math.PI);
    len = 2 * Math.sqrt(dist * dist - (ra + rb) ** 2) + (ra + rb) * (2 * Math.PI - 2 * beta);
  }
  return { points2d: pts, length: len };
}

// --- Plain-language description -----------------------------------------------------------------------

const nice = (n: number) => String(Number(n.toPrecision(3)));

/** One sentence per moving part, e.g. "small turns 3 times for every turn of big, the other way (90 rpm)." */
export function describeMotion(k: Kinematics): string[] {
  const d = k.driver;
  const lines = [`"${d.part}" is the driver, turning at ${nice(d.rpm)} rpm.`];
  for (const r of k.rotors) {
    if (r.direction === "driver") continue;
    const who = r.parts.length > 1 ? `"${r.name}" (with ${r.parts.filter((p) => p !== r.name).map((p) => `"${p}"`).join(", ")})` : `"${r.name}"`;
    const ratio = Math.abs(r.ratio);
    const how = Math.abs(ratio - 1) < 1e-9 ? "once for every turn" : ratio > 1 ? `${nice(ratio)} times for every turn` : `once for every ${nice(1 / ratio)} turns`;
    lines.push(`${who} turns ${how} of "${d.part}", ${r.direction === "same" ? "the same way" : "the other way"} (${nice(ratio * d.rpm)} rpm).`);
  }
  for (const rk of k.racks) {
    const rotor = k.rotors.find((r) => r.name === rk.rotor)!;
    const perTurn = Math.abs(rk.mmPerRad * rotor.ratio * 2 * Math.PI);
    lines.push(`"${rk.name}" slides ${nice(perTurn)} mm for every turn of "${d.part}" (${nice((perTurn * d.rpm) / 60)} mm/s).`);
  }
  for (const b of k.belts) lines.push(`The belt from "${b.a}" to "${b.b}"${b.crossed ? " (crossed)" : ""} is ${nice(b.length)} mm long.`);
  return lines;
}
