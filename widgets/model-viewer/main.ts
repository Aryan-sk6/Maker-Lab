// Maker Lab 3D viewer widget: receives a render_3d_model result from the host and shows it with Three.js.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import type { ModelInput, PartInput } from "../../shared/model3d.js";
import { describeShape } from "../../shared/describe3d.js";
import { buildGeometry } from "./geometry.js";
import { DEMO_MODEL } from "./demo.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  title: $<HTMLHeadingElement>("title"),
  viewport: $<HTMLDivElement>("viewport"),
  parts: $<HTMLUListElement>("parts"),
  explode: $<HTMLInputElement>("explode"),
  joint: $<HTMLDivElement>("joint"),
  jointLabel: $<HTMLSpanElement>("joint-label"),
  jointAngle: $<HTMLInputElement>("joint-angle"),
  jointValue: $<HTMLOutputElement>("joint-value"),
  fit: $<HTMLButtonElement>("fit"),
  fullscreen: $<HTMLButtonElement>("fullscreen"),
  stl: $<HTMLButtonElement>("stl"),
  status: $<HTMLParagraphElement>("status"),
};

// --- Scene setup ----------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
ui.viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
camera.up.set(0, 0, 1); // Z-up, like most CAD tools and slicers.

const controls = new OrbitControls(camera, renderer.domElement);
controls.addEventListener("change", render);

scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(1, -1.5, 2);
scene.add(sun);

const assembly = new THREE.Group(); // everything that gets exported to STL
scene.add(assembly);
let grid: THREE.GridHelper | undefined;

/** Per-part scene objects. `outer` carries position/rotation/explode; `spin` carries the joint angle. */
interface PartNode {
  def: PartInput;
  outer: THREE.Group;
  spin: THREE.Group;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  basePosition: THREE.Vector3;
  explodeDir: THREE.Vector3;
  listItem: HTMLButtonElement;
}

let nodes = new Map<string, PartNode>();
let explodeScale = 0;
let selected: string | undefined;
let modelName = "model";

function render() {
  renderer.render(scene, camera);
}

new ResizeObserver(() => {
  const { clientWidth: w, clientHeight: h } = ui.viewport;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  render();
}).observe(ui.viewport);

// --- Building the model ---------------------------------------------------

const deg = THREE.MathUtils.degToRad;

function showModel(model: ModelInput) {
  // Dispose the previous model, if any.
  for (const node of nodes.values()) {
    node.mesh.geometry.dispose();
    node.mesh.material.dispose();
  }
  assembly.clear();
  nodes = new Map();
  ui.parts.replaceChildren();
  selected = undefined;

  modelName = model.title ?? "model";
  ui.title.textContent = model.title ?? "3D model";

  for (const def of model.parts) {
    const outer = new THREE.Group();
    const spin = new THREE.Group();
    outer.add(spin);
    outer.position.fromArray(def.position);
    outer.rotation.set(deg(def.rotation[0]), deg(def.rotation[1]), deg(def.rotation[2]), "XYZ");

    const material = new THREE.MeshStandardMaterial({ color: def.color, metalness: 0.1, roughness: 0.6 });
    const mesh = new THREE.Mesh(buildGeometry(def.shape), material);
    mesh.userData.partName = def.name;
    spin.add(mesh);

    nodes.set(def.name, {
      def,
      outer,
      spin,
      mesh,
      basePosition: outer.position.clone(),
      explodeDir: new THREE.Vector3(),
      listItem: addListItem(def),
    });
  }

  // Attach children to their parent's spinning group so they follow joint rotation.
  for (const node of nodes.values()) {
    const parent = node.def.parent ? nodes.get(node.def.parent) : undefined;
    (parent ? parent.spin : assembly).add(node.outer);
    setJointAngle(node, node.def.joint?.angle ?? 0);
  }

  computeExplodeDirections();
  ui.explode.value = "0";
  applyExplode(0);
  fitView();
  ui.stl.disabled = false;
  setStatus(`${model.parts.length} part${model.parts.length === 1 ? "" : "s"}. Drag to orbit, scroll to zoom, right-drag to pan.`);
}

