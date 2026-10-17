// Maker Lab 3D viewer widget: shows a render_3d_model result with Three.js, and lets students turn the mechanism,
// read how fast each part goes, and change tooth counts to see what happens.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import type { LinkInput, ShapeInput } from "../../shared/model3d.js";
import { describeShape } from "../../shared/describe3d.js";
import { buildMechanism, type Mechanism, type ResolvedPart } from "../../shared/mechanism.js";
import { describeMotion, poseAt, type Kinematics } from "../../shared/kinematics.js";
import { buildGeometry } from "./geometry.js";
import { DEMO_MODEL } from "./demo.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  title: $<HTMLHeadingElement>("title"),
  viewport: $<HTMLDivElement>("viewport"),
  parts: $<HTMLUListElement>("parts"),
  explode: $<HTMLInputElement>("explode"),
  details: $<HTMLDivElement>("details"),
  detailsName: $<HTMLHeadingElement>("details-name"),
  detailsMotion: $<HTMLParagraphElement>("details-motion"),
  edit: $<HTMLDivElement>("edit"),
  editLabel: $<HTMLSpanElement>("edit-label"),
  editValue: $<HTMLOutputElement>("edit-value"),
  editMinus: $<HTMLButtonElement>("edit-minus"),
  editPlus: $<HTMLButtonElement>("edit-plus"),
  joint: $<HTMLDivElement>("joint"),
  jointLabel: $<HTMLSpanElement>("joint-label"),
  jointAngle: $<HTMLInputElement>("joint-angle"),
  jointValue: $<HTMLOutputElement>("joint-value"),
  drive: $<HTMLElement>("drive"),
  play: $<HTMLButtonElement>("play"),
  turn: $<HTMLInputElement>("turn"),
  turnLabel: $<HTMLLabelElement>("turn-label"),
  turnValue: $<HTMLOutputElement>("turn-value"),
  speed: $<HTMLSelectElement>("speed"),
  speeds: $<HTMLUListElement>("speeds"),
  driveNotes: $<HTMLParagraphElement>("drive-notes"),
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
const beltLayer = new THREE.Group(); // belts are drawn but not exported
scene.add(beltLayer);
let grid: THREE.GridHelper | undefined;

/** Per-part scene objects. `outer` carries position/rotation/explode; `spin` carries the joint angle or rack slide. */
interface PartNode {
  def: ResolvedPart;
  outer: THREE.Group;
  spin: THREE.Group;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  basePosition: THREE.Vector3;
  explodeDir: THREE.Vector3;
  listItem: HTMLButtonElement;
}

interface BeltView {
  path: THREE.CatmullRomCurve3;
  length: number;
  markers: THREE.Mesh[];
}

let mechanism: Mechanism | undefined;
let nodes = new Map<string, PartNode>();
let belts: BeltView[] = [];
let explodeScale = 0;
let selected: string | undefined;
let modelName = "model";
/** Driver angle in radians. */
let phi = 0;
let playing = false;

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

const deg = THREE.MathUtils.degToRad;
const nice = (n: number) => String(Number(n.toPrecision(3)));

// --- Building the scene ---------------------------------------------------

function clearScene() {
  for (const node of nodes.values()) {
    node.mesh.geometry.dispose();
    node.mesh.material.dispose();
  }
  assembly.clear();
  beltLayer.clear();
  nodes = new Map();
  belts = [];
  ui.parts.replaceChildren();
}

