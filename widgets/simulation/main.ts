// Maker Lab simulation widget. The tool result tells it which system and parameters to show;
// from then on every slider change re-runs the same RK4 solver the server used, locally and instantly.

import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import type { SimulationOutput } from "../../shared/simulation.js";
import { formatValue, sig } from "../../shared/format.js";
import { MAX_STEPS, SYSTEMS, defaultParams, planSimulation, solve, type ParamSpec, type Params, type Plan, type Solved, type SystemId } from "../../shared/systems.js";
import { drawPlot, nearestIndex, type PlotSpec, type PlotTheme } from "./plot.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  title: $<HTMLHeadingElement>("title"),
  solverNote: $<HTMLSpanElement>("solver-note"),
  views: $<HTMLDivElement>("views"),
  plot: $<HTMLCanvasElement>("plot"),
  plotWrap: $<HTMLDivElement>("plotwrap"),
  rig: $<HTMLCanvasElement>("rig"),
  transport: $<HTMLDivElement>("transport"),
  play: $<HTMLButtonElement>("play"),
  time: $<HTMLInputElement>("time"),
  timeValue: $<HTMLOutputElement>("time-value"),
  speed: $<HTMLSelectElement>("speed"),
  params: $<HTMLDivElement>("params"),
  reset: $<HTMLButtonElement>("reset"),
  kv: $<HTMLDListElement>("kv"),
  resultsNote: $<HTMLSpanElement>("results-note"),
  assumptions: $<HTMLUListElement>("assumptions"),
  status: $<HTMLParagraphElement>("status"),
};

// --- State -----------------------------------------------------------------

let system: SystemId = "pendulum";
let params: Params = defaultParams(system);
/** Duration as a multiple of the automatically chosen one (1 = automatic). */
let durationFactor = 1;
let toolParams: Params = { ...params };
let toolFactor = 1;
let viewId = SYSTEMS[system].views[0]!.id;
let plan: Plan | undefined;
let solved: Solved | undefined;
let cursorTime = 0;
let playing = false;
let hoverIndex: number | undefined;

const def = () => SYSTEMS[system];
const tEnd = () => (solved ? solved.sol.t[solved.sol.t.length - 1]! : 0);

function setStatus(text: string, isError = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle("error", isError);
}

// --- Slider mapping ----------------------------------------------------------

const SLIDER_STEPS = 1000;

function toPos(spec: ParamSpec, v: number): number {
  const t =
    spec.scale === "log"
      ? Math.log(v / spec.min) / Math.log(spec.max / spec.min)
      : spec.scale === "log0"
        ? Math.log10(1 + v / spec.ref!) / Math.log10(1 + spec.max / spec.ref!)
        : (v - spec.min) / (spec.max - spec.min);
  return Math.round(Math.min(1, Math.max(0, t)) * SLIDER_STEPS);
}

function fromPos(spec: ParamSpec, pos: number): number {
  const t = pos / SLIDER_STEPS;
  const raw =
    spec.scale === "log"
      ? spec.min * (spec.max / spec.min) ** t
      : spec.scale === "log0"
        ? spec.ref! * (10 ** (t * Math.log10(1 + spec.max / spec.ref!)) - 1)
        : spec.min + t * (spec.max - spec.min);
  // Three significant digits keeps slider values tidy (4.7e-6, not 4.6998e-6).
  return Math.min(spec.max, Math.max(spec.min, Number(raw.toPrecision(3))));
}

const DUR_MIN = 0.1;
const DUR_MAX = 5;
const durToPos = (f: number) => Math.round(Math.min(1, Math.max(0, Math.log(f / DUR_MIN) / Math.log(DUR_MAX / DUR_MIN))) * SLIDER_STEPS);
function durFromPos(pos: number): number {
  const f = DUR_MIN * (DUR_MAX / DUR_MIN) ** (pos / SLIDER_STEPS);
  return Math.abs(Math.log(f)) < 0.05 ? 1 : f; // snap to "auto"
}

// --- Controls ----------------------------------------------------------------

interface Control {
  range: HTMLInputElement;
  num: HTMLInputElement;
  spec: ParamSpec;
}
const controls = new Map<string, Control>();
let durationControl: { range: HTMLInputElement; out: HTMLOutputElement } | undefined;

