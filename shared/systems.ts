// The six simulated systems: parameters, equations, time scales, key results and plot views.
// No zod and no DOM here: the server (validation, summaries) and the widget (live re-runs) share it.

import {
  agm,
  argMax,
  firstCrossing,
  integrateRK4,
  maxAbs,
  maxOf,
  settlingTime,
  upwardCrossings,
  type Derivative,
  type Solution,
} from "./solver.js";
import { formatValue, sig } from "./format.js";

export const DISCLAIMER = "Educational model with simplifying assumptions.";

/** Hard cap on RK4 steps per run, so a request can never run away. */
export const MAX_STEPS = 100_000;
/** Steps used for an automatically chosen duration are kept well under the cap. */
const AUTO_STEPS_CAP = 50_000;
/** The fixed step is 1/100 of the fastest time scale in the system. */
const STEPS_PER_TIMESCALE = 100;
export const MAX_DURATION = 1e6;

export type Params = Record<string, number>;

export type SystemId =
  | "pendulum"
  | "projectile"
  | "mass_spring_damper"
  | "rc_circuit"
  | "rlc_circuit"
  | "logistic_growth";

export interface ParamSpec {
  label: string;
  unit: string;
  default: number;
  min: number;
  max: number;
  /** Slider mapping: linear, logarithmic (min > 0), or log that still reaches 0 (uses `ref` as the knee). */
  scale?: "linear" | "log" | "log0";
  ref?: number;
}

export interface KeyValue {
  key: string;
  label: string;
  value: number | string | null;
  unit: string;
  /** "numerical": read off the RK4 solution. "formula": closed-form result for comparison or definition. */
  basis: "numerical" | "formula";
}

export interface ViewSpec {
  id: string;
  label: string;
  x: { series: string; label: string; unit: string };
  y: { label: string; unit: string };
  lines: { series: string; label: string }[];
  /** Horizontal reference lines, e.g. the supply voltage. */
  refs?: (p: Params) => { y: number; label: string }[];
  /** Hover read-out needs x to increase along the curve. */
  hover?: boolean;
  /** Use the same scale on both axes (a trajectory), unless that would squash the curve flat. */
  equalAspect?: boolean;
}

export interface SystemDef {
  id: SystemId;
  label: string;
  timeUnit: string;
  summary: string;
  params: Record<string, ParamSpec>;
  assumptions: string[];
  /** Cross-field checks. Return a message per problem. */
  validate?(p: Params): { param?: string; message: string }[];
  /** Fixed step and default duration for these parameters. */
  scales(p: Params): { dt: number; duration: number };
  initial(p: Params): number[];
  deriv(p: Params): Derivative;
  stopBelow?(p: Params): { index: number; level: number };
  /** Named arrays for plotting (always includes "t"). */
  series(sol: Solution, p: Params): Record<string, Float64Array>;
  keyValues(sol: Solution, s: Record<string, Float64Array>, p: Params): KeyValue[];
  views: ViewSpec[];
  /** Columns of the sampled-values table. */
  table: { series: string; label: string; unit: string }[];
  /** Systems with a motion worth animating (pendulum, projectile). */
  animated?: boolean;
}

const RAD = Math.PI / 180;
const kv = (key: string, label: string, value: number | string | null, unit: string, basis: KeyValue["basis"]): KeyValue => ({
  key,
  label,
  value,
  unit,
  basis,
});
const mapArr = (a: ArrayLike<number>, fn: (v: number, i: number) => number) => Float64Array.from(a as ArrayLike<number>, fn);

// --- Second-order linear systems -------------------------------------------
// x'' + a1·x' + a0·x = 0. Used for the damped spring and series RLC, and for the pendulum's
// small-angle behaviour (to choose a step and duration).

interface SecondOrder {
  wn: number;
  zeta: number;
  regime: "undamped" | "underdamped" | "critically damped" | "overdamped";
  /** Damped angular frequency (0 if not oscillating). */
  wd: number;
  /** Largest |pole|, which sets the step size. */
  rateMax: number;
  /** Decay rate of the slowest mode (0 if undamped). */
  decay: number;
}

function secondOrder(a1: number, a0: number): SecondOrder {
  const wn = Math.sqrt(a0);
  const zeta = a1 / (2 * wn);
  const disc = (a1 * a1) / 4 - a0;
  if (a1 === 0) return { wn, zeta, regime: "undamped", wd: wn, rateMax: wn, decay: 0 };
  if (Math.abs(disc) < 1e-9 * a0) return { wn, zeta, regime: "critically damped", wd: 0, rateMax: a1 / 2, decay: a1 / 2 };
  if (disc < 0) return { wn, zeta, regime: "underdamped", wd: Math.sqrt(-disc), rateMax: wn, decay: a1 / 2 };
  const root = Math.sqrt(disc);
  return { wn, zeta, regime: "overdamped", wd: 0, rateMax: a1 / 2 + root, decay: a0 / (a1 / 2 + root) };
}

