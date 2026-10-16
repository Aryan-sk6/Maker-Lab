// Input and output schemas for run_simulation. All numeric validation lives in planSimulation
// (shared/systems.ts) so the server and the widget's sliders enforce the same ranges and messages.

import { z } from "zod";
import { MAX_DURATION, MAX_STEPS, SYSTEMS, SYSTEM_IDS, planSimulation, type SystemId } from "./systems.js";
import { sig } from "./format.js";

/** One optional number per distinct parameter name; the description says which systems use it and the limits. */
function parameterShape() {
  const shape: Record<string, z.ZodOptional<z.ZodNumber>> = {};
  for (const id of SYSTEM_IDS) {
    for (const [key, spec] of Object.entries(SYSTEMS[id].params)) {
      const line = `${id}: default ${sig(spec.default)}, ${sig(spec.min)} to ${sig(spec.max)}`;
      const existing = shape[key]?.description;
      shape[key] = z
        .number()
        .optional()
        .describe(existing ? `${existing}; ${line}` : `${spec.label}${spec.unit ? ` [${spec.unit}]` : ""}. ${line}`);
    }
  }
  return shape;
}

export const SimulationInput = z
  .object({
    system: z
      .enum(SYSTEM_IDS as [SystemId, ...SystemId[]], { error: `system must be one of: ${SYSTEM_IDS.join(", ")}` })
      .describe("Which system to simulate."),
    parameters: z
      .looseObject(parameterShape())
      .optional()
      .describe("Parameter values, in the units given in the tool description. Omit any you want at their default."),
    duration: z
      .number()
      .positive("duration must be greater than 0")
      .max(MAX_DURATION, `duration must be at most ${MAX_DURATION}`)
      .optional()
      .describe(
        `Simulated time in the system's time unit (seconds; "time units" for logistic_growth). Omit to choose one that shows the whole behaviour. At most ${MAX_STEPS} fixed RK4 steps are taken.`,
      ),
  })
  .superRefine((input, ctx) => {
    const result = planSimulation(input.system, input.parameters, input.duration);
    if ("issues" in result) for (const issue of result.issues) ctx.addIssue({ code: "custom", ...issue });
  });

export type SimulationInput = z.infer<typeof SimulationInput>;

const Scalar = z.union([z.number(), z.string(), z.null()]);

export const SimulationOutput = z.object({
  system: z.enum(SYSTEM_IDS as [SystemId, ...SystemId[]]),
  label: z.string(),
  /** Full parameter set (defaults filled in). The widget re-solves from these. */
  parameters: z.record(z.string(), z.number()),
  duration: z.number(),
  durationAuto: z.boolean(),
  timeUnit: z.string(),
  timeStep: z.number(),
  steps: z.number(),
  landedEarly: z.boolean().describe("True if the run ended before `duration` because the projectile landed."),
  keyValues: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      value: Scalar,
      unit: z.string(),
      basis: z.enum(["numerical", "formula"]),
    }),
  ),
  checkpoints: z.object({
    columns: z.array(z.object({ name: z.string(), label: z.string(), unit: z.string() })),
    rows: z.array(z.array(z.number())),
  }),
  assumptions: z.array(z.string()),
  disclaimer: z.string(),
});

export type SimulationOutput = z.infer<typeof SimulationOutput>;

/** Table of systems and their parameters for the tool description, generated so it cannot drift from the code. */
export function describeSystems(): string {
  return SYSTEM_IDS.map((id) => {
    const def = SYSTEMS[id];
    const params = Object.entries(def.params)
      .map(([key, p]) => `${key} (${p.unit || "number"}, default ${sig(p.default)})`)
      .join(", ");
    return `- ${id}: ${def.summary} Parameters: ${params}.`;
  }).join("\n");
}