/** Small white dot near the rim, so you can count turns and compare speeds by eye. */
function marker(shape: ShapeInput): THREE.Mesh | undefined {
  const r = shape.type === "gear" ? (shape.module * shape.teeth) / 2 : shape.type === "pulley" ? shape.diameter / 2 : undefined;
  if (r === undefined) return undefined;
  const t = shape.type === "gear" ? shape.thickness : shape.type === "pulley" ? shape.width : 0;
  const size = Math.max(0.8, r * 0.12);
  const dot = new THREE.Mesh(new THREE.CylinderGeometry(size, size, 0.6, 24).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  dot.position.set(r * 0.62, 0, t / 2 + 0.3);
  return dot;
}

function showMechanism(m: Mechanism, keepView = false) {
  setPlaying(false);
  clearScene();
  mechanism = m;
  modelName = m.title ?? "model";
  ui.title.textContent = m.title ?? "3D model";

  for (const def of m.parts) {
    const outer = new THREE.Group();
    const spin = new THREE.Group();
    outer.add(spin);
    outer.position.fromArray(def.position);
    outer.rotation.set(deg(def.rotation[0]), deg(def.rotation[1]), deg(def.rotation[2]), "XYZ");

    const material = new THREE.MeshStandardMaterial({ color: def.color, metalness: 0.1, roughness: 0.6 });
    const mesh = new THREE.Mesh(buildGeometry(def.shape), material);
    mesh.userData.partName = def.name;
    spin.add(mesh);
    if (m.kinematics) {
      const dot = marker(def.shape);
      if (dot) mesh.add(dot);
    }
    nodes.set(def.name, { def, outer, spin, mesh, basePosition: outer.position.clone(), explodeDir: new THREE.Vector3(), listItem: addListItem(def) });
  }

  // Children hang off their parent's spinning group so they follow its motion.
  for (const node of nodes.values()) {
    const parent = node.def.parent ? nodes.get(node.def.parent) : undefined;
    (parent ? parent.spin : assembly).add(node.outer);
    if (node.def.joint?.type === "rotating") setJointAngle(node, node.def.joint.angle);
  }

  for (const b of m.kinematics?.belts ?? []) addBelt(b.points, b.length);

  computeExplodeDirections();
  ui.explode.value = "0";
  applyExplode(0);
  showDrivePanel(m.kinematics);
  applyDrive();
  if (!keepView) fitView();
  ui.stl.disabled = false;
  if (selected && nodes.has(selected)) select(selected);
  else select(undefined);
}

function addBelt(points: [number, number, number][], length: number) {
  const path = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), true, "catmullrom", 0);
  const radius = Math.max(1.5, length / 250);
  const tube = new THREE.Mesh(new THREE.TubeGeometry(path, Math.min(600, points.length * 2), radius, 8, true), new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.8 }));
  beltLayer.add(tube);
  const markers: THREE.Mesh[] = [];
  const count = 10;
  for (let i = 0; i < count; i++) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.5, 12, 8), new THREE.MeshBasicMaterial({ color: 0xf97316 }));
    beltLayer.add(dot);
    markers.push(dot);
  }
  belts.push({ path, length, markers });
}

function addListItem(def: ResolvedPart): HTMLButtonElement {
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
  desc.textContent = describeShape(def.shape);
  text.append(name, desc);
  button.append(swatch, text);
  button.addEventListener("click", () => select(selected === def.name ? undefined : def.name));
  li.appendChild(button);
  ui.parts.appendChild(li);
  return button;
}

// --- Exploded view --------------------------------------------------------
// Children move along their joint axis (in the parent's frame), away from the parent.
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
      if (node.def.joint?.type !== "rotating") dir.set(0, 0, 0).copy(node.basePosition).normalize(); // parts on an axle slide along it
      else dir.applyEuler(node.outer.rotation);
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
  for (const node of nodes.values()) node.outer.position.copy(node.basePosition).addScaledVector(node.explodeDir, t * explodeScale);
  beltLayer.visible = t < 0.01; // a belt cannot follow pulleys that fly apart
  render();
}

ui.explode.addEventListener("input", () => applyExplode(Number(ui.explode.value)));

// --- Turning the mechanism -------------------------------------------------------

function setJointAngle(node: PartNode, degrees: number) {
  const axis = node.def.joint?.axis ?? "z";
  node.spin.rotation.set(0, 0, 0);
  node.spin.rotation[axis] = deg(degrees);
  node.spin.userData.angle = degrees;
}