/** ~8 oscillations, or until the envelope has decayed to 0.25%, whichever comes first. */
function secondOrderDuration(so: SecondOrder, periodScale = 1): number {
  if (so.wd > 0) {
    const eight = (8 * 2 * Math.PI * periodScale) / so.wd;
    return so.decay > 0 ? Math.min(6 / so.decay, eight) : eight;
  }
  return 6 / so.decay;
}

const stepFor = (rate: number) => 1 / (STEPS_PER_TIMESCALE * rate);

// --- Pendulum ---------------------------------------------------------------

const pendulum: SystemDef = {
  id: "pendulum",
  label: "Simple pendulum",
  timeUnit: "s",
  summary: "Point mass on a rigid rod: θ'' = −(g/L)·sin θ − b·θ'. Optional viscous damping b.",
  params: {
    length_m: { label: "Rod length L", unit: "m", default: 1, min: 0.01, max: 100, scale: "log" },
    gravity_ms2: { label: "Gravity g", unit: "m/s²", default: 9.81, min: 0.1, max: 30 },
    theta0_deg: { label: "Initial angle θ₀", unit: "°", default: 30, min: -179, max: 179 },
    omega0_rads: { label: "Initial angular velocity ω₀", unit: "rad/s", default: 0, min: -20, max: 20 },
    damping_per_s: { label: "Damping b", unit: "1/s", default: 0, min: 0, max: 20, scale: "log0", ref: 0.01 },
  },
  assumptions: [
    "A point mass on a massless, rigid, frictionless-pivot rod; the rod never goes slack.",
    "Uniform gravity; angle measured from straight down (0° = hanging at rest).",
    "The full nonlinear equation is solved (sin θ is not replaced by θ), so large swings are handled.",
    "Damping is viscous: a torque proportional to angular velocity. Real air drag is closer to quadratic.",
  ],
  scales(p) {
    const g = p.gravity_ms2!;
    const L = p.length_m!;
    const b = p.damping_per_s!;
    const a0 = g / L;
    const so = secondOrder(b, a0);
    const wMax = Math.sqrt(p.omega0_rads! ** 2 + 4 * a0); // fastest angular speed an undamped swing reaches
    const rate = Math.max(so.rateMax, wMax, b);
    const th = Math.abs(p.theta0_deg!) * RAD;
    const periodScale = th < Math.PI ? 1 / agm(1, Math.cos(th / 2)) : 1; // large swings take longer
    return { dt: stepFor(rate), duration: secondOrderDuration(so, periodScale) };
  },
  initial: (p) => [p.theta0_deg! * RAD, p.omega0_rads!],
  deriv: (p) => {
    const a0 = p.gravity_ms2! / p.length_m!;
    const b = p.damping_per_s!;
    return (_t, y, dy) => {
      dy[0] = y[1]!;
      dy[1] = -a0 * Math.sin(y[0]!) - b * y[1]!;
    };
  },
  series: (sol) => ({
    t: sol.t,
    theta_deg: mapArr(sol.y[0]!, (v) => v / RAD),
    omega: sol.y[1]!,
  }),
  keyValues(sol, s, p) {
    const L = p.length_m!;
    const g = p.gravity_ms2!;
    const b = p.damping_per_s!;
    const out: KeyValue[] = [kv("period_small", "Small-angle period 2π√(L/g)", (2 * Math.PI) / Math.sqrt(g / L), "s", "formula")];
    const th0 = Math.abs(p.theta0_deg!) * RAD;
    if (b === 0 && p.omega0_rads === 0 && th0 > 0) {
      out.push(kv("period_exact", "Exact undamped period at this amplitude", ((2 * Math.PI) / Math.sqrt(g / L)) / agm(1, Math.cos(th0 / 2)), "s", "formula"));
    }
    const ups = upwardCrossings(sol.t, sol.y[0]!, 0);
    out.push(
      kv("period_measured", "Period measured from the solution", ups.length >= 2 ? (ups[ups.length - 1]! - ups[0]!) / (ups.length - 1) : null, "s", "numerical"),
    );
    out.push(kv("max_angle", "Largest angle reached", maxAbs(s.theta_deg!), "°", "numerical"));
    out.push(kv("max_speed", "Maximum bob speed", L * maxAbs(sol.y[1]!), "m/s", "numerical"));
    if (b > 0) out.push(kv("decay_time", "Amplitude decay time constant 2/b", 2 / b, "s", "formula"));
    return out;
  },
  views: [
    {
      id: "angle",
      label: "Angle vs time",
      x: { series: "t", label: "time", unit: "s" },
      y: { label: "angle", unit: "°" },
      lines: [{ series: "theta_deg", label: "θ" }],
      refs: () => [{ y: 0, label: "" }],
      hover: true,
    },
    {
      id: "phase",
      label: "Phase portrait",
      x: { series: "theta_deg", label: "angle", unit: "°" },
      y: { label: "angular velocity", unit: "rad/s" },
      lines: [{ series: "omega", label: "ω" }],
    },
  ],
  table: [
    { series: "theta_deg", label: "angle", unit: "°" },
    { series: "omega", label: "angular velocity", unit: "rad/s" },
  ],
  animated: true,
};

