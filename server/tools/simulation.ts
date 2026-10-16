// Tool 2: run_simulation. The server solves the system with RK4 and returns the numbers;
// the widget re-solves with the same code when the user drags a slider.

import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { SimulationInput, SimulationOutput, describeSystems } from "../../shared/simulation.js";
import { DISCLAIMER, MAX_STEPS, SYSTEMS, checkpoints, planSimulation, solve, summarize } from "../../shared/systems.js";
import { loadWidget } from "../widgets.js";

export const SIMULATION_URI = "ui://maker-lab/simulation-v1.html";

const DESCRIPTION = `Run an educational physics or maths simulation and show it as an interactive plot with sliders.

Use this when the user wants to see how a simple dynamical system behaves, compare cases, or understand a quantity such as a period, range, time constant, damping or growth curve. Do not use it for anything that needs a validated engineering or scientific result.

The numbers come from a real numerical solver (classical fourth-order Runge–Kutta with a fixed small step, at most ${MAX_STEPS} steps), not from you. Quote the key results and sampled values in the tool result; never invent or estimate values yourself. If the user wants to change a parameter, call the tool again, or tell them to use the sliders in the widget.

Systems (pass the names below as "system" and, optionally, "parameters" with the units shown):
${describeSystems()}

Omit "duration" unless the user cares about a specific time window; the default shows the whole behaviour. A projectile run always ends when it lands. Parameters you leave out take the defaults shown.

This is a simplified model: each system's assumptions are listed in the result and under the plot. Never present the output as accurate, safe or suitable for engineering, medical or safety-critical use.`;

export function registerSimulation(server: McpServer): void {
  registerAppResource(
    server,
    "Maker Lab simulation sandbox",
    SIMULATION_URI,
    { description: "Interactive plot and sliders for run_simulation results.", mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: SIMULATION_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: loadWidget("simulation"),
          _meta: {
            // The solver is bundled into the widget and runs locally: no network access is needed.
            ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
          },
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "run_simulation",
    {
      title: "Run simulation",
      description: DESCRIPTION,
      inputSchema: SimulationInput,
      outputSchema: SimulationOutput,
      annotations: {
        title: "Run simulation",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: SIMULATION_URI } },
    },
    async (input) => {
      const planned = planSimulation(input.system, input.parameters, input.duration);
      if ("issues" in planned) throw new Error(planned.issues.map((i) => i.message).join("; ")); // unreachable: the schema already checked
      const { plan } = planned;
      const solved = solve(plan);
      return {
        content: [{ type: "text", text: summarize(plan, solved) }],
        structuredContent: {
          system: plan.system,
          label: SYSTEMS[plan.system].label,
          parameters: plan.params,
          duration: plan.duration,
          durationAuto: plan.durationAuto,
          timeUnit: SYSTEMS[plan.system].timeUnit,
          timeStep: plan.dt,
          steps: solved.sol.steps,
          landedEarly: solved.sol.stoppedEarly,
          keyValues: solved.keyValues.map((k) => ({ ...k, value: typeof k.value === "number" && !Number.isFinite(k.value) ? null : k.value })),
          checkpoints: checkpoints(plan, solved),
          assumptions: SYSTEMS[plan.system].assumptions,
          disclaimer: DISCLAIMER,
        },
      };
    },
  );
}
