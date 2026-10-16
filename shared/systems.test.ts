// The solver is checked against closed-form solutions: if these pass, the numbers it reports can be trusted
// for the models and step sizes used by the tool.

import { describe, expect, it } from "vitest";
import { agm, integrateRK4, settlingTime, upwardCrossings } from "./solver.js";
import { MAX_STEPS, SYSTEMS, checkpoints, planSimulation, solve, summarize, type Params, type SystemId } from "./systems.js";

function run(system: SystemId, params: Params = {}, duration?: number) {
  const result = planSimulation(system, params, duration);
  if (!("plan" in result)) throw new Error(result.issues.map((i) => i.message).join("; "));
  return { plan: result.plan, ...solve(result.plan) };
}

const value = (r: ReturnType<typeof run>, key: string) => r.keyValues.find((k) => k.key === key)?.value;

/** Largest |numeric − exact| over all stored points. */
function maxError(t: Float64Array, numeric: Float64Array, exact: (t: number) => number) {
  let worst = 0;
  for (let i = 0; i < t.length; i++) worst = Math.max(worst, Math.abs(numeric[i]! - exact(t[i]!)));
  return worst;
}

describe("RK4 core", () => {
  it("is fourth-order accurate: halving the step cuts the error ~16×", () => {
    const f = (_t: number, y: Float64Array, dy: Float64Array) => void (dy[0] = y[0]!); // y' = y, y(1) = e
    const err = (steps: number) => Math.abs(integrateRK4({ f, y0: [1], dt: 1 / steps, steps }).y[0]![steps]! - Math.E);
    const ratio = err(20) / err(40);
    expect(ratio).toBeGreaterThan(14);
    expect(ratio).toBeLessThan(18);
  });

  it("computes the arithmetic–geometric mean (agm(1, √2/2) = 0.847213…)", () => {
    expect(agm(1, Math.SQRT1_2)).toBeCloseTo(0.8472130847939792, 14);
  });
});

describe("pendulum", () => {
  it("matches θ₀·cos(ωt) for a small swing", () => {
    const r = run("pendulum", { theta0_deg: 0.5, length_m: 1, gravity_ms2: 9.81 });
    const w = Math.sqrt(9.81);
    expect(maxError(r.series.t!, r.series.theta_deg!, (t) => 0.5 * Math.cos(w * t))).toBeLessThan(5e-4); // 0.1% of amplitude
  });

  it("measures the small-angle period 2π√(L/g)", () => {
    const r = run("pendulum", { theta0_deg: 1, length_m: 2.5, gravity_ms2: 9.81 });
    const exact = 2 * Math.PI * Math.sqrt(2.5 / 9.81);
    expect(value(r, "period_measured") as number).toBeCloseTo(exact, 3);
    expect(value(r, "period_small")).toBeCloseTo(exact, 12);
  });

  it("matches the exact large-amplitude period (elliptic integral via AGM)", () => {
    const r = run("pendulum", { theta0_deg: 90, length_m: 1, gravity_ms2: 9.81 });
    const exact = value(r, "period_exact") as number;
    expect(exact / (2 * Math.PI * Math.sqrt(1 / 9.81))).toBeCloseTo(1.18034, 4); // known factor for 90°
    expect(Math.abs((value(r, "period_measured") as number) - exact) / exact).toBeLessThan(1e-4);
  });

  it("matches the damped small-angle solution", () => {
    const b = 0.4;
    const r = run("pendulum", { theta0_deg: 0.5, damping_per_s: b });
    const wd = Math.sqrt(9.81 - (b / 2) ** 2);
    const exact = (t: number) => 0.5 * Math.exp((-b * t) / 2) * (Math.cos(wd * t) + ((b / 2 / wd) * Math.sin(wd * t)));
    expect(maxError(r.series.t!, r.series.theta_deg!, exact)).toBeLessThan(5e-4);
  });

  it("conserves energy without damping", () => {
    const r = run("pendulum", { theta0_deg: 120 });
    const energy = (i: number) => 0.5 * r.series.omega![i]! ** 2 + 9.81 * (1 - Math.cos((r.series.theta_deg![i]! * Math.PI) / 180));
    const e0 = energy(0);
    for (let i = 0; i < r.series.t!.length; i += 97) expect(Math.abs(energy(i) - e0) / e0).toBeLessThan(1e-6);
  });
});