// --- Projectile ---------------------------------------------------------------

const noDragFlightTime = (p: Params) => {
  const vy = p.speed_ms! * Math.sin(p.angle_deg! * RAD);
  return (vy + Math.sqrt(vy * vy + 2 * p.gravity_ms2! * p.height0_m!)) / p.gravity_ms2!;
};

const projectile: SystemDef = {
  id: "projectile",
  label: "Projectile",
  timeUnit: "s",
  summary: "Point mass thrown over flat ground, with optional drag proportional to velocity: a = −g·ŷ − k·v.",
  params: {
    speed_ms: { label: "Launch speed", unit: "m/s", default: 20, min: 0.1, max: 1000, scale: "log" },
    angle_deg: { label: "Launch angle", unit: "°", default: 45, min: -90, max: 90 },
    height0_m: { label: "Launch height", unit: "m", default: 0, min: 0, max: 1000 },
    gravity_ms2: { label: "Gravity g", unit: "m/s²", default: 9.81, min: 0.1, max: 30 },
    drag_per_s: { label: "Linear drag k", unit: "1/s", default: 0, min: 0, max: 10, scale: "log0", ref: 0.01 },
  },
  assumptions: [
    "A point mass: no spin, no lift, no wind, and no Earth curvature or rotation.",
    "Uniform gravity and flat, level ground at height 0; the run ends when the projectile lands.",
    "Drag is linear in velocity (a = −k·v), which suits slow motion in a thick fluid. Fast objects in air feel closer to v² drag, so real ranges will differ.",
    "No air-density change with height.",
  ],
  validate(p) {
    return noDragFlightTime(p) < 1e-9
      ? [{ param: "angle_deg", message: "the projectile starts on the ground without moving upward, so it lands immediately; raise angle_deg above 0 or set height0_m above 0" }]
      : [];
  },
  scales(p) {
    const tf = noDragFlightTime(p);
    const dt = Math.min(tf / 2000, p.drag_per_s! > 0 ? stepFor(p.drag_per_s!) : Infinity);
    return { dt, duration: tf * 1.05 };
  },
  initial: (p) => [0, p.height0_m!, p.speed_ms! * Math.cos(p.angle_deg! * RAD), p.speed_ms! * Math.sin(p.angle_deg! * RAD)],
  deriv: (p) => {
    const g = p.gravity_ms2!;
    const k = p.drag_per_s!;
    return (_t, y, dy) => {
      dy[0] = y[2]!;
      dy[1] = y[3]!;
      dy[2] = -k * y[2]!;
      dy[3] = -g - k * y[3]!;
    };
  },
  stopBelow: () => ({ index: 1, level: 0 }),
  series: (sol) => ({
    t: sol.t,
    x: sol.y[0]!,
    y: sol.y[1]!,
    vx: sol.y[2]!,
    vy: sol.y[3]!,
    speed: mapArr(sol.t, (_t, i) => Math.hypot(sol.y[2]![i]!, sol.y[3]![i]!)),
  }),
  keyValues(sol, s, p) {
    const n = sol.t.length - 1;
    const apex = argMax(s.y!);
    const landed = sol.stoppedEarly;
    const out: KeyValue[] = [
      kv("max_height", "Maximum height", s.y![apex]!, "m", "numerical"),
      kv("apex_time", "Time to maximum height", s.t![apex]!, "s", "numerical"),
      kv("flight_time", landed ? "Flight time (until landing)" : "Time simulated (has not landed)", s.t![n]!, "s", "numerical"),
      kv("range", landed ? "Range" : "Distance travelled so far", s.x![n]!, "m", "numerical"),
    ];
    if (landed) out.push(kv("impact_speed", "Impact speed", s.speed![n]!, "m/s", "numerical"));
    if (p.drag_per_s! > 0) {
      out.push(kv("range_no_drag", "Range without drag (for comparison)", p.speed_ms! * Math.cos(p.angle_deg! * RAD) * noDragFlightTime(p), "m", "formula"));
    }
    return out;
  },
  views: [
    {
      id: "trajectory",
      label: "Trajectory",
      x: { series: "x", label: "distance", unit: "m" },
      y: { label: "height", unit: "m" },
      lines: [{ series: "y", label: "path" }],
      refs: () => [{ y: 0, label: "ground" }],
      hover: true,
      equalAspect: true,
    },
    {
      id: "height",
      label: "Height vs time",
      x: { series: "t", label: "time", unit: "s" },
      y: { label: "height", unit: "m" },
      lines: [{ series: "y", label: "height" }],
      hover: true,
    },
  ],
  table: [
    { series: "x", label: "x", unit: "m" },
    { series: "y", label: "height", unit: "m" },
    { series: "speed", label: "speed", unit: "m/s" },
  ],
  animated: true,
};

