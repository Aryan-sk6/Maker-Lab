// Sample mechanism shown when the widget is opened on its own (outside an MCP host), and used as the /dev example.
// Note how little it says: no positions, no joints, no colours. The layout works all of that out.

export const DEMO_MODEL = {
  title: "Demo: gear train, belt and rack",
  parts: [
    { name: "motor gear", shape: { type: "gear", teeth: 12 } },
    { name: "big gear", shape: { type: "gear", teeth: 36 } },
    { name: "small gear", shape: { type: "gear", teeth: 12 } },
    { name: "output gear", shape: { type: "gear", teeth: 30 } },
    { name: "small pulley", shape: { type: "pulley", diameter: 30 } },
    { name: "big pulley", shape: { type: "pulley", diameter: 60 } },
    { name: "pinion", shape: { type: "gear", teeth: 16 } },
    { name: "rack", shape: { type: "rack", length: 200 } },
  ],
  links: [
    { type: "mesh", a: "motor gear", b: "big gear" },
    { type: "axle", a: "big gear", b: "small gear" },
    { type: "mesh", a: "small gear", b: "output gear" },
    { type: "axle", a: "output gear", b: "small pulley" },
    { type: "belt", a: "small pulley", b: "big pulley" },
    { type: "axle", a: "big pulley", b: "pinion" },
    { type: "rack", pinion: "pinion", rack: "rack" },
  ],
  driver: { part: "motor gear", rpm: 60 },
};
