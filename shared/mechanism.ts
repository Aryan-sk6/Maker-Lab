// Turns a loose description ("a 40-tooth gear meshes with a 10-tooth gear") into an exact, working layout.
// This is what lets a model, or a child talking to one, describe mechanisms without doing geometry:
//
//   1. axle links put part b on part a's axle (b becomes a's child, offset along the axle);
//   2. every linked gear or pulley is made free to turn (gets a rotating joint) unless the input says otherwise;
//   3. parts without a position are placed next to the part they link to, at exactly the right distance,
//      choosing a direction that does not crash into parts already placed;
//   4. anything still unplaced goes to the origin, and parts without a colour get one from a palette;
//   5. the motion is solved (shared/kinematics.ts), which also checks every link.
//
// No zod and no DOM: the widget runs this too, when a student changes a gear's tooth count.

import type { LinkInput, ModelInput, ShapeInput } from "./model3d.js";
import { withShapeDefaults } from "./defaults.js";
import {
  AXES,
  IDENTITY,
  add,
  apply,
  axialThickness,
  dot,
  eulerXYZ,
  length,
  mul,
  normalize,
  outerRadius,
  pitchRadius,
  rotZ,
  scale,
  solveKinematics,
  sub,
  toEulerXYZ,
  transpose,
  worldPoses,
  type Issue,
  type KPart,
  type Kinematics,
  type Mat3,
  type Pose,
  type Vec3,
} from "./kinematics.js";

export const PALETTE = ["#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#eab308", "#64748b", "#f97316"];

export interface ResolvedPart extends KPart {
  color: string;
  /** True when the layout chose this part's position, so it may move it again after an edit. */
  autoPlaced?: boolean;
}

export interface Mechanism {
  title?: string;
  parts: ResolvedPart[];
  links: LinkInput[];
  driver?: { part: string; rpm: number };
  /** Undefined when nothing is linked, i.e. a static model. */
  kinematics?: Kinematics;
  notes: string[];
}

type InputPart = {
  name: string;
  shape: ShapeInput;
  position?: Vec3;
  /** Defaults to [0, 0, 0]; the schema fills it in on the server, but the widget may pass short descriptions. */
  rotation?: Vec3;
  color?: string;
  parent?: string;
  joint?: KPart["joint"];
  autoPlaced?: boolean;
};

const CANDIDATE_ANGLES = [0, 90, 180, 270, 45, 135, 225, 315, 30, 60, 120, 150, 210, 240, 300, 330];

