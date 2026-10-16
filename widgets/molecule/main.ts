// Maker Lab molecule viewer. The tool result says what to show and where the structure file lives
// (RCSB or PubChem); the widget downloads that file itself and renders it with 3Dmol.js.

import * as $3Dmol from "3dmol";
import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import type { MoleculeOutput } from "../../shared/molecule.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  viewerWrap: $<HTMLDivElement>("viewer-wrap"),
  viewer: $<HTMLDivElement>("viewer"),
  overlay: $<HTMLDivElement>("overlay"),
  name: $<HTMLHeadingElement>("name"),
  facts: $<HTMLDListElement>("facts"),
  sourceLink: $<HTMLAnchorElement>("source-link"),
  dataNote: $<HTMLParagraphElement>("data-note"),
  legend: $<HTMLParagraphElement>("legend"),
  disclaimer: $<HTMLParagraphElement>("disclaimer"),
  status: $<HTMLParagraphElement>("status"),
  spin: $<HTMLButtonElement>("spin"),
  reset: $<HTMLButtonElement>("reset"),
  fullscreen: $<HTMLButtonElement>("fullscreen"),
  styleButtons: [...document.querySelectorAll<HTMLButtonElement>("button[data-style]")],
  colorButtons: [...document.querySelectorAll<HTMLButtonElement>("button[data-color]")],
};

type StyleName = "stick" | "sphere" | "cartoon";
type ColorName = "element" | "chain";
type Viewer = ReturnType<typeof $3Dmol.createViewer>;

let viewer: Viewer | undefined;
let hasPolymer = false; // protein or nucleic-acid backbone present, so cartoon makes sense
let style: StyleName = "stick";
let color: ColorName = "element";
let spinning = false;
let loadToken = 0; // lets a newer tool result cancel an older download

/** Show the toolbar only while a model is displayed, and the details panel only while there are details. */
function setVisible(parts: { toolbar?: boolean; details?: boolean }) {
  const app = document.getElementById("app")!;
  if (parts.toolbar !== undefined) app.dataset.toolbar = String(parts.toolbar);
  if (parts.details !== undefined) app.dataset.details = String(parts.details);
}

function setStatus(text: string, isError = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle("error", isError);
}

function showOverlay(text: string | undefined, isError = false) {
  ui.overlay.hidden = text === undefined;
  ui.overlay.textContent = text ?? "";
  ui.overlay.classList.toggle("error", isError);
}

// --- Viewer ------------------------------------------------------------------------------

function themeColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#ffffff";
}

function ensureViewer(): Viewer | undefined {
  if (viewer) return viewer;
  try {
    viewer = $3Dmol.createViewer(ui.viewer, { backgroundColor: themeColor("--bg"), antialias: true });
    return viewer;
  } catch (err) {
    showOverlay("This host cannot run WebGL, which the 3D viewer needs. The details panel still works.", true);
    console.warn("3Dmol createViewer failed", err);
    return undefined;
  }
}

/** Water is hidden; everything else is drawn in the chosen style and colour. */
function applyStyle() {
  if (!viewer) return;
  const byElement = color === "element";
  const scheme = byElement ? "Jmol" : "chain";
  const notWater = { resn: "HOH", invert: true };
  const ligands = { and: [{ hetflag: true }, notWater] };

  viewer.setStyle({}, {}); // clear everything, then style what we want visible
  if (style === "cartoon" && hasPolymer) {
    // Cartoon has no atoms to colour by element, so "element" shows secondary-structure colours instead.
    viewer.setStyle({ hetflag: false }, { cartoon: { colorscheme: byElement ? "ssJmol" : "chain" } });
    viewer.setStyle(ligands, { stick: { radius: 0.2, colorscheme: "Jmol" }, sphere: { scale: 0.25, colorscheme: "Jmol" } });
  } else if (style === "sphere") {
    viewer.setStyle(notWater, { sphere: { colorscheme: scheme } });
  } else {
    viewer.setStyle(notWater, { stick: { radius: 0.15, colorscheme: scheme } });
  }
  viewer.render();

  for (const b of ui.styleButtons) b.setAttribute("aria-pressed", String(b.dataset.style === style));
  for (const b of ui.colorButtons) b.setAttribute("aria-pressed", String(b.dataset.color === color));
  ui.legend.textContent =
    style === "cartoon" && hasPolymer
      ? byElement
        ? "Cartoon shows the backbone, coloured by secondary structure (helix, sheet, loop). Ligands are drawn as ball-and-stick in element colours."
        : "Cartoon shows the backbone; each chain has its own colour. Ligands are drawn as ball-and-stick in element colours."
      : byElement
        ? "Element colours: carbon grey, hydrogen white, oxygen red, nitrogen blue, sulfur yellow, phosphorus orange."
        : "Each chain has its own colour.";
}