// --- Mass–spring–damper ----------------------------------------------------------

const massSpringDamper: SystemDef = {
  id: "mass_spring_damper",
  label: "Mass–spring–damper",
  timeUnit: "s",
  summary: "m·x'' + c·x' + k·x = 0, released from displacement x₀ with velocity v₀.",
  params: {
    mass_kg: { label: "Mass m", unit: "kg", default: 1, min: 0.001, max: 1000, scale: "log" },
    stiffness_Npm: { label: "Spring stiffness k", unit: "N/m", default: 20, min: 0.01, max: 1e5, scale: "log" },
    damping_Nspm: { label: "Damping c", unit: "N·s/m", default: 1, min: 0, max: 1e4, scale: "log0", ref: 0.1 },
    x0_m: { label: "Initial displacement x₀", unit: "m", default: 0.1, min: -10, max: 10 },
    v0_ms: { label: "Initial velocity v₀", unit: "m/s", default: 0, min: -50, max: 50 },
  },
  assumptions: [
    "One mass moving in one dimension; x = 0 is the equilibrium position (gravity's constant offset is folded into it).",
    "Ideal linear spring (Hooke's law, no stiffening or yielding) with negligible spring mass.",
    "Viscous damper: force proportional to velocity. No dry friction.",
    "Parameters stay constant; no external driving force.",
  ],
  scales(p) {
    const so = secondOrder(p.damping_Nspm! / p.mass_kg!, p.stiffness_Npm! / p.mass_kg!);
    return { dt: stepFor(so.rateMax), duration: secondOrderDuration(so) };
  },
  initial: (p) => [p.x0_m!, p.v0_ms!],
  deriv: (p) => {
    const a0 = p.stiffness_Npm! / p.mass_kg!;
    const a1 = p.damping_Nspm! / p.mass_kg!;
    return (_t, y, dy) => {
      dy[0] = y[1]!;
      dy[1] = -a0 * y[0]! - a1 * y[1]!;
    };
  },
  series: (sol) => ({ t: sol.t, x: sol.y[0]!, v: sol.y[1]! }),
  keyValues(sol, s, p) {
    const m = p.mass_kg!;
    const c = p.damping_Nspm!;
    const so = secondOrder(c / m, p.stiffness_Npm! / m);
    const out: KeyValue[] = [
      kv("omega_n", "Natural angular frequency √(k/m)", so.wn, "rad/s", "formula"),
      kv("f_n", "Natural frequency", so.wn / (2 * Math.PI), "Hz", "formula"),
      kv("zeta", "Damping ratio ζ = c/(2√(km))", so.zeta, "", "formula"),
      kv("regime", "Behaviour", so.regime, "", "formula"),
    ];
    if (so.regime === "underdamped") out.push(kv("period_damped", "Damped period", (2 * Math.PI) / so.wd, "s", "formula"));
    if (c > 0) out.push(kv("tau", "Envelope time constant 2m/c", (2 * m) / c, "s", "formula"));
    out.push(kv("max_disp", "Largest displacement", maxAbs(s.x!), "m", "numerical"));
    out.push(kv("settle", "Settling time (stays within 2% of its peak)", settlingTime(sol.t, s.x!, 0.02), "s", "numerical"));
    return out;
  },
  views: [
    {
      id: "displacement",
      label: "Displacement vs time",
      x: { series: "t", label: "time", unit: "s" },
      y: { label: "displacement", unit: "m" },
      lines: [{ series: "x", label: "x" }],
      refs: () => [{ y: 0, label: "" }],
      hover: true,
    },
    {
      id: "phase",
      label: "Phase portrait",
      x: { series: "x", label: "displacement", unit: "m" },
      y: { label: "velocity", unit: "m/s" },
      lines: [{ series: "v", label: "v" }],
    },
  ],
  table: [
    { series: "x", label: "displacement", unit: "m" },
    { series: "v", label: "velocity", unit: "m/s" },
  ],
};