describe("projectile", () => {
  it("matches the drag-free range v²·sin(2θ)/g", () => {
    const r = run("projectile", { speed_ms: 30, angle_deg: 40, gravity_ms2: 9.81 });
    const range = (30 * 30 * Math.sin((80 * Math.PI) / 180)) / 9.81;
    expect(Math.abs((value(r, "range") as number) - range) / range).toBeLessThan(1e-5);
    expect(value(r, "max_height")).toBeCloseTo((30 * Math.sin((40 * Math.PI) / 180)) ** 2 / (2 * 9.81), 4);
  });

  it("matches the closed-form solution with linear drag", () => {
    const k = 0.3;
    const g = 9.81;
    const r = run("projectile", { speed_ms: 40, angle_deg: 55, height0_m: 5, drag_per_s: k });
    const vx0 = 40 * Math.cos((55 * Math.PI) / 180);
    const vy0 = 40 * Math.sin((55 * Math.PI) / 180);
    const x = (t: number) => (vx0 * (1 - Math.exp(-k * t))) / k;
    const y = (t: number) => 5 + ((vy0 + g / k) * (1 - Math.exp(-k * t))) / k - (g * t) / k;
    expect(maxError(r.series.t!, r.series.x!, x)).toBeLessThan(1e-6);
    expect(maxError(r.series.t!, r.series.y!, y)).toBeLessThan(1e-6);
  });

  it("stops at the ground and drag shortens the range", () => {
    const free = run("projectile", { speed_ms: 30, angle_deg: 45 });
    const draggy = run("projectile", { speed_ms: 30, angle_deg: 45, drag_per_s: 0.5 });
    expect(free.sol.stoppedEarly && draggy.sol.stoppedEarly).toBe(true);
    expect(draggy.series.y![draggy.series.y!.length - 1]).toBeCloseTo(0, 9);
    expect(value(draggy, "range") as number).toBeLessThan(value(free, "range") as number);
    expect(value(draggy, "range_no_drag")).toBeCloseTo(value(free, "range") as number, 2);
  });
});

describe("mass–spring–damper", () => {
  const exactFor = (m: number, c: number, k: number, x0: number, v0: number) => {
    const a = c / (2 * m);
    const w2 = k / m;
    if (a * a < w2 - 1e-9) {
      const wd = Math.sqrt(w2 - a * a);
      return (t: number) => Math.exp(-a * t) * (x0 * Math.cos(wd * t) + ((v0 + a * x0) / wd) * Math.sin(wd * t));
    }
    if (Math.abs(a * a - w2) <= 1e-9) return (t: number) => Math.exp(-a * t) * (x0 + (v0 + a * x0) * t);
    const beta = Math.sqrt(a * a - w2);
    const s1 = -a + beta;
    const s2 = -a - beta;
    const A = (v0 - s2 * x0) / (s1 - s2);
    return (t: number) => A * Math.exp(s1 * t) + (x0 - A) * Math.exp(s2 * t);
  };

  it.each([
    ["underdamped", 2, 1.2, 50],
    ["critically damped", 2, 2 * Math.sqrt(2 * 50), 50],
    ["overdamped", 2, 40, 50],
    ["undamped", 2, 0, 50],
  ])("matches the %s closed form", (regime, m, c, k) => {
    const r = run("mass_spring_damper", { mass_kg: m, damping_Nspm: c, stiffness_Npm: k, x0_m: 0.2, v0_ms: 0.7 });
    expect(value(r, "regime")).toBe(regime);
    expect(maxError(r.series.t!, r.series.x!, exactFor(m, c, k, 0.2, 0.7))).toBeLessThan(1e-5);
  });

  it("reports ω_n, ζ and a settling time that really is settled", () => {
    const r = run("mass_spring_damper", { mass_kg: 1, stiffness_Npm: 100, damping_Nspm: 2 });
    expect(value(r, "omega_n")).toBeCloseTo(10, 12);
    expect(value(r, "zeta")).toBeCloseTo(0.1, 12);
    const settle = value(r, "settle") as number;
    const peak = Math.max(...r.series.x!.map(Math.abs));
    for (let i = 0; i < r.series.t!.length; i++) if (r.series.t![i]! > settle) expect(Math.abs(r.series.x![i]!)).toBeLessThanOrEqual(0.02 * peak);
  });
});

describe("RC circuit", () => {
  it("matches V_s + (V₀ − V_s)·e^(−t/RC)", () => {
    const r = run("rc_circuit", { voltage_V: 5, resistance_ohm: 4700, capacitance_F: 2.2e-6, vc0_V: 1 });
    const tau = 4700 * 2.2e-6;
    expect(maxError(r.series.t!, r.series.vc!, (t) => 5 - 4 * Math.exp(-t / tau))).toBeLessThan(1e-9);
  });

  it("measures τ = RC at 63.2% and the 2% settling time ≈ 3.9τ", () => {
    const r = run("rc_circuit", { voltage_V: 5, resistance_ohm: 1000, capacitance_F: 1e-6 });
    expect(Math.abs((value(r, "t63") as number) / 1e-3 - 1)).toBeLessThan(1e-4);
    expect((value(r, "settle") as number) / 1e-3).toBeCloseTo(-Math.log(0.02), 1);
    expect(value(r, "i0")).toBeCloseTo(5e-3, 12);
  });
});