export function buildMechanism(input: Pick<ModelInput, "title" | "driver"> & { links?: LinkInput[]; parts: InputPart[] }): Mechanism | { issues: Issue[] } {
  const issues: Issue[] = [];
  const notes: string[] = [];
  const parts: (InputPart & { rotation: Vec3 })[] = input.parts.map((p) => ({
    ...p,
    shape: withShapeDefaults(p.shape),
    position: p.position ? ([...p.position] as Vec3) : undefined,
    rotation: p.rotation ? ([...p.rotation] as Vec3) : [0, 0, 0],
    joint: p.joint ? { type: p.joint.type, axis: p.joint.axis ?? "z", angle: p.joint.angle ?? 0 } : undefined,
  }));
  const byName = new Map(parts.map((p) => [p.name, p]));
  const get = (name: string) => byName.get(name)!;
  const links = input.links ?? [];
  const auto = new Set<string>();

  // 1. Axles: b rides on a's axle.
  const axleChildren = new Set<string>();
  links.forEach((link, i) => {
    if (link.type !== "axle") return;
    const a = get(link.a);
    const b = get(link.b);
    if (b.parent !== undefined && b.parent !== a.name) {
      issues.push({ path: ["links", i, "b"], message: `"${b.name}" already sits on "${b.parent}"; remove its "parent" or this axle link` });
      return;
    }
    if (b.joint?.type === "rotating") {
      issues.push({ path: ["links", i, "b"], message: `"${b.name}" has its own rotating joint, but parts on a shared axle turn together; remove its joint` });
      return;
    }
    const axis = a.joint?.type === "rotating" ? a.joint.axis : "z";
    b.parent = a.name;
    b.joint = { type: "fixed", axis: "z", angle: 0 };
    axleChildren.add(b.name);
    if (b.position === undefined || b.autoPlaced) {
      const offset = link.offset ?? axialThickness(a.shape) / 2 + axialThickness(b.shape) / 2 + 2;
      b.position = scale(AXES[axis], offset);
      b.rotation = axis === "z" ? [0, 0, 0] : axis === "x" ? [0, 90, 0] : [-90, 0, 0]; // turn b's own Z onto a's axle
      auto.add(b.name);
    }
  });

  // 2. Linked gears and pulleys must be able to turn. Walk up through axle mounts to the part that carries them.
  const madeFree: string[] = [];
  const letTurn = (name: string) => {
    for (let cur = byName.get(name), guard = 0; cur && guard <= parts.length; guard++) {
      if (cur.joint?.type === "rotating") return;
      if (!cur.joint) {
        cur.joint = { type: "rotating", axis: "z", angle: 0 };
        madeFree.push(cur.name);
        return;
      }
      if (!axleChildren.has(cur.name) || !cur.parent) return; // an explicitly fixed part: the motion check will explain
      cur = byName.get(cur.parent);
    }
  };
  for (const link of links) {
    if (link.type === "mesh" || link.type === "belt") [link.a, link.b].forEach(letTurn);
    if (link.type === "rack") letTurn(link.pinion);
  }

  // 3. Placement. A part counts as placed when it and all its ancestors have positions.
  const isPlaced = (name: string): boolean => {
    for (let cur = byName.get(name), guard = 0; cur && guard <= parts.length; cur = cur.parent ? byName.get(cur.parent) : undefined, guard++) {
      if (cur.position === undefined) return false;
    }
    return true;
  };
  const poseOf = (name: string): Pose => {
    const chain: InputPart[] = [];
    for (let cur = byName.get(name); cur; cur = cur.parent ? byName.get(cur.parent) : undefined) chain.unshift(cur);
    let pose: Pose = { p: [0, 0, 0], R: IDENTITY };
    for (const part of chain) pose = { p: add(pose.p, apply(pose.R, part.position ?? [0, 0, 0])), R: mul(pose.R, eulerXYZ(part.rotation ?? [0, 0, 0])) };
    return pose;
  };

  /** Move `name` (via its topmost unplaced ancestor) so that it ends up at the world pose `target`. */
  const placeAt = (name: string, target: Pose) => {
    const chain: InputPart[] = [];
    for (let cur = byName.get(name); cur; cur = cur.parent ? byName.get(cur.parent) : undefined) {
      chain.unshift(cur);
      if (cur.position === undefined) break;
    }
    const root = chain[0]!; // the part whose position we choose
    let rel: Pose = { p: [0, 0, 0], R: IDENTITY }; // name's pose relative to root
    for (const part of chain.slice(1)) rel = { p: add(rel.p, apply(rel.R, part.position!)), R: mul(rel.R, eulerXYZ(part.rotation ?? [0, 0, 0])) };
    const R = mul(target.R, transpose(rel.R));
    const p = sub(target.p, apply(R, rel.p));
    const parent: Pose = root.parent ? poseOf(root.parent) : { p: [0, 0, 0], R: IDENTITY };
    root.position = apply(transpose(parent.R), sub(p, parent.p)).map((v) => Math.round(v * 1e6) / 1e6) as Vec3;
    root.rotation = toEulerXYZ(mul(transpose(parent.R), R));
    auto.add(root.name);
  };

  /** Does a round part of radius r and thickness t at pose `at` overlap anything already placed? */
  const collides = (at: Pose, r: number, t: number, ignore: Set<string>) => {
    const n = normalize(apply(at.R, AXES.z));
    return parts.some((other) => {
      if (ignore.has(other.name) || !isPlaced(other.name)) return false;
      const ro = outerRadius(other.shape);
      if (ro === undefined) return false;
      const d = sub(poseOf(other.name).p, at.p);
      const axial = dot(d, n);
      return Math.abs(axial) < (t + axialThickness(other.shape)) / 2 && length(sub(d, scale(n, axial))) < r + ro + 1;
    });
  };

  /** World pose for `mover` at distance `dist` from `anchor`, in the anchor's plane, at a free angle if possible. */
  const besideAnchor = (anchor: string, mover: string, dist: number, fixedAngle: number | undefined): Pose => {
    const a = poseOf(anchor);
    const m = get(mover);
    const ignore = new Set([anchor, mover]);
    const angles = fixedAngle === undefined ? CANDIDATE_ANGLES : [fixedAngle];
    let fallback: Pose | undefined;
    for (const deg of angles) {
      const t = (deg * Math.PI) / 180;
      const pose: Pose = { p: add(a.p, apply(a.R, [dist * Math.cos(t), dist * Math.sin(t), 0])), R: a.R };
      fallback ??= pose;
      if (!collides(pose, outerRadius(m.shape) ?? 0, axialThickness(m.shape), ignore)) return pose;
    }
    notes.push(`Could not find a clear spot for "${mover}" next to "${anchor}"; it may overlap another part.`);
    return fallback!;
  };

  const placeLink = (link: LinkInput): boolean => {
    if (link.type === "axle") return false;
    const [x, y] = link.type === "rack" ? [link.pinion, link.rack] : [link.a, link.b];
    const px = isPlaced(x);
    const py = isPlaced(y);
    if (px === py) return false;
    const [anchor, mover] = px ? [x, y] : [y, x];
    const flip = (deg: number | undefined) => (deg === undefined ? undefined : px ? deg : deg + 180);

    if (link.type === "mesh") {
      const ga = get(anchor).shape;
      const gm = get(mover).shape;
      if (ga.type !== "gear" || gm.type !== "gear") return false; // the motion check reports this
      placeAt(mover, besideAnchor(anchor, mover, pitchRadius(ga) + pitchRadius(gm), flip(link.angle)));
    } else if (link.type === "belt") {
      const sa = get(anchor).shape;
      const sm = get(mover).shape;
      if (sa.type !== "pulley" || sm.type !== "pulley") return false;
      const dist = link.distance ?? sa.diameter / 2 + sm.diameter / 2 + 0.75 * Math.max(sa.diameter, sm.diameter);
      placeAt(mover, besideAnchor(anchor, mover, dist, flip(link.angle)));
    } else {
      const pin = get(link.pinion).shape;
      if (pin.type !== "gear") return false;
      const r = pitchRadius(pin);
      if (anchor === link.pinion) {
        // The rack goes under the pinion: its teeth face the pinion, its length along the pinion's X (turned by `angle`).
        const a = poseOf(anchor);
        const R: Mat3 = mul(a.R, rotZ(((link.angle ?? 0) * Math.PI) / 180));
        placeAt(mover, { p: sub(a.p, apply(R, [0, r, 0])), R });
      } else {
        const a = poseOf(anchor);
        placeAt(mover, { p: add(a.p, apply(a.R, [0, r, 0])), R: a.R });
      }
    }
    return true;
  };

  const seedable = links.filter((l) => l.type !== "axle");
  for (let guard = 0; guard < parts.length * 2 + 2; guard++) {
    let progress = false;
    for (const link of seedable) progress = placeLink(link) || progress;
    if (progress) continue;
    // Nothing more can be placed from what is fixed: start a new group at the origin.
    const unplacedLink = seedable.find((l) => !isPlaced(l.type === "rack" ? l.pinion : l.a));
    if (!unplacedLink) break;
    const start = unplacedLink.type === "rack" ? unplacedLink.pinion : unplacedLink.a;
    placeAt(start, { p: [0, 0, 0], R: IDENTITY });
  }

  // 4. Everything else: origin and palette colour.
  let colour = 0;
  const resolved: ResolvedPart[] = parts.map((p) => {
    const part: ResolvedPart = {
      name: p.name,
      shape: p.shape,
      position: p.position ?? [0, 0, 0],
      rotation: p.rotation,
      color: p.color ?? PALETTE[colour++ % PALETTE.length]!,
      ...(p.parent !== undefined ? { parent: p.parent } : {}),
      ...(p.joint ? { joint: p.joint } : {}),
      ...(auto.has(p.name) || (p.autoPlaced && p.position !== undefined) ? { autoPlaced: true } : {}),
    };
    return part;
  });
  if (issues.length > 0) return { issues };
  if (madeFree.length > 0) notes.push(`Made ${madeFree.map((n) => `"${n}"`).join(", ")} free to turn on ${madeFree.length === 1 ? "its" : "their"} own axle.`);
  if (auto.size > 0) notes.push(`Placed ${[...auto].map((n) => `"${n}"`).join(", ")} automatically so the linked parts fit together.`);

  // 5. Motion.
  const motionLinks = links.filter((l) => l.type !== "axle");
  let kinematics: Kinematics | undefined;
  if (motionLinks.length > 0) {
    const solved = solveKinematics(resolved, motionLinks.map((l) => ({ ...l, link: links.indexOf(l) })) as LinkInput[], input.driver);
    if ("issues" in solved) {
      if (solved.issues.length > 0) return { issues: remapLinkPaths(solved.issues, links) };
    } else {
      kinematics = solved.kinematics;
      notes.push(...kinematics.notes);
    }
  }
  overlapNotes(resolved, links, notes);
  return { title: input.title, parts: resolved, links, driver: input.driver, kinematics, notes };
}

