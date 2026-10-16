// Sample model shown when the widget is opened on its own (outside an MCP host), for local development.

import type { ModelInput } from "../../shared/model3d.js";

export const DEMO_MODEL: ModelInput = {
  title: "Demo: two-gear reduction on a bracket",
  parts: [
    { name: "base plate", shape: { type: "box", width: 90, depth: 40, height: 4 }, position: [20, 0, -2], rotation: [0, 0, 0], color: "#94a3b8" },
    { name: "upright", shape: { type: "bracket", length: 30, height: 60, width: 40, thickness: 4 }, position: [-25, 0, 2], rotation: [0, 0, 0], color: "#64748b", parent: "base plate", joint: { type: "fixed", axis: "z", angle: 0 } },
    { name: "drive shaft", shape: { type: "cylinder", diameter: 6, height: 30 }, position: [2, 0, 50], rotation: [0, 90, 0], color: "#cbd5e1", parent: "upright", joint: { type: "rotating", axis: "z", angle: 0 } },
    { name: "drive gear", shape: { type: "gear", teeth: 20, module: 2, thickness: 6, bore: 6 }, position: [0, 0, -12], rotation: [0, 0, 0], color: "#3b82f6", parent: "drive shaft", joint: { type: "fixed", axis: "z", angle: 0 } },
    { name: "output shaft", shape: { type: "cylinder", diameter: 6, height: 30 }, position: [2, 0, 18], rotation: [0, 90, 0], color: "#cbd5e1", parent: "upright", joint: { type: "rotating", axis: "z", angle: 0 } },
    { name: "output gear", shape: { type: "gear", teeth: 12, module: 2, thickness: 6, bore: 6 }, position: [0, 0, -12], rotation: [0, 0, 0], color: "#f59e0b", parent: "output shaft", joint: { type: "fixed", axis: "z", angle: 0 } },
    { name: "knob", shape: { type: "cone", baseDiameter: 16, topDiameter: 10, height: 8 }, position: [0, 0, 19], rotation: [0, 0, 0], color: "#ef4444", parent: "drive shaft", joint: { type: "fixed", axis: "z", angle: 0 } },
  ],
};
