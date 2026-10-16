// 2D outline of an involute spur gear, written from the textbook definitions:
//   pitch radius   r  = m·z/2
//   base radius    rb = r·cos(α)            (α = pressure angle, 20°)
//   addendum       ra = r + m
//   dedendum       rf = r − 1.25·m
//   involute function inv(φ) = tan(φ) − φ
// At radius ρ on the flank, the tooth's angular half-thickness is
//   π/(2z) + inv(α) − inv(acos(rb/ρ)).
// Below the base circle the flank is continued radially (no undercut or root fillet),
// which is why the result is approximate.

export const PRESSURE_ANGLE = (20 * Math.PI) / 180;

export interface GearRadii {
  pitch: number;
  base: number;
  tip: number;
  root: number;
}

export function gearRadii(teeth: number, module: number): GearRadii {
  const pitch = (module * teeth) / 2;
  return {
    pitch,
    base: pitch * Math.cos(PRESSURE_ANGLE),
    tip: pitch + module,
    root: Math.max(pitch - 1.25 * module, module * 0.5),
  };
}

const inv = (phi: number) => Math.tan(phi) - phi;

/** Closed outline as [x, y] points, counter-clockwise, centred on the origin. */
export function gearOutline(teeth: number, module: number, flankSteps = 8): [number, number][] {
  const { base, tip, root } = gearRadii(teeth, module);
  const halfAtPitch = Math.PI / (2 * teeth) + inv(PRESSURE_ANGLE);
  const half = (rho: number) => Math.max(0, halfAtPitch - inv(Math.acos(Math.min(1, base / rho))));
  const start = Math.max(base, root);
  const pitchAngle = (2 * Math.PI) / teeth;
  const polar = (rho: number, theta: number): [number, number] => [rho * Math.cos(theta), rho * Math.sin(theta)];

  const flank: number[] = [];
  for (let k = 0; k <= flankSteps; k++) flank.push(start + ((tip - start) * k) / flankSteps);

  const points: [number, number][] = [];
  for (let i = 0; i < teeth; i++) {
    const c = i * pitchAngle;
    if (root < base) points.push(polar(root, c - half(base)));
    for (const rho of flank) points.push(polar(rho, c - half(rho)));
    points.push(polar(tip, c)); // tip land midpoint
    for (const rho of [...flank].reverse()) points.push(polar(rho, c + half(rho)));
    if (root < base) points.push(polar(root, c + half(base)));

    // Root arc to the next tooth.
    const from = c + half(start);
    const to = c + pitchAngle - half(start);
    for (let k = 1; k < 4; k++) points.push(polar(root, from + ((to - from) * k) / 4));
  }
  return points;
}