/** Put every linked part where the driver angle φ says it should be. */
function applyDrive() {
  const k = mechanism?.kinematics;
  if (!k) return;
  const pose = poseAt(k, phi);
  for (const [name, angle] of pose.angles) {
    const node = nodes.get(name);
    if (!node) continue;
    node.spin.rotation.set(0, 0, 0);
    node.spin.rotation[node.def.joint?.axis ?? "z"] = angle;
  }
  for (const [name, d] of pose.slides) nodes.get(name)?.spin.position.set(d, 0, 0);
  belts.forEach((belt, i) => {
    const travel = pose.belts[i] ?? 0;
    belt.markers.forEach((dot, j) => {
      const u = (((travel / belt.length + j / belt.markers.length) % 1) + 1) % 1;
      dot.position.copy(belt.path.getPointAt(u));
    });
  });
  updateReadouts(k);
  render();
}

function showDrivePanel(k: Kinematics | undefined) {
  ui.drive.hidden = !k;
  if (!k) return;
  phi = 0;
  ui.turn.value = "0";
  ui.turnLabel.textContent = `Turn "${k.driver.part}"`;
  ui.driveNotes.textContent = k.notes.join(" ");
  ui.speeds.replaceChildren(
    ...[...k.rotors.map((r) => r.name), ...k.racks.map((r) => r.name)].map((name) => {
      const li = document.createElement("li");
      li.dataset.part = name;
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = nodes.get(name)?.def.color ?? "#888";
      const body = document.createElement("span");
      li.append(swatch, body);
      li.addEventListener("click", () => select(name));
      return li;
    }),
  );
}

/** Plain words for each moving part: how it moves compared with the driver, and where it is right now. */
function updateReadouts(k: Kinematics) {
  const turnsOfDriver = phi / (2 * Math.PI);
  ui.turnValue.textContent = `${turnsOfDriver.toFixed(2)} turns`;
  for (const li of ui.speeds.children as HTMLCollectionOf<HTMLLIElement>) {
    const name = li.dataset.part!;
    const body = li.lastElementChild as HTMLSpanElement;
    const rotor = k.rotors.find((r) => r.name === name);
    const rack = k.racks.find((r) => r.name === name);
    let line = "";
    let live = "";
    if (rotor) {
      const ratio = Math.abs(rotor.ratio);
      if (rotor.direction === "driver") line = `the driver · ${nice(k.driver.rpm)} rpm`;
      else {
        const how = Math.abs(ratio - 1) < 1e-9 ? "same speed" : ratio > 1 ? `${nice(ratio)}× faster` : `${nice(1 / ratio)}× slower`;
        line = `${how}, ${rotor.direction === "same" ? "same way ↻" : "other way ↺"} · ${nice(ratio * k.driver.rpm)} rpm`;
      }
      live = `${(Math.abs(rotor.ratio) * turnsOfDriver).toFixed(2)} turns so far`;
    } else if (rack) {
      const d = poseAt(k, phi).slides.get(name)! - poseAt(k, 0).slides.get(name)!;
      const rotorRatio = k.rotors.find((r) => r.name === rack.rotor)!.ratio;
      line = `slides ${nice(Math.abs(rack.mmPerRad * rotorRatio * 2 * Math.PI))} mm per turn`;
      const end = poseAt(k, phi).slides.get(name)!;
      live = `moved ${d.toFixed(1)} mm${end < rack.minD || end > rack.maxD ? " · off the end of the rack!" : ""}`;
    }
    body.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = name;
    const span = document.createElement("span");
    span.textContent = ` — ${line}`;
    const liveSpan = document.createElement("span");
    liveSpan.className = "live";
    liveSpan.textContent = live;
    body.append(b, span, liveSpan);
  }
}

ui.turn.addEventListener("input", () => {
  setPlaying(false);
  phi = Number(ui.turn.value) * 2 * Math.PI;
  applyDrive();
});

let lastFrame = 0;
function frame(now: number) {
  if (!playing || !mechanism?.kinematics) return;
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;
  phi += dt * (mechanism.kinematics.driver.rpm / 60) * 2 * Math.PI * Number(ui.speed.value);
  const max = Number(ui.turn.max) * 2 * Math.PI;
  if (phi > max) phi -= max; // loop
  ui.turn.value = String(phi / (2 * Math.PI));
  applyDrive();
  requestAnimationFrame(frame);
}