/** Text for the number box: 6 significant digits, and 1e-6 rather than 0.000001. */
function plainNumber(v: number): string {
  const rounded = Number(v.toPrecision(6));
  const abs = Math.abs(rounded);
  return abs !== 0 && (abs < 1e-3 || abs >= 1e7) ? rounded.toExponential().replace("e+", "e") : String(rounded);
}

function buildControls() {
  ui.params.replaceChildren();
  controls.clear();

  for (const [key, spec] of Object.entries(def().params)) {
    const row = document.createElement("div");
    row.className = "param";
    const label = document.createElement("label");
    label.htmlFor = `p-${key}`;
    label.textContent = spec.unit ? `${spec.label} [${spec.unit}]` : spec.label;

    const ctl = document.createElement("div");
    ctl.className = "ctl";
    const range = Object.assign(document.createElement("input"), { type: "range", id: `p-${key}`, min: "0", max: String(SLIDER_STEPS), step: "1" });
    const num = Object.assign(document.createElement("input"), { type: "number", step: "any", min: String(spec.min), max: String(spec.max) });
    num.setAttribute("aria-label", `${spec.label} value`);

    range.addEventListener("input", () => {
      params[key] = fromPos(spec, Number(range.value));
      num.value = plainNumber(params[key]!);
      range.setAttribute("aria-valuetext", formatValue(params[key]!, spec.unit));
      recompute();
    });
    num.addEventListener("change", () => {
      const typed = Number(num.value);
      if (num.value === "" || !Number.isFinite(typed)) {
        num.value = plainNumber(params[key]!);
        return;
      }
      const clamped = Math.min(spec.max, Math.max(spec.min, typed));
      if (clamped !== typed) setStatus(`${spec.label} limited to ${sig(spec.min)} … ${sig(spec.max)} ${spec.unit}.`);
      params[key] = clamped;
      syncControls();
      recompute();
    });

    ctl.append(range, num);
    row.append(label, ctl);
    ui.params.appendChild(row);
    controls.set(key, { range, num, spec });
  }

  // Duration, as a multiple of the automatic choice.
  const row = document.createElement("div");
  row.className = "param";
  const label = document.createElement("label");
  label.htmlFor = "p-duration";
  label.textContent = "Simulated time";
  const ctl = document.createElement("div");
  ctl.className = "ctl";
  const range = Object.assign(document.createElement("input"), { type: "range", id: "p-duration", min: "0", max: String(SLIDER_STEPS), step: "1" });
  const out = document.createElement("output");
  out.className = "muted";
  range.addEventListener("input", () => {
    durationFactor = durFromPos(Number(range.value));
    recompute();
  });
  ctl.append(range, out);
  row.append(label, ctl);
  ui.params.appendChild(row);
  durationControl = { range, out };

  syncControls();
}

function syncControls() {
  for (const [key, { range, num, spec }] of controls) {
    range.value = String(toPos(spec, params[key]!));
    num.value = plainNumber(params[key]!);
    range.setAttribute("aria-valuetext", formatValue(params[key]!, spec.unit));
  }
  if (durationControl) durationControl.range.value = String(durToPos(durationFactor));
}

// --- Solving -------------------------------------------------------------------

function recompute() {
  const base = planSimulation(system, params);
  if (!("plan" in base)) {
    // Keep showing the last good plot; say what to change.
    setStatus(base.issues.map((i) => i.message).join("; "), true);
    return;
  }
  let next = base.plan;
  if (durationFactor !== 1) {
    const wanted = Math.min(base.plan.duration * durationFactor, base.plan.dt * MAX_STEPS * 0.999);
    const again = planSimulation(system, params, wanted);
    if ("plan" in again) next = again.plan;
  }
  plan = next;
  solved = solve(next);
  setStatus("");

  cursorTime = Math.min(cursorTime, tEnd());
  hoverIndex = undefined;
  if (durationControl) durationControl.out.textContent = `${durationFactor === 1 ? "auto" : `${sig(durationFactor, 2)}×`} · ${formatValue(tEnd(), def().timeUnit)}`;
  ui.solverNote.textContent = `RK4 · fixed step ${formatValue(plan.dt, def().timeUnit)} · ${solved.sol.steps} steps`;
  renderResults();
  renderTime();
  draw();
}