// --- RC circuit ------------------------------------------------------------------

const rcCircuit: SystemDef = {
  id: "rc_circuit",
  label: "Series RC circuit",
  timeUnit: "s",
  summary: "A voltage source switched on at t = 0 charges a capacitor through a resistor: RC·dV_C/dt = V_s − V_C.",
  params: {
    voltage_V: { label: "Source voltage V_s", unit: "V", default: 5, min: -1000, max: 1000 },
    resistance_ohm: { label: "Resistance R", unit: "Ω", default: 1000, min: 1e-3, max: 1e9, scale: "log" },
    capacitance_F: { label: "Capacitance C", unit: "F", default: 1e-6, min: 1e-12, max: 10, scale: "log" },
    vc0_V: { label: "Initial capacitor voltage", unit: "V", default: 0, min: -1000, max: 1000 },
  },
  assumptions: [
    "Ideal resistor and capacitor: no leakage, no parasitic inductance or resistance in the capacitor.",
    "Ideal voltage source with zero internal resistance, switched on instantly at t = 0.",
    "Component values are constant (no temperature or voltage dependence).",
  ],
  scales(p) {
    const tau = p.resistance_ohm! * p.capacitance_F!;
    return { dt: tau / STEPS_PER_TIMESCALE, duration: 6 * tau };
  },
  initial: (p) => [p.vc0_V!],
  deriv: (p) => {
    const tau = p.resistance_ohm! * p.capacitance_F!;
    return (_t, y, dy) => {
      dy[0] = (p.voltage_V! - y[0]!) / tau;
    };
  },
  series: (sol, p) => ({
    t: sol.t,
    vc: sol.y[0]!,
    vr: mapArr(sol.y[0]!, (v) => p.voltage_V! - v),
    i: mapArr(sol.y[0]!, (v) => (p.voltage_V! - v) / p.resistance_ohm!),
  }),
  keyValues(sol, s, p) {
    const R = p.resistance_ohm!;
    const C = p.capacitance_F!;
    const Vs = p.voltage_V!;
    const v0 = p.vc0_V!;
    const out: KeyValue[] = [kv("tau", "Time constant τ = RC", R * C, "s", "formula")];
    const tau63 = Vs === v0 ? null : firstCrossing(sol.t, s.vc!, v0 + (1 - Math.exp(-1)) * (Vs - v0));
    out.push(kv("t63", "Time to 63.2% of the change", tau63, "s", "numerical"));
    out.push(kv("settle", "Settling time (within 2% of final)", settlingTime(sol.t, mapArr(s.vc!, (v) => v - Vs), 0.02), "s", "numerical"));
    out.push(kv("v_end", "Capacitor voltage at the end", s.vc![s.vc!.length - 1]!, "V", "numerical"));
    out.push(kv("i0", "Initial current (V_s − V₀)/R", (Vs - v0) / R, "A", "formula"));
    return out;
  },
  views: [
    {
      id: "voltage",
      label: "Voltages",
      x: { series: "t", label: "time", unit: "s" },
      y: { label: "voltage", unit: "V" },
      lines: [
        { series: "vc", label: "capacitor V_C" },
        { series: "vr", label: "resistor V_R" },
      ],
      refs: (p) => [{ y: p.voltage_V!, label: "V_s" }],
      hover: true,
    },
    {
      id: "current",
      label: "Current",
      x: { series: "t", label: "time", unit: "s" },
      y: { label: "current", unit: "A" },
      lines: [{ series: "i", label: "i" }],
      hover: true,
    },
  ],
  table: [
    { series: "vc", label: "V_C", unit: "V" },
    { series: "i", label: "current", unit: "A" },
  ],
};

// --- RLC circuit -----------------------------------------------------------------