function setPlaying(on: boolean) {
  playing = on;
  ui.play.textContent = on ? "❚❚ Pause" : "▶ Play";
  ui.play.setAttribute("aria-label", on ? "Pause" : "Play");
  if (on) {
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  }
}
ui.play.addEventListener("click", () => setPlaying(!playing));

// --- Selection, details and editing ----------------------------------------------------

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
  for (const li of ui.speeds.children as HTMLCollectionOf<HTMLLIElement>) li.style.outline = li.dataset.part === name ? "2px solid var(--accent)" : "";

  const node = name ? nodes.get(name) : undefined;
  ui.details.hidden = !node;
  if (node) {
    ui.detailsName.textContent = node.def.name;
    const k = mechanism?.kinematics;
    const sentence = k ? describeMotion(k).find((line) => line.startsWith(`"${node.def.name}"`)) : undefined;
    ui.detailsMotion.textContent = sentence ?? describeShape(node.def.shape);

    const s = node.def.shape;
    ui.edit.hidden = !(k && (s.type === "gear" || s.type === "pulley"));
    if (s.type === "gear") {
      ui.editLabel.textContent = "Teeth";
      ui.editValue.textContent = String(s.teeth);
    } else if (s.type === "pulley") {
      ui.editLabel.textContent = "Diameter (mm)";
      ui.editValue.textContent = String(s.diameter);
    }

    const linked = k?.rotors.some((r) => r.parts.includes(node.def.name));
    ui.joint.hidden = !(node.def.joint?.type === "rotating" && !linked);
    if (!ui.joint.hidden) {
      ui.jointLabel.textContent = `${node.def.name} angle`;
      const angle = Math.round(node.spin.userData.angle ?? 0);
      ui.jointAngle.value = String(angle);
      ui.jointValue.textContent = `${angle}°`;
    }
    node.listItem.scrollIntoView({ block: "nearest" });
  }
  render();
}

ui.jointAngle.addEventListener("input", () => {
  const node = selected ? nodes.get(selected) : undefined;
  if (!node) return;
  setJointAngle(node, Number(ui.jointAngle.value));
  ui.jointValue.textContent = `${ui.jointAngle.value}°`;
  render();
});

/**
 * Change the selected gear's teeth (or pulley's diameter) and rebuild. Parts the layout placed are placed again,
 * so the mechanism rearranges itself; if it no longer fits, say why and keep the old one.
 */
function edit(step: number) {
  const m = mechanism;
  const name = selected;
  if (!m || !name) return;
  const parts = m.parts.map((p) => {
    const copy = { ...p, position: p.autoPlaced ? undefined : p.position };
    if (p.name !== name) return copy;
    const s = p.shape;
    if (s.type === "gear") return { ...copy, shape: { ...s, teeth: Math.min(150, Math.max(8, s.teeth + step)) } };
    if (s.type === "pulley") return { ...copy, shape: { ...s, diameter: Math.min(1000, Math.max(5, s.diameter + 5 * step)) } };
    return copy;
  });
  const rebuilt = buildMechanism({ title: m.title, parts, links: m.links as LinkInput[], driver: m.driver });
  if ("issues" in rebuilt) {
    setStatus(`That does not fit: ${rebuilt.issues[0]?.message ?? "unknown problem"}.`, true);
    return;
  }
  const keepPhi = phi;
  showMechanism(rebuilt, true);
  phi = keepPhi;
  ui.turn.value = String(phi / (2 * Math.PI));
  applyDrive();
  setStatus(`Changed "${name}". Placed parts moved so everything still meshes.`);
}
ui.editMinus.addEventListener("click", () => edit(-1));
ui.editPlus.addEventListener("click", () => edit(1));

// Click (not drag) on the canvas selects the part under the cursor.
const pointerDown = new THREE.Vector2();
renderer.domElement.addEventListener("pointerdown", (e) => pointerDown.set(e.clientX, e.clientY));
renderer.domElement.addEventListener("pointerup", (e) => {
  if (pointerDown.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) > 4) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  let hit: THREE.Object3D | undefined = raycaster.intersectObjects(assembly.children, true)[0]?.object;
  while (hit && hit.userData.partName === undefined) hit = hit.parent ?? undefined; // markers belong to their gear
  const name = hit?.userData.partName as string | undefined;
  select(name === selected ? undefined : name);
});

