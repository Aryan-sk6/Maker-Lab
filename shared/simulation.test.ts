import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SimulationInput } from "./simulation.js";

/** Error messages with their paths, or [] if the input is valid. */
function errors(input: unknown): string[] {
  const result = SimulationInput.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("run_simulation input validation", () => {
  it("accepts a system on its own and with parameters and duration", () => {
    expect(errors({ system: "pendulum" })).toEqual([]);
    expect(errors({ system: "rlc_circuit", parameters: { resistance_ohm: 0, inductance_H: 0.01 }, duration: 0.01 })).toEqual([]);
  });

  it("names the valid systems when the system is unknown", () => {
    const [message] = errors({ system: "double_pendulum" });
    expect(message).toContain("pendulum, projectile, mass_spring_damper, rc_circuit, rlc_circuit, logistic_growth");
  });

  it("rejects a parameter that belongs to another system and lists the right ones", () => {
    const [message] = errors({ system: "rc_circuit", parameters: { mass_kg: 2 } });
    expect(message).toBe(
      'parameters.mass_kg: "mass_kg" is not a parameter of rc_circuit; its parameters are: voltage_V, resistance_ohm, capacitance_F, vc0_V',
    );
  });

  it("rejects values outside the range, naming the range and unit", () => {
    expect(errors({ system: "pendulum", parameters: { theta0_deg: 200 } })[0]).toContain("between -179 and 179 ° (got 200)");
    expect(errors({ system: "logistic_growth", parameters: { population0: 0 } })[0]).toContain("population0 must be between");
  });

  it("rejects non-numeric values", () => {
    expect(errors({ system: "pendulum", parameters: { length_m: "long" } })[0]).toContain("expected number");
  });

  it("rejects a non-positive or enormous duration", () => {
    expect(errors({ system: "pendulum", duration: 0 })[0]).toContain("greater than 0");
    expect(errors({ system: "pendulum", duration: 2e6 })[0]).toContain("at most 1000000");
  });

  it("rejects a duration that would need too many steps and suggests one that works", () => {
    const [message] = errors({ system: "pendulum", duration: 600 });
    expect(message).toMatch(/^duration: duration 600 s needs about \d+ steps/);
    expect(message).toMatch(/at most [\d.]+ s, or omit duration/);
  });

  it("reports every problem at once", () => {
    const issues = errors({ system: "pendulum", parameters: { length_m: -1, gravity_ms2: 99, nope: 1 } });
    expect(issues).toHaveLength(3);
  });

  it("describes every parameter with its units and the systems that use it", () => {
    // The same conversion the MCP SDK performs when listing tools.
    const json = JSON.stringify(z.toJSONSchema(SimulationInput, { io: "input" }));
    expect(json).toContain("Rod length L [m]");
    expect(json).toContain("pendulum: default 9.81");
    expect(json).toContain("projectile: default 9.81");
  });
});