const rlcCircuit: SystemDef = {
  id: "rlc_circuit",
  label: "Series RLC circuit",
  timeUnit: "s",
  summary: "A voltage step applied to a resistor, inductor and capacitor in series: L·di/dt = V_s − R·i − V_C, C·dV_C/dt = i.",
  params: {
    voltage_V: { label: "Source voltage V_s", unit: "V", default: 5, min: -1000, max: 1000 },
    resistance_ohm: { label: "Resistance R", unit: "Ω", default: 10, min: 0, max: 1e6, scale: "log0", ref: 0.1 },
    inductance_H: { label: "Inductance L", unit: "H", default: 1e-3, min: 1e-9, max: 100, scale: "log" },
    capacitance_F: { label: "Capacitance C", unit: "F", default: 1e-6, min: 1e-12, max: 1, scale: "log" },
    vc0_V: { label: "Initial capacitor voltage", unit: "V", default: 0, min: -1000, max: 1000 },
    i0_A: { label: "Initial current", unit: "A", default: 0, min: -100, max: 100 },
  },
  assumptions: [
    "Ideal series R, L and C: no parasitic capacitance or resistance, no core saturation, no skin effect.",
    "Ideal voltage source with zero internal resistance, switched on instantly at t = 0.",
    "Component values are constant. With R = 0 the circuit rings forever in this model; real circuits always have some resistance.",
  ],
  scales(p) {
    const so = secondOrder(p.resistance_ohm! / p.inductance_H!, 1 / (p.inductance_H! * p.capacitance_F!));
    return { dt: stepFor(so.rateMax), duration: secondOrderDuration(so) };
  },
  initial: (p) => [p.vc0_V!, p.i0_A!],
  deriv: (p) => {
    const Vs = p.voltage_V!;
    const R = p.resistance_ohm!;
    const L = p.inductance_H!;
    const C = p.capacitance_F!;
    return (_t, y, dy) => {
      dy[0] = y[1]! / C;
      dy[1] = (Vs - R * y[1]! - y[0]!) / L;
    };
  },
  series: (sol) => ({ t: sol.t, vc: sol.y[0]!, i: sol.y[1]! }),
  keyValues(sol, s, p) {
    const R = p.resistance_ohm!;
    const L = p.inductance_H!;
    const C = p.capacitance_F!;
    const Vs = p.voltage_V!;
    const v0 = p.vc0_V!;
    const so = secondOrder(R / L, 1 / (L * C));
    const out: KeyValue[] = [
      kv("omega0", "Resonant angular frequency 1/√(LC)", so.wn, "rad/s", "formula"),
      kv("f0", "Resonant frequency", so.wn / (2 * Math.PI), "Hz", "formula"),
      kv("zeta", "Damping ratio ζ = (R/2)√(C/L)", so.zeta, "", "formula"),
      kv("regime", "Behaviour", so.regime, "", "formula"),
      kv("r_crit", "Critical resistance 2√(L/C)", 2 * Math.sqrt(L / C), "Ω", "formula"),
    ];
    if (R > 0) out.push(kv("q", "Quality factor Q = (1/R)√(L/C)", Math.sqrt(L / C) / R, "", "formula"));
    if (so.regime === "underdamped") out.push(kv("f_damped", "Ringing frequency", so.wd / (2 * Math.PI), "Hz", "formula"));
    const step = Vs - v0;
    const peak = maxOf(step >= 0 ? s.vc! : mapArr(s.vc!, (v) => -v)) * (step >= 0 ? 1 : -1);
    out.push(kv("v_peak", "Peak capacitor voltage", peak, "V", "numerical"));
    out.push(kv("overshoot", "Overshoot above the final voltage", step === 0 ? null : Math.max(0, ((peak - Vs) / step) * 100), "%", "numerical"));
    out.push(kv("settle", "Settling time (within 2% of final)", settlingTime(sol.t, mapArr(s.vc!, (v) => v - Vs), 0.02), "s", "numerical"));
    out.push(kv("i_max", "Largest current magnitude", maxAbs(s.i!), "A", "numerical"));
    return out;
  },
  views: [
    {
      id: "voltage",
      label: "Capacitor voltage",
      x: { series: "t", label: "time", unit: "s" },
      y: { label: "voltage", unit: "V" },
      lines: [{ series: "vc", label: "V_C" }],
      refs: (p) => [{ y: p.voltage_V!, label: "V_s" }],
      hover: true,
    },
    {
      id: "current",
      label: "Current",
      x: { series: "t", label: "time", unit: "s" },
      y: { label: "current", unit: "A" },
      lines: [{ series: "i", label: "i" }],
      hover: true,
    },
  ],
  table: [
    { series: "vc", label: "V_C", unit: "V" },
    { series: "i", label: "current", unit: "A" },
  ],
};

// --- Logistic growth -------------------------------------------------------------