// --- Camera ---------------------------------------------------------------

function fitView() {
  const box = new THREE.Box3().setFromObject(assembly);
  if (box.isEmpty()) return;
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
  // The bounding sphere is generous for long, flat layouts, so come in a little closer than it suggests.
  const distance = (radius / Math.sin(deg(camera.fov / 2))) * 0.8;

  camera.position.copy(centre).add(new THREE.Vector3(0.3, -1, 1.5).normalize().multiplyScalar(distance));
  camera.near = Math.max(distance / 1000, 0.01);
  camera.far = distance * 20;
  camera.updateProjectionMatrix();
  controls.target.copy(centre);
  controls.update();

  if (grid) {
    scene.remove(grid);
    grid.dispose();
  }
  const span = niceCeil(radius * 2.2);
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
// Exports the assembled pose (explode = 0, current angles) in millimetres. Belts are not exported.

function exportStl(): ArrayBuffer {
  const explode = Number(ui.explode.value);
  applyExplode(0);
  assembly.updateMatrixWorld(true);
  const markers: THREE.Object3D[] = [];
  assembly.traverse((o) => o.userData.partName === undefined && o instanceof THREE.Mesh && markers.push(o));
  markers.forEach((o) => (o.visible = false));
  const exportRoot = new THREE.Group();
  assembly.traverse((o) => o instanceof THREE.Mesh && o.userData.partName !== undefined && exportRoot.add(new THREE.Mesh(o.geometry.clone().applyMatrix4(o.matrixWorld))));
  markers.forEach((o) => (o.visible = true));
  const view = new STLExporter().parse(exportRoot, { binary: true }) as DataView;
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

const app = new App({ name: "maker-lab-model-viewer", version: "0.4.0" });
let connected = false;

function applyHostContext() {
  const ctx = app.getHostContext();
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  document.documentElement.dataset.display = ctx?.displayMode ?? "inline";
  ui.fullscreen.hidden = !ctx?.availableDisplayModes?.includes("fullscreen");
  ui.fullscreen.textContent = ctx?.displayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen";
}

/** Rebuild the mechanism from the tool result with the same shared code the server used. */
function load(data: { title?: string; parts: ResolvedPart[]; links?: LinkInput[]; driver?: { part: string; rpm: number } }) {
  const built = buildMechanism({ title: data.title, parts: data.parts, links: data.links ?? [], driver: data.driver });
  if ("issues" in built) {
    setStatus(`Could not rebuild the model: ${built.issues[0]?.message}`, true);
    return;
  }
  showMechanism(built);
  const k = built.kinematics;
  setStatus(
    k
      ? `${built.parts.length} parts. Press Play or drag "Turn" to make it move. Click a part to see how it moves; gears and pulleys have − and + buttons.`
      : `${built.parts.length} part${built.parts.length === 1 ? "" : "s"}. Drag to orbit, scroll to zoom, right-drag to pan.`,
  );
}

app.ontoolresult = (result) => {
  if (result.isError) {
    const text = result.content?.find((c) => c.type === "text")?.text;
    setStatus(text ?? "The tool returned an error.", true);
    return;
  }
  const data = result.structuredContent as Parameters<typeof load>[0] | undefined;
  if (!data?.parts?.length) {
    setStatus("No model data in the tool result.", true);
    return;
  }
  load(data);
};

app.onhostcontextchanged = applyHostContext;

ui.fullscreen.addEventListener("click", async () => {
  const mode = app.getHostContext()?.displayMode === "fullscreen" ? "inline" : "fullscreen";
  await app.requestDisplayMode({ mode });
});

if (window.parent === window) {
  // Opened directly in a browser (development): show the demo model.
  load(DEMO_MODEL as Parameters<typeof load>[0]);
} else {
  app
    .connect()
    .then(() => {
      connected = true;
      applyHostContext();
    })
    .catch((err: unknown) => setStatus(`Could not connect to the host: ${String(err)}`, true));
}