function updateControls() {
  const cartoon = ui.styleButtons.find((b) => b.dataset.style === "cartoon")!;
  cartoon.disabled = !hasPolymer;
  cartoon.title = hasPolymer ? "" : "Cartoon needs a protein or nucleic-acid backbone";
  const chain = ui.colorButtons.find((b) => b.dataset.color === "chain")!;
  chain.disabled = !hasPolymer;
  chain.title = hasPolymer ? "" : "Chains exist only in protein and nucleic-acid structures";
}

function setSpin(on: boolean) {
  spinning = on;
  ui.spin.setAttribute("aria-pressed", String(on));
  viewer?.spin(on ? "y" : false, 1);
}

for (const b of ui.styleButtons) {
  b.addEventListener("click", () => {
    style = b.dataset.style as StyleName;
    applyStyle();
  });
}
for (const b of ui.colorButtons) {
  b.addEventListener("click", () => {
    color = b.dataset.color as ColorName;
    applyStyle();
  });
}
ui.spin.addEventListener("click", () => setSpin(!spinning));
ui.reset.addEventListener("click", () => {
  viewer?.zoomTo();
  viewer?.render();
});

new ResizeObserver(() => {
  viewer?.resize();
  viewer?.render();
}).observe(ui.viewerWrap);

// --- Details panel -------------------------------------------------------------------------

function fact(label: string, value: string, mono = false): HTMLDivElement {
  const row = document.createElement("div");
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  if (mono) dd.className = "mono";
  row.append(dt, dd);
  return row;
}

function showInfo(m: MoleculeOutput) {
  setVisible({ details: true });
  ui.name.textContent = m.name;
  ui.facts.replaceChildren(
    ...(m.formula ? [fact("Formula", m.formula)] : m.source === "pdb" ? [fact("Formula", "not applicable (macromolecule)")] : []),
    ...(m.mass ? [fact("Mass", m.mass)] : []),
    ...m.details.map((d) => fact(d.label, d.value, d.label === "SMILES")),
  );
  ui.sourceLink.textContent = `${m.sourceName} · ${m.id}`;
  ui.sourceLink.href = m.pageUrl;
  ui.dataNote.textContent = m.dataNote;
  ui.disclaimer.textContent = m.disclaimer;
}

// Links in a sandboxed iframe cannot navigate on their own; ask the host to open them when it can.
ui.sourceLink.addEventListener("click", (e) => {
  e.preventDefault();
  const url = ui.sourceLink.href;
  if (connected && app.getHostCapabilities()?.openLinks) void app.openLink({ url });
  else window.open(url, "_blank", "noopener,noreferrer");
});

// --- Loading a structure -----------------------------------------------------------------------