function addListItem(def: PartInput): HTMLButtonElement {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-pressed", "false");
  const swatch = document.createElement("span");
  swatch.className = "swatch";
  swatch.style.background = def.color;
  const text = document.createElement("span");
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = def.name;
  const desc = document.createElement("span");
  desc.className = "desc";
  desc.textContent = describeShape(def.shape) + (def.joint?.type === "rotating" ? " · rotating" : "");
  text.append(name, desc);
  button.append(swatch, text);
  button.addEventListener("click", () => select(selected === def.name ? undefined : def.name));
  li.appendChild(button);
  ui.parts.appendChild(li);
  return button;
}

// --- Exploded view --------------------------------------------------------
// Children move along their joint axis (expressed in the parent's frame), away from the parent.
// Top-level parts move radially away from the centre of the top-level parts.

function computeExplodeDirections() {
  const roots = [...nodes.values()].filter((n) => !n.def.parent);
  const centre = new THREE.Vector3();
  for (const r of roots) centre.add(r.basePosition);
  if (roots.length > 0) centre.divideScalar(roots.length);

  for (const node of nodes.values()) {
    if (node.def.parent) {
      const axis = node.def.joint?.axis ?? "z";
      const dir = new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
      dir.applyEuler(node.outer.rotation);
      // Point away from the parent's origin; default to the positive axis direction.
      if (node.basePosition.dot(dir) < 0) dir.negate();
      node.explodeDir.copy(dir);
    } else {
      const away = node.basePosition.clone().sub(centre);
      node.explodeDir.copy(away.lengthSq() > 1e-6 ? away.normalize() : away.set(0, 0, 0));
    }
  }

  const size = new THREE.Box3().setFromObject(assembly).getSize(new THREE.Vector3());
  explodeScale = Math.max(size.x, size.y, size.z) * 0.35;
}

function applyExplode(t: number) {
  for (const node of nodes.values()) {
    node.outer.position.copy(node.basePosition).addScaledVector(node.explodeDir, t * explodeScale);
  }
  render();
}

ui.explode.addEventListener("input", () => applyExplode(Number(ui.explode.value)));

// --- Joints ---------------------------------------------------------------

function setJointAngle(node: PartNode, degrees: number) {
  const axis = node.def.joint?.axis ?? "z";
  node.spin.rotation.set(0, 0, 0);
  node.spin.rotation[axis] = deg(degrees);
  node.spin.userData.angle = degrees;
}

ui.jointAngle.addEventListener("input", () => {
  const node = selected ? nodes.get(selected) : undefined;
  if (!node) return;
  setJointAngle(node, Number(ui.jointAngle.value));
  ui.jointValue.textContent = `${ui.jointAngle.value}°`;
  render();
});

// --- Selection ------------------------------------------------------------

function select(name: string | undefined) {
  selected = name;
  for (const node of nodes.values()) {
    const isSelected = node.def.name === name;
    const dimmed = name !== undefined && !isSelected;
    if (node.mesh.material.transparent !== dimmed) {
      node.mesh.material.transparent = dimmed;
      node.mesh.material.needsUpdate = true; // switching transparency needs a shader recompile
    }
    node.mesh.material.opacity = dimmed ? 0.25 : 1;
    node.mesh.material.depthWrite = !dimmed;
    node.mesh.material.emissive.set(isSelected ? 0x2a3f66 : 0x000000);
    node.listItem.setAttribute("aria-pressed", String(isSelected));
  }

  const node = name ? nodes.get(name) : undefined;
  if (node?.def.joint?.type === "rotating") {
    ui.joint.hidden = false;
    ui.jointLabel.textContent = `${node.def.name} angle`;
    const angle = Math.round(node.spin.userData.angle ?? 0);
    ui.jointAngle.value = String(angle);
    ui.jointValue.textContent = `${angle}°`;
  } else {
    ui.joint.hidden = true;
  }
  node?.listItem.scrollIntoView({ block: "nearest" });
  render();
}

// Click (not drag) on the canvas selects the part under the cursor.
const pointerDown = new THREE.Vector2();
renderer.domElement.addEventListener("pointerdown", (e) => pointerDown.set(e.clientX, e.clientY));
renderer.domElement.addEventListener("pointerup", (e) => {
  if (pointerDown.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) > 4) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(assembly.children, true)[0];
  const name = hit?.object.userData.partName as string | undefined;
  select(name === selected ? undefined : name);
});

