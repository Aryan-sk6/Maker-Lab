import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { gearOutline, gearRadii } from "./gear.js";
import { buildGeometry } from "./geometry.js";

const size = (g: THREE.BufferGeometry) => {
  g.computeBoundingBox();
  return g.boundingBox!.getSize(new THREE.Vector3());
};

describe("gear outline", () => {
  it.each([6, 12, 20, 41, 42, 200])("stays between root and tip radius for %i teeth", (teeth) => {
    const m = 2;
    const { tip, root } = gearRadii(teeth, m);
    const radii = gearOutline(teeth, m).map(([x, y]) => Math.hypot(x, y));
    expect(Math.min(...radii)).toBeCloseTo(root, 6);
    expect(Math.max(...radii)).toBeCloseTo(tip, 6);
  });

  it("has the textbook pitch and outside diameters", () => {
    const r = gearRadii(20, 2);
    expect(r.pitch * 2).toBe(40);
    expect(r.tip * 2).toBe(44);
    expect(r.root * 2).toBe(35);
  });

  it("goes counter-clockwise without doubling back", () => {
    const angles = gearOutline(20, 1).map(([x, y]) => Math.atan2(y, x));
    let unwrapped = 0;
    for (let i = 1; i < angles.length; i++) {
      let step = angles[i]! - angles[i - 1]!;
      if (step < -Math.PI) step += 2 * Math.PI;
      expect(step).toBeGreaterThanOrEqual(-1e-9);
      unwrapped += step;
    }
    expect(unwrapped).toBeLessThan(2 * Math.PI);
    expect(unwrapped).toBeGreaterThan(2 * Math.PI * 0.95);
  });
});

describe("primitive geometry (Z-up, mm)", () => {
  it("puts cylinder and cone axes on Z", () => {
    expect(size(buildGeometry({ type: "cylinder", diameter: 10, height: 30 }))).toMatchObject({ z: 30 });
    const cone = size(buildGeometry({ type: "cone", baseDiameter: 20, height: 15 }));
    expect(cone.z).toBeCloseTo(15);
    expect(cone.x).toBeCloseTo(20);
  });

  it("sizes the box as width × depth × height", () => {
    expect(size(buildGeometry({ type: "box", width: 1, depth: 2, height: 3 }))).toEqual(new THREE.Vector3(1, 2, 3));
  });

  it("builds a gear centred on its thickness with the outside diameter", () => {
    const g = buildGeometry({ type: "gear", teeth: 20, module: 2, thickness: 6, bore: 5 });
    const s = size(g);
    expect(s.z).toBeCloseTo(6);
    expect(s.x).toBeCloseTo(44, 0);
    expect(g.boundingBox!.min.z).toBeCloseTo(-3);
  });

  it("builds the bracket with its corner at the origin, legs along +X and +Z", () => {
    const g = buildGeometry({ type: "bracket", length: 30, height: 60, width: 40, thickness: 4 });
    g.computeBoundingBox();
    const { min, max } = g.boundingBox!;
    expect([min.x, min.y, min.z]).toEqual([0, -20, 0].map((v) => expect.closeTo(v)));
    expect([max.x, max.y, max.z]).toEqual([30, 20, 60].map((v) => expect.closeTo(v)));
  });

  it("exports a binary STL whose coordinates are in mm", () => {
    const mesh = new THREE.Mesh(buildGeometry({ type: "box", width: 10, depth: 20, height: 30 }));
    const view = new STLExporter().parse(mesh, { binary: true }) as DataView;
    const triangles = view.getUint32(80, true);
    expect(triangles).toBe(12);
    expect(view.byteLength).toBe(84 + 50 * triangles);
    // First vertex of the first triangle: every coordinate is ±half a dimension.
    const xs = [0, 1, 2].map((i) => Math.abs(view.getFloat32(84 + 12 + i * 4, true)));
    expect(xs).toEqual([5, 10, 15]);
  });
});
