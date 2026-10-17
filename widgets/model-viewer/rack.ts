// 2D outline of a gear rack: straight-sided teeth with the same 20° pressure angle as the gears.
// Pitch line at y = 0, teeth pointing +Y (addendum = module, dedendum = 1.25 × module), base at y = −height.

import { rackLayout } from "../../shared/kinematics.js";
import { PRESSURE_ANGLE } from "./gear.js";

/** Closed outline as [x, y] points, counter-clockwise. */
export function rackOutline(s: { length: number; module: number; height: number }): [number, number][] {
  const { pitch, teeth, length, firstToothX } = rackLayout(s);
  const m = s.module;
  const tan = Math.tan(PRESSURE_ANGLE);
  const tip = pitch / 4 - m * tan; // half-width of a tooth at its tip (y = +m)
  const root = pitch / 4 + 1.25 * m * tan; // half-width at the root (y = −1.25m)
  const points: [number, number][] = [
    [-length / 2, -s.height],
    [length / 2, -s.height],
    [length / 2, -1.25 * m],
  ];
  for (let k = teeth - 1; k >= 0; k--) {
    const cx = firstToothX + k * pitch;
    points.push([cx + root, -1.25 * m], [cx + tip, m], [cx - tip, m], [cx - root, -1.25 * m]);
  }
  points.push([-length / 2, -1.25 * m]);
  return points;
}