describe("RLC circuit", () => {
  it("matches the underdamped step response", () => {
    const [R, L, C, Vs] = [10, 1e-3, 1e-6, 5];
    const r = run("rlc_circuit", { resistance_ohm: R, inductance_H: L, capacitance_F: C, voltage_V: Vs });
    const a = R / (2 * L);
    const wd = Math.sqrt(1 / (L * C) - a * a);
    const exact = (t: number) => Vs * (1 - Math.exp(-a * t) * (Math.cos(wd * t) + (a / wd) * Math.sin(wd * t)));
    expect(maxError(r.series.t!, r.series.vc!, exact)).toBeLessThan(1e-6);
    // Overshoot of a second-order step response: exp(−πζ/√(1−ζ²)).
    const zeta = value(r, "zeta") as number;
    const overshoot = Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta)) * 100;
    expect(Math.abs((value(r, "overshoot") as number) - overshoot)).toBeLessThan(0.01);
  });

  it("matches the overdamped step response", () => {
    const [R, L, C, Vs] = [500, 1e-3, 1e-6, 3];
    const r = run("rlc_circuit", { resistance_ohm: R, inductance_H: L, capacitance_F: C, voltage_V: Vs });
    expect(value(r, "regime")).toBe("overdamped");
    const a = R / (2 * L);
    const b = Math.sqrt(a * a - 1 / (L * C));
    const [s1, s2] = [-a + b, -a - b];
    const exact = (t: number) => Vs * (1 - (s2 * Math.exp(s1 * t) - s1 * Math.exp(s2 * t)) / (s2 - s1));
    expect(maxError(r.series.t!, r.series.vc!, exact)).toBeLessThan(1e-6);
    expect(value(r, "overshoot")).toBe(0);
  });
});

describe("logistic growth", () => {
  it("matches N(t) = K / (1 + ((K−N₀)/N₀)·e^(−rt))", () => {
    const [r0, K, N0] = [0.8, 5000, 25];
    const r = run("logistic_growth", { growth_rate: r0, capacity: K, population0: N0 });
    const exact = (t: number) => K / (1 + ((K - N0) / N0) * Math.exp(-r0 * t));
    expect(maxError(r.series.t!, r.series.n!, (t) => exact(t) )).toBeLessThan(5000 * 1e-8);
    expect(value(r, "t_half") as number).toBeCloseTo(value(r, "t_half_formula") as number, 3);
  });

  it("decays towards K when it starts above capacity", () => {
    const r = run("logistic_growth", { growth_rate: 1, capacity: 100, population0: 400 });
    expect(r.series.n![r.series.n!.length - 1]).toBeCloseTo(100, -0.5);
    expect(value(r, "t_half")).toBeNull();
  });
});

describe("planning and limits", () => {
  it("fills in defaults and chooses a fixed step with a bounded number of steps", () => {
    for (const id of Object.keys(SYSTEMS) as SystemId[]) {
      const { plan, sol } = run(id);
      expect(plan.durationAuto).toBe(true);
      expect(plan.steps).toBeGreaterThan(100);
      expect(plan.steps).toBeLessThanOrEqual(MAX_STEPS);
      expect(sol.steps).toBeLessThanOrEqual(plan.steps);
      expect(Object.values(solve(plan).series).every((a) => Array.from(a).every(Number.isFinite))).toBe(true);
    }
  });

  it("rejects an unknown parameter and lists the valid ones", () => {
    const result = planSimulation("rc_circuit", { length_m: 1 });
    expect("issues" in result && result.issues[0]!.message).toContain("voltage_V, resistance_ohm, capacitance_F, vc0_V");
  });

  it("rejects out-of-range values with the range", () => {
    const result = planSimulation("pendulum", { length_m: 0 });
    expect("issues" in result && result.issues[0]!.message).toContain("between 0.01 and 100 m");
  });

  it("caps the number of steps and says what duration would work", () => {
    const result = planSimulation("rc_circuit", { resistance_ohm: 1, capacitance_F: 1e-6 }, 1000);
    expect("issues" in result).toBe(true);
    if ("issues" in result) {
      expect(result.issues[0]!.path).toEqual(["duration"]);
      expect(result.issues[0]!.message).toMatch(/limit 100000.*at most [\d.]+ [µmn]?s, or omit duration/);
    }
  });

  it("rejects a projectile that is already on the ground", () => {
    const result = planSimulation("projectile", { angle_deg: -10 });
    expect("issues" in result && result.issues[0]!.message).toContain("lands immediately");
  });

  it("produces checkpoints and a text report", () => {
    const r = run("pendulum");
    const cp = checkpoints(r.plan, r);
    expect(cp.rows).toHaveLength(9);
    expect(cp.rows[0]![0]).toBe(0);
    const text = summarize(r.plan, r);
    expect(text).toContain("Educational model with simplifying assumptions.");
    expect(text).toContain("Small-angle period");
  });
});

describe("solution readers", () => {
  it("finds upward zero crossings with interpolation", () => {
    const t = Float64Array.from([0, 1, 2, 3]);
    expect(upwardCrossings(t, Float64Array.from([-1, 1, -1, 3]), 0)).toEqual([0.5, 2.25]);
  });

  it("returns null settling time when the signal is still moving at the end", () => {
    const t = Float64Array.from([0, 1, 2, 3]);
    expect(settlingTime(t, Float64Array.from([1, 0.5, 0.2, 0.1]), 0.02)).toBeNull();
    expect(settlingTime(t, Float64Array.from([1, 0.5, 0.001, 0]), 0.02)).toBe(2);
  });
});