// --- Camera ---------------------------------------------------------------

function fitView() {
  const box = new THREE.Box3().setFromObject(assembly);
  if (box.isEmpty()) return;
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
  const distance = radius / Math.sin(deg(camera.fov / 2)) * 1.15;

  camera.position.copy(centre).add(new THREE.Vector3(1, -1.6, 1).normalize().multiplyScalar(distance));
  camera.near = Math.max(distance / 1000, 0.01);
  camera.far = distance * 20;
  camera.updateProjectionMatrix();
  controls.target.copy(centre);
  controls.update();

  // Ground grid under the model, sized to a round number of mm.
  if (grid) {
    scene.remove(grid);
    grid.dispose();
  }
  const span = niceCeil(radius * 3);
  grid = new THREE.GridHelper(span, 20, 0x8892a0, 0xc4cad3);
  grid.rotation.x = Math.PI / 2; // GridHelper lies in XZ; turn it into the XY plane.
  grid.position.set(centre.x, centre.y, box.min.z);
  scene.add(grid);
  render();
}

function niceCeil(x: number): number {
  const p = 10 ** Math.floor(Math.log10(x));
  return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= x) ?? 10 * p;
}

ui.fit.addEventListener("click", fitView);

// --- STL export -----------------------------------------------------------
// Exports the assembled pose (explode = 0, current joint angles) in millimetres.

function exportStl(): ArrayBuffer {
  const explode = Number(ui.explode.value);
  applyExplode(0);
  assembly.updateMatrixWorld(true);
  const view = new STLExporter().parse(assembly, { binary: true }) as DataView;
  applyExplode(explode);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

ui.stl.addEventListener("click", async () => {
  const filename = `${modelName.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "model"}.stl`;
  const stl = exportStl();

  // Preferred: ask the host to download it (MCP Apps ui/download-file), since sandboxed iframes may block downloads.
  if (connected && app.getHostCapabilities()?.downloadFile) {
    try {
      const { isError } = await app.downloadFile({
        contents: [{ type: "resource", resource: { uri: `file:///${filename}`, mimeType: "model/stl", blob: toBase64(stl) } }],
      });
      setStatus(isError ? "Download was cancelled or blocked by the host." : `Saved ${filename} (units: mm).`);
      return;
    } catch (err) {
      console.warn("Host download failed, falling back to a browser download", err);
    }
  }

  // Fallback: a normal browser download. Some hosts' sandboxes block this silently.
  const url = URL.createObjectURL(new Blob([stl], { type: "model/stl" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  setStatus(`Started download of ${filename} (units: mm). If nothing appears, this host blocks downloads from widgets.`);
});

// --- Host connection (MCP Apps) -------------------------------------------

function setStatus(text: string, isError = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle("error", isError);
}

const app = new App({ name: "maker-lab-model-viewer", version: "0.1.0" });
let connected = false;

function applyHostContext() {
  const ctx = app.getHostContext();
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  document.documentElement.dataset.display = ctx?.displayMode ?? "inline";
  ui.fullscreen.hidden = !ctx?.availableDisplayModes?.includes("fullscreen");
  ui.fullscreen.textContent = ctx?.displayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen";
}

app.ontoolresult = (result) => {
  if (result.isError) {
    const text = result.content?.find((c) => c.type === "text")?.text;
    setStatus(text ?? "The tool returned an error.", true);
    return;
  }
  const model = result.structuredContent as ModelInput | undefined;
  if (!model?.parts?.length) {
    setStatus("No model data in the tool result.", true);
    return;
  }
  showModel(model);
};

app.onhostcontextchanged = applyHostContext;

ui.fullscreen.addEventListener("click", async () => {
  const mode = app.getHostContext()?.displayMode === "fullscreen" ? "inline" : "fullscreen";
  await app.requestDisplayMode({ mode });
});

if (window.parent === window) {
  // Opened directly in a browser (development): show the demo model.
  showModel(DEMO_MODEL);
  setStatus("Standalone preview with demo data. In ChatGPT or Claude the model comes from the tool call.");
} else {
  app
    .connect()
    .then(() => {
      connected = true;
      applyHostContext();
    })
    .catch((err: unknown) => setStatus(`Could not connect to the host: ${String(err)}`, true));
}