function renderResults() {
  if (!solved) return;
  ui.kv.replaceChildren();
  for (const k of solved.keyValues) {
    const box = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = k.label;
    const dd = document.createElement("dd");
    dd.textContent = formatValue(k.value, k.unit);
    const basis = document.createElement("span");
    basis.className = "basis";
    basis.textContent = k.basis === "numerical" ? "from the solution" : "formula";
    dd.appendChild(basis);
    box.append(dt, dd);
    ui.kv.appendChild(box);
  }
  ui.resultsNote.textContent = "";
}

// --- Drawing ---------------------------------------------------------------------

function theme(): PlotTheme {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string) => css.getPropertyValue(name).trim();
  return { text: get("--text"), muted: get("--muted"), grid: get("--border"), bg: get("--bg"), series: [get("--s1"), get("--s2"), get("--s3")] };
}

function sizeCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function currentView() {
  return def().views.find((v) => v.id === viewId) ?? def().views[0]!;
}

function plotSpec(): PlotSpec | undefined {
  if (!solved || !plan) return undefined;
  const view = currentView();
  const x = solved.series[view.x.series]!;
  return {
    x: { label: view.x.label, unit: view.x.unit },
    y: view.y,
    lines: view.lines.map((l) => ({ label: l.label, x, y: solved!.series[l.series]! })),
    refs: view.refs?.(plan.params) ?? [],
    equalAspect: view.equalAspect,
  };
}

let layoutRef: ReturnType<typeof drawPlot> | undefined;

function draw() {
  const spec = plotSpec();
  if (!spec || !solved) return;
  const { ctx, w, h } = sizeCanvas(ui.plot);
  if (w === 0 || h === 0) return;
  const cursor = def().animated ? nearestIndex(solved.sol.t, cursorTime) : undefined;
  layoutRef = drawPlot(ctx, w, h, spec, theme(), { cursor, hover: hoverIndex });
  ui.plot.setAttribute("aria-label", `${currentView().label}: ${def().label}`);
  if (system === "pendulum") drawRig(cursor ?? 0);
}

/** Side view of the pendulum at the cursor time. The rod is drawn at a fixed size; its real length is in the label. */
function drawRig(index: number) {
  if (!solved || !plan) return;
  const { ctx, w, h } = sizeCanvas(ui.rig);
  if (w === 0 || h === 0) return;
  const t = theme();
  ctx.clearRect(0, 0, w, h);
  ctx.font = "12px system-ui, sans-serif";
  const angle = (solved.series.theta_deg![index]! * Math.PI) / 180;
  const px = w / 2;
  const py = 26;
  const rod = Math.max(40, Math.min(h - 70, (w - 40) / 2 / Math.max(0.35, Math.abs(Math.sin(Math.max(maxSwing(), 0.35))))));
  const bx = px + rod * Math.sin(angle);
  const by = py + rod * Math.cos(angle);

  ctx.strokeStyle = t.grid;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px, py + rod + 18);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = t.muted;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(px - 22, py - 6);
  ctx.lineTo(px + 22, py - 6);
  ctx.stroke();

  ctx.strokeStyle = t.text;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(bx, by);
  ctx.stroke();

  ctx.fillStyle = t.series[0]!;
  ctx.strokeStyle = t.bg;
  ctx.beginPath();
  ctx.arc(bx, by, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = t.muted;
  ctx.textAlign = "center";
  ctx.fillText(`L = ${formatValue(plan.params.length_m!, "m")} (not to scale)`, w / 2, h - 28);
  ctx.fillStyle = t.text;
  ctx.fillText(`θ = ${sig(solved.series.theta_deg![index]!, 3)}°`, w / 2, h - 10);
}

function maxSwing(): number {
  let m = 0;
  for (const v of solved!.series.theta_deg!) m = Math.max(m, Math.abs(v));
  return Math.min(Math.PI, (m * Math.PI) / 180);
}

function buildViewTabs() {
  ui.views.replaceChildren();
  for (const view of def().views) {
    const b = document.createElement("button");
    b.type = "button";
    b.role = "tab";
    b.textContent = view.label;
    b.setAttribute("aria-selected", String(view.id === viewId));
    b.addEventListener("click", () => {
      viewId = view.id;
      hoverIndex = undefined;
      for (const other of ui.views.children) other.setAttribute("aria-selected", String(other === b));
      draw();
    });
    ui.views.appendChild(b);
  }
}

// --- Animation (pendulum, projectile) -------------------------------------------------

function renderTime() {
  const end = tEnd();
  ui.time.value = String(end > 0 ? Math.round((cursorTime / end) * SLIDER_STEPS) : 0);
  ui.timeValue.textContent = `t = ${formatValue(cursorTime, def().timeUnit)}`;
}

