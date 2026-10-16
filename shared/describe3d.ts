// Human-readable part descriptions. Kept free of zod so the widget bundle stays small.

import type { ShapeInput } from "./model3d.js";

export function describeShape(s: ShapeInput): string {
  switch (s.type) {
    case "box":
      return `box ${s.width}×${s.depth}×${s.height} mm`;
    case "cylinder":
      return `cylinder ⌀${s.diameter}×${s.height} mm`;
    case "sphere":
      return `sphere ⌀${s.diameter} mm`;
    case "cone":
      return `cone ⌀${s.baseDiameter}${s.topDiameter ? `→⌀${s.topDiameter}` : ""}×${s.height} mm`;
    case "gear":
      return `gear ${s.teeth}T m${s.module}, ⌀${round(s.module * (s.teeth + 2))} mm outside, ${s.thickness} mm thick${s.bore ? `, ⌀${s.bore} bore` : ""}`;
    case "bracket":
      return `bracket ${s.length}×${s.height} mm, ${s.width} mm wide, ${s.thickness} mm thick`;
  }
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}
