// Fixed-step classical Runge–Kutta (RK4) integrator and small helpers for reading a solution.
// Every number the simulation tool reports comes from here, never from the model.
//
// RK4 (Kutta, 1901): for y' = f(t, y) and step h,
//   k1 = f(t, y)            k2 = f(t + h/2, y + h/2·k1)
//   k3 = f(t + h/2, y + h/2·k2)   k4 = f(t + h, y + h·k3)
//   y(t + h) = y + h/6 · (k1 + 2·k2 + 2·k3 + k4)
// The global error shrinks like h⁴.

export type Derivative = (t: number, y: Float64Array, dydt: Float64Array) => void;

export interface Solution {
  /** Time of each stored point. */
  t: Float64Array;
  /** y[d][i] is state component d at time t[i]. */
  y: Float64Array[];
  /** Number of steps actually taken (points stored = steps + 1). */
  steps: number;
  /** True if integration ended early because `stopBelow` triggered. */
  stoppedEarly: boolean;
}

export interface IntegrateOptions {
  f: Derivative;
  y0: readonly number[];
  dt: number;
  steps: number;
  /** Stop when state `index` falls below `level`; the last point is placed on the crossing. */
  stopBelow?: { index: number; level: number };
}

export function integrateRK4({ f, y0, dt, steps, stopBelow }: IntegrateOptions): Solution {
  const dim = y0.length;
  const t = new Float64Array(steps + 1);
  const y = Array.from({ length: dim }, () => new Float64Array(steps + 1));
  const state = Float64Array.from(y0);
  const before = new Float64Array(dim);
  const tmp = new Float64Array(dim);
  const k1 = new Float64Array(dim);
  const k2 = new Float64Array(dim);
  const k3 = new Float64Array(dim);
  const k4 = new Float64Array(dim);
  for (let d = 0; d < dim; d++) y[d]![0] = state[d]!;

  /** One RK4 step of size h from `from` (at time ti), written to `to`. `to` may be the same array. */
  const step = (ti: number, from: Float64Array, h: number, to: Float64Array) => {
    f(ti, from, k1);
    for (let d = 0; d < dim; d++) tmp[d] = from[d]! + 0.5 * h * k1[d]!;
    f(ti + h / 2, tmp, k2);
    for (let d = 0; d < dim; d++) tmp[d] = from[d]! + 0.5 * h * k2[d]!;
    f(ti + h / 2, tmp, k3);
    for (let d = 0; d < dim; d++) tmp[d] = from[d]! + h * k3[d]!;
    f(ti + h, tmp, k4);
    for (let d = 0; d < dim; d++) to[d] = from[d]! + (h / 6) * (k1[d]! + 2 * k2[d]! + 2 * k3[d]! + k4[d]!);
  };

  let n = 0;
  let stoppedEarly = false;
  for (let i = 0; i < steps; i++) {
    const ti = i * dt;
    before.set(state);
    step(ti, state, dt, state);

    n = i + 1;
    t[n] = n * dt; // multiply instead of accumulating, so rounding error does not drift
    for (let d = 0; d < dim; d++) y[d]![n] = state[d]!;

    if (stopBelow) {
      const { index, level } = stopBelow;
      const prev = before[index]!;
      const now = state[index]!;
      if (now < level && prev >= level) {
        // The crossing is inside this step. Start from the linear estimate of where, then refine the
        // partial-step length h with Newton's method (using the derivative of the crossing variable)
        // so the final point lands on the level to rounding error.
        let h = (dt * (prev - level)) / (prev - now);
        for (let iter = 0; iter < 5; iter++) {
          step(ti, before, h, state);
          f(ti + h, state, k1);
          const slope = k1[index]!;
          if (slope === 0) break;
          const next = Math.min(dt, Math.max(0, h - (state[index]! - level) / slope));
          if (Math.abs(next - h) < 1e-14 * dt) {
            h = next;
            break;
          }
          h = next;
        }
        step(ti, before, h, state);
        t[n] = ti + h;
        for (let d = 0; d < dim; d++) y[d]![n] = state[d]!;
        y[index]![n] = level; // exact by construction; removes the last rounding residue
        stoppedEarly = true;
        break;
      }
    }
  }
  return { t: t.subarray(0, n + 1), y: y.map((a) => a.subarray(0, n + 1)), steps: n, stoppedEarly };
}

// --- Reading a solution ---------------------------------------------------

/** Times (linearly interpolated) at which y rises through `level`. */
export function upwardCrossings(t: ArrayLike<number>, y: ArrayLike<number>, level = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < y.length; i++) {
    const a = y[i]! - level;
    const b = y[i + 1]! - level;
    if (a < 0 && b >= 0) out.push(t[i]! + ((t[i + 1]! - t[i]!) * -a) / (b - a));
  }
  return out;
}

/** First time y crosses `level` in either direction, or null. */
export function firstCrossing(t: ArrayLike<number>, y: ArrayLike<number>, level: number): number | null {
  for (let i = 0; i + 1 < y.length; i++) {
    const a = y[i]! - level;
    const b = y[i + 1]! - level;
    if (a === 0) return t[i]!;
    if (a * b < 0) return t[i]! + ((t[i + 1]! - t[i]!) * -a) / (b - a);
  }
  return null;
}

/**
 * Time after which |deviation| stays within `fraction` of its largest value.
 * Null if the signal never settles inside the simulated window (or never moves).
 */
export function settlingTime(t: ArrayLike<number>, deviation: ArrayLike<number>, fraction = 0.02): number | null {
  const scale = maxAbs(deviation);
  if (scale === 0) return null;
  const tolerance = fraction * scale;
  let last = -1;
  for (let i = 0; i < deviation.length; i++) if (Math.abs(deviation[i]!) > tolerance) last = i;
  if (last === deviation.length - 1) return null;
  return t[last + 1]!;
}

export function maxOf(a: ArrayLike<number>): number {
  let m = -Infinity;
  for (let i = 0; i < a.length; i++) if (a[i]! > m) m = a[i]!;
  return m;
}

export function maxAbs(a: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]!));
  return m;
}

export function argMax(a: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < a.length; i++) if (a[i]! > a[best]!) best = i;
  return best;
}

/** Arithmetic–geometric mean (Gauss). Used for the exact large-amplitude pendulum period. */
export function agm(a: number, b: number): number {
  for (let i = 0; i < 40 && Math.abs(a - b) > 1e-15 * a; i++) [a, b] = [(a + b) / 2, Math.sqrt(a * b)];
  return a;
}