/** solveKinematics numbers links among the non-axle ones; report them by their index in the full list. */
function remapLinkPaths(issues: Issue[], links: LinkInput[]): Issue[] {
  const motionIndex = links.map((l, i) => (l.type === "axle" ? -1 : i)).filter((i) => i >= 0);
  return issues.map((issue) => (issue.path[0] === "links" && typeof issue.path[1] === "number" ? { ...issue, path: ["links", motionIndex[issue.path[1]] ?? issue.path[1], ...issue.path.slice(2)] } : issue));
}

/** Warn (not fail) about round parts that overlap without being linked. */
function overlapNotes(parts: ResolvedPart[], links: LinkInput[], notes: string[]) {
  const poses = worldPoses(parts);
  const paired = new Set(links.flatMap((l) => (l.type === "rack" ? [] : [`${l.a}|${l.b}`, `${l.b}|${l.a}`])));
  const round = parts.filter((p) => outerRadius(p.shape) !== undefined);
  for (let i = 0; i < round.length; i++) {
    for (let j = i + 1; j < round.length; j++) {
      const a = round[i]!;
      const b = round[j]!;
      if (paired.has(`${a.name}|${b.name}`) || a.parent === b.name || b.parent === a.name) continue;
      const pa = poses.get(a.name)!;
      const n = normalize(apply(pa.R, AXES.z));
      const d = sub(poses.get(b.name)!.p, pa.p);
      const axial = dot(d, n);
      const overlapAxially = Math.abs(axial) < (axialThickness(a.shape) + axialThickness(b.shape)) / 2;
      if (overlapAxially && length(sub(d, scale(n, axial))) < outerRadius(a.shape)! + outerRadius(b.shape)! - 0.5) {
        notes.push(`"${a.name}" and "${b.name}" overlap. Move one, or link them if they should mesh.`);
      }
    }
  }
}