async function load(m: MoleculeOutput) {
  const token = ++loadToken;
  showInfo(m);
  setVisible({ toolbar: false });
  showOverlay("Downloading structure…");
  setStatus("");

  let text: string;
  try {
    const response = await fetch(m.dataUrl); // no custom headers, so it stays a simple CORS request
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    text = await response.text();
  } catch (err) {
    if (token !== loadToken) return;
    showOverlay(`Could not download the structure from ${new URL(m.dataUrl).hostname} (${String(err)}). Use the source link to open it there.`, true);
    return;
  }
  if (token !== loadToken) return; // a newer result replaced this one

  const v = ensureViewer();
  if (!v) return;
  try {
    v.removeAllModels();
    v.addModel(text, m.format);
    const atoms = v.selectedAtoms({});
    if (atoms.length === 0) throw new Error("the file contained no atoms");
    hasPolymer = m.format !== "sdf" && v.selectedAtoms({ hetflag: false }).length > 0;
    style = hasPolymer ? "cartoon" : "stick";
    color = hasPolymer ? "chain" : "element";
    updateControls();
    applyStyle();
    v.zoomTo();
    v.render();
    setSpin(false);
    showOverlay(undefined);
    const shown = v.selectedAtoms({ resn: "HOH", invert: true }).length;
    const water = atoms.length - shown;
    setStatus(`${shown.toLocaleString("en-US")} atoms shown${water > 0 ? ` (${water.toLocaleString("en-US")} water atoms hidden)` : ""}. Drag to rotate, scroll to zoom, right-drag or two fingers to move.`);
  } catch (err) {
    showOverlay(`The structure file could not be displayed: ${String(err)}`, true);
  }
}

// --- Host connection (MCP Apps) -------------------------------------------------------------------

const app = new App({ name: "maker-lab-molecule-viewer", version: "0.1.0" });
let connected = false;

function applyHostContext() {
  const ctx = app.getHostContext();
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  viewer?.setBackgroundColor(themeColor("--bg"), 1);
  viewer?.render();
  document.documentElement.dataset.display = ctx?.displayMode ?? "inline";
  ui.fullscreen.hidden = !ctx?.availableDisplayModes?.includes("fullscreen");
  ui.fullscreen.textContent = ctx?.displayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen";
}

ui.fullscreen.addEventListener("click", async () => {
  await app.requestDisplayMode({ mode: app.getHostContext()?.displayMode === "fullscreen" ? "inline" : "fullscreen" });
});

app.ontoolresult = (result) => {
  if (result.isError) {
    const text = result.content?.find((c) => c.type === "text")?.text;
    ++loadToken;
    setVisible({ toolbar: false, details: false });
    showOverlay(text ?? "The tool returned an error.", true);
    return;
  }
  const out = result.structuredContent as MoleculeOutput | undefined;
  if (!out?.dataUrl) {
    setVisible({ toolbar: false, details: false });
    showOverlay("No structure in the tool result.", true);
    return;
  }
  void load(out);
};
app.onhostcontextchanged = applyHostContext;

if (window.parent === window) {
  // Opened directly in a browser (development): ?pdb=1CRN or ?cid=2519 loads that entry straight from RCSB / PubChem.
  const params = new URLSearchParams(location.search);
  const pdb = params.get("pdb");
  const base = { query: { kind: "pdb_id" as const, value: "" }, disclaimer: "Educational use only. Not for medical, dosing, safety or engineering decisions." };
  if (pdb) {
    const id = pdb.toUpperCase();
    void load({ ...base, source: "pdb", sourceName: "RCSB Protein Data Bank", id, name: `PDB entry ${id}`, formula: null, mass: null, details: [{ label: "PDB ID", value: id }], format: "pdb", dataUrl: `https://files.rcsb.org/download/${id}.pdb`, pageUrl: `https://www.rcsb.org/structure/${id}`, dataNote: "Standalone preview: details come from the tool in a real host." });
  } else {
    const cid = params.get("cid") ?? "2519";
    void load({ ...base, source: "pubchem", sourceName: "PubChem", id: cid, name: `PubChem compound ${cid}`, formula: null, mass: null, details: [{ label: "PubChem CID", value: cid }], format: "sdf", dataUrl: `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/SDF?record_type=3d`, pageUrl: `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`, dataNote: "Standalone preview: details come from the tool in a real host." });
  }
} else {
  app
    .connect()
    .then(() => {
      connected = true;
      applyHostContext();
    })
    .catch((err: unknown) => showOverlay(`Could not connect to the host: ${String(err)}`, true));
}