let lastFrame = 0;
function frame(now: number) {
  if (!playing) return;
  cursorTime += ((now - lastFrame) / 1000) * Number(ui.speed.value);
  lastFrame = now;
  if (cursorTime >= tEnd()) {
    cursorTime = tEnd();
    setPlaying(false);
  }
  renderTime();
  draw();
  if (playing) requestAnimationFrame(frame);
}

function setPlaying(on: boolean) {
  playing = on;
  ui.play.textContent = on ? "Pause" : "Play";
  ui.play.setAttribute("aria-label", on ? "Pause animation" : "Play animation");
  if (on) {
    if (cursorTime >= tEnd()) cursorTime = 0;
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  }
}

ui.play.addEventListener("click", () => setPlaying(!playing));
ui.time.addEventListener("input", () => {
  cursorTime = (Number(ui.time.value) / SLIDER_STEPS) * tEnd();
  renderTime();
  draw();
});

// --- Hover read-out ---------------------------------------------------------------------

ui.plot.addEventListener("pointermove", (e) => {
  const spec = plotSpec();
  if (!spec || !layoutRef || !currentView().hover) return;
  const rect = ui.plot.getBoundingClientRect();
  const x = layoutRef.fromX(e.clientX - rect.left);
  hoverIndex = nearestIndex(spec.lines[0]!.x, x);
  draw();
});
ui.plot.addEventListener("pointerleave", () => {
  hoverIndex = undefined;
  draw();
});

new ResizeObserver(draw).observe(ui.plotWrap);
new ResizeObserver(() => system === "pendulum" && draw()).observe(ui.rig);

// --- Loading a system ---------------------------------------------------------------------

function showSystem(id: SystemId, given: Params, factor: number) {
  setPlaying(false);
  system = id;
  params = { ...defaultParams(id), ...given };
  durationFactor = factor;
  toolParams = { ...params };
  toolFactor = factor;
  viewId = def().views[0]!.id;
  cursorTime = 0;
  hoverIndex = undefined;

  ui.title.textContent = def().label;
  ui.rig.hidden = id !== "pendulum";
  ui.transport.hidden = !def().animated;
  ui.assumptions.replaceChildren(
    ...def().assumptions.map((a) => {
      const li = document.createElement("li");
      li.textContent = a;
      return li;
    }),
  );
  buildViewTabs();
  buildControls();
  recompute();
}

ui.reset.addEventListener("click", () => {
  params = { ...toolParams };
  durationFactor = toolFactor;
  cursorTime = 0;
  setPlaying(false);
  syncControls();
  recompute();
});

// --- Host connection (MCP Apps) ---------------------------------------------------------------

const app = new App({ name: "maker-lab-simulation", version: "0.1.0" });

function applyHostContext() {
  const ctx = app.getHostContext();
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  draw();
}

app.ontoolresult = (result) => {
  if (result.isError) {
    const text = result.content?.find((c) => c.type === "text")?.text;
    setStatus(text ?? "The tool returned an error.", true);
    return;
  }
  const out = result.structuredContent as SimulationOutput | undefined;
  if (!out || !(out.system in SYSTEMS)) {
    setStatus("No simulation data in the tool result.", true);
    return;
  }
  // Re-derive the duration as a multiple of the automatic one so the time slider can represent it.
  const auto = planSimulation(out.system, out.parameters);
  const factor = out.durationAuto || !("plan" in auto) ? 1 : out.duration / auto.plan.duration;
  showSystem(out.system, out.parameters, Number.isFinite(factor) && factor > 0 ? factor : 1);
};
app.onhostcontextchanged = applyHostContext;

if (window.parent === window) {
  // Opened directly in a browser (development): show a demo. ?system=rlc_circuit picks another one.
  const requested = new URLSearchParams(location.search).get("system") as SystemId | null;
  if (requested && requested in SYSTEMS) showSystem(requested, {}, 1);
  else showSystem("pendulum", { theta0_deg: 40, damping_per_s: 0.1 }, 1);
  setStatus("Standalone preview with demo data. In ChatGPT or Claude the system comes from the tool call.");
} else {
  app
    .connect()
    .then(applyHostContext)
    .catch((err: unknown) => setStatus(`Could not connect to the host: ${String(err)}`, true));
}
