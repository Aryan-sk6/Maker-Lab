// Turns a validated shape description into a Three.js geometry in a Z-up frame (units: mm).

import * as THREE from "three";
import type { ShapeInput } from "../../shared/model3d.js";
import { gearOutline } from "./gear.js";

const SEGMENTS = 48;
// Three.js primitives use a Y axis; this turns Y into Z (y → z, z → −y).
const Y_TO_Z = new THREE.Matrix4().makeRotationX(Math.PI / 2);

export function buildGeometry(shape: ShapeInput): THREE.BufferGeometry {
  switch (shape.type) {
    case "box":
      return new THREE.BoxGeometry(shape.width, shape.depth, shape.height);

    case "cylinder":
      return new THREE.CylinderGeometry(shape.diameter / 2, shape.diameter / 2, shape.height, SEGMENTS).applyMatrix4(Y_TO_Z);

    case "sphere":
      return new THREE.SphereGeometry(shape.diameter / 2, SEGMENTS, SEGMENTS / 2);

    case "cone":
      return new THREE.CylinderGeometry((shape.topDiameter ?? 0) / 2, shape.baseDiameter / 2, shape.height, SEGMENTS).applyMatrix4(Y_TO_Z);

    case "gear": {
      const outline = gearOutline(shape.teeth, shape.module).map(([x, y]) => new THREE.Vector2(x, y));
      const profile = new THREE.Shape(outline);
      if (shape.bore) {
        const hole = new THREE.Path();
        hole.absarc(0, 0, shape.bore / 2, 0, Math.PI * 2, true);
        profile.holes.push(hole);
      }
      return new THREE.ExtrudeGeometry(profile, { depth: shape.thickness, bevelEnabled: false, curveSegments: 32 }).translate(
        0,
        0,
        -shape.thickness / 2,
      );
    }

    case "bracket": {
      const { length, height, width, thickness: t } = shape;
      // L profile drawn in X (length) / Y (height), extruded by `width`, then stood up so Y becomes Z.
      const profile = new THREE.Shape([
        new THREE.Vector2(0, 0),
        new THREE.Vector2(length, 0),
        new THREE.Vector2(length, t),
        new THREE.Vector2(t, t),
        new THREE.Vector2(t, height),
        new THREE.Vector2(0, height),
      ]);
      return new THREE.ExtrudeGeometry(profile, { depth: width, bevelEnabled: false })
        .applyMatrix4(Y_TO_Z)
        .translate(0, width / 2, 0);
    }
  }
}