const logisticGrowth: SystemDef = {
  id: "logistic_growth",
  label: "Logistic population growth",
  timeUnit: "time units",
  summary: "dN/dt = r·N·(1 − N/K): growth that slows as the population approaches the carrying capacity K.",
  params: {
    growth_rate: { label: "Growth rate r", unit: "1/time", default: 0.5, min: 0.001, max: 10, scale: "log" },
    capacity: { label: "Carrying capacity K", unit: "", default: 1000, min: 1, max: 1e12, scale: "log" },
    population0: { label: "Initial population N₀", unit: "", default: 10, min: 1e-6, max: 1e12, scale: "log" },
  },
  assumptions: [
    "One closed population: no migration, no age or sex structure, no delays.",
    "Deterministic and continuous: the population is a smooth quantity, not whole individuals, and has no random fluctuation.",
    "Per-capita growth falls linearly with population and is zero at the carrying capacity K, which is constant. Real populations often overshoot or crash.",
    "Time is in whatever unit r is expressed in (years, hours, …); the model does not care.",
  ],
  scales(p) {
    const r = p.growth_rate!;
    const K = p.capacity!;
    const N0 = p.population0!;
    const reach = N0 < K ? Math.log((99 * (K - N0)) / N0) : Math.log(Math.max((N0 - K) / (0.01 * K), 1));
    return { dt: stepFor(r), duration: Math.max(reach, 5) * 1.1 / r };
  },
  initial: (p) => [p.population0!],
  deriv: (p) => {
    const r = p.growth_rate!;
    const K = p.capacity!;
    return (_t, y, dy) => {
      dy[0] = r * y[0]! * (1 - y[0]! / K);
    };
  },
  series: (sol, p) => ({
    t: sol.t,
    n: sol.y[0]!,
    growth: mapArr(sol.y[0]!, (n) => p.growth_rate! * n * (1 - n / p.capacity!)),
  }),
  keyValues(sol, s, p) {
    const r = p.growth_rate!;
    const K = p.capacity!;
    const N0 = p.population0!;
    const out: KeyValue[] = [kv("capacity", "Carrying capacity K", K, "", "formula")];
    out.push(kv("t_half", "Time to reach K/2", N0 < K / 2 ? firstCrossing(sol.t, s.n!, K / 2) : null, "time units", "numerical"));
    if (N0 < K / 2) out.push(kv("t_half_formula", "Time to K/2 from the closed-form solution", Math.log((K - N0) / N0) / r, "time units", "formula"));
    out.push(kv("n_end", "Population at the end", s.n![s.n!.length - 1]!, "", "numerical"));
    out.push(kv("max_growth", "Fastest growth rate", maxAbs(s.growth!), "per time unit", "numerical"));
    if (N0 < K / 10) out.push(kv("doubling", "Early doubling time ln2/r", Math.LN2 / r, "time units", "formula"));
    return out;
  },
  views: [
    {
      id: "population",
      label: "Population",
      x: { series: "t", label: "time", unit: "time units" },
      y: { label: "population", unit: "" },
      lines: [{ series: "n", label: "N" }],
      refs: (p) => [{ y: p.capacity!, label: "K" }],
      hover: true,
    },
    {
      id: "rate",
      label: "Growth rate",
      x: { series: "t", label: "time", unit: "time units" },
      y: { label: "dN/dt", unit: "per time unit" },
      lines: [{ series: "growth", label: "dN/dt" }],
      hover: true,
    },
  ],
  table: [{ series: "n", label: "population", unit: "" }],
};

export const SYSTEMS: Record<SystemId, SystemDef> = {
  pendulum,
  projectile,
  mass_spring_damper: massSpringDamper,
  rc_circuit: rcCircuit,
  rlc_circuit: rlcCircuit,
  logistic_growth: logisticGrowth,
};
export const SYSTEM_IDS = Object.keys(SYSTEMS) as SystemId[];

export function defaultParams(id: SystemId): Params {
  return Object.fromEntries(Object.entries(SYSTEMS[id].params).map(([k, s]) => [k, s.default]));
}

// --- Planning: validate, fill defaults, choose the fixed step -------------------------

export interface PlanIssue {
  path: (string | number)[];
  message: string;
}

export interface Plan {
  system: SystemId;
  params: Params;
  /** Simulated time (in the system's time unit). May end sooner if a projectile lands. */
  duration: number;
  /** True when no duration was requested and one was chosen from the dynamics. */
  durationAuto: boolean;
  dt: number;
  steps: number;
}

export function planSimulation(system: SystemId, given: Record<string, unknown> | undefined, duration?: number): { plan: Plan } | { issues: PlanIssue[] } {
  const def = SYSTEMS[system];
  const issues: PlanIssue[] = [];
  const valid = Object.keys(def.params).join(", ");
  const params = defaultParams(system);

  for (const [key, value] of Object.entries(given ?? {})) {
    const spec = def.params[key];
    if (!spec) {
      issues.push({ path: ["parameters", key], message: `"${key}" is not a parameter of ${system}; its parameters are: ${valid}` });
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push({ path: ["parameters", key], message: `${key} must be a finite number in ${spec.unit || "plain numbers"}` });
    } else if (value < spec.min || value > spec.max) {
      issues.push({
        path: ["parameters", key],
        message: `${key} must be between ${sig(spec.min)} and ${sig(spec.max)}${spec.unit ? ` ${spec.unit}` : ""} (got ${sig(value)})`,
      });
    } else {
      params[key] = value;
    }
  }
  if (issues.length === 0) {
    for (const v of def.validate?.(params) ?? []) issues.push({ path: v.param ? ["parameters", v.param] : [], message: v.message });
  }
  if (issues.length > 0) return { issues };

  const scales = def.scales(params);
  const dt = scales.dt;
  const durationAuto = duration === undefined;
  let steps: number;
  if (duration === undefined) {
    duration = Math.min(scales.duration, AUTO_STEPS_CAP * dt);
    steps = Math.ceil(duration / dt);
  } else {
    steps = Math.ceil(duration / dt);
    if (steps > MAX_STEPS) {
      return {
        issues: [
          {
            path: ["duration"],
            message:
              `duration ${formatValue(duration, def.timeUnit)} needs about ${sig(steps)} steps at the fixed step of ${formatValue(dt, def.timeUnit)} (limit ${MAX_STEPS}). ` +
              `Use a duration of at most ${formatValue(MAX_STEPS * dt * 0.999, def.timeUnit)}, or omit duration to get ${formatValue(Math.min(scales.duration, AUTO_STEPS_CAP * dt), def.timeUnit)}.`,
          },
        ],
      };
    }
  }
  return { plan: { system, params, duration, durationAuto, dt, steps } };
}

// --- Solving and reading results ---------------------------------------------------

export interface Solved {
  sol: Solution;
  series: Record<string, Float64Array>;
  keyValues: KeyValue[];
}

export function solve(plan: Plan): Solved {
  const def = SYSTEMS[plan.system];
  const sol = integrateRK4({
    f: def.deriv(plan.params),
    y0: def.initial(plan.params),
    dt: plan.dt,
    steps: plan.steps,
    stopBelow: def.stopBelow?.(plan.params),
  });
  const series = def.series(sol, plan.params);
  return { sol, series, keyValues: def.keyValues(sol, series, plan.params) };
}

export interface Checkpoints {
  columns: { name: string; label: string; unit: string }[];
  rows: number[][];
}

/** Evenly spaced samples of the solution (including both ends), for a table the model can quote. */
export function checkpoints(plan: Plan, solved: Solved, count = 9): Checkpoints {
  const def = SYSTEMS[plan.system];
  const columns = [{ name: "t", label: "time", unit: def.timeUnit }, ...def.table.map((c) => ({ name: c.series, label: c.label, unit: c.unit }))];
  const last = solved.sol.t.length - 1;
  const rows: number[][] = [];
  for (let k = 0; k < count; k++) {
    const i = Math.round((k * last) / (count - 1));
    rows.push(columns.map((c) => solved.series[c.name]![i]!));
  }
  return { columns, rows };
}

/** Plain-text report of a run, for clients that cannot show the widget. */
export function summarize(plan: Plan, solved: Solved): string {
  const def = SYSTEMS[plan.system];
  const given = Object.entries(plan.params)
    .map(([k, v]) => `${def.params[k]!.label} = ${formatValue(v, def.params[k]!.unit)}`)
    .join(", ");
  const cp = checkpoints(plan, solved);
  const head = cp.columns.map((c) => `${c.label}${c.unit ? ` (${c.unit})` : ""}`).join(" | ");
  const rows = cp.rows.map((r) => r.map((v) => sig(v)).join(" | "));
  return [
    `${def.label}: ${given}.`,
    `Solved with RK4, fixed step ${formatValue(plan.dt, def.timeUnit)}, ${solved.sol.steps} steps, ${formatValue(solved.sol.t[solved.sol.t.length - 1]!, def.timeUnit)} simulated.`,
    "",
    "Key results:",
    ...solved.keyValues.map((k) => `- ${k.label}: ${formatValue(k.value, k.unit)} (${k.basis === "numerical" ? "from the solution" : "formula"})`),
    "",
    "Sampled solution:",
    head,
    ...rows,
    "",
    DISCLAIMER,
    "Assumptions:",
    ...def.assumptions.map((a) => `- ${a}`),
  ].join("\n");
}
