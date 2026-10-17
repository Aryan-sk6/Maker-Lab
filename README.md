# Maker Lab

An MCP server with interactive widgets for ChatGPT and Claude, built on the open [MCP Apps](https://apps.extensions.modelcontextprotocol.io/) standard.

| Tool | What it does | Status |
|---|---|---|
| `render_3d_model` | 3D models and working mechanisms (gears, gear trains, belts and pulleys, rack and pinion) that you can turn, with speeds explained, editable tooth counts, exploded view and STL export | ✅ v0.4.0 |
| `run_simulation` | Physics/maths sandbox: pendulum, projectile, mass-spring-damper, RC/RLC, logistic growth, solved with RK4 | ✅ v0.2.0 |
| `show_molecule` | 3Dmol.js viewer for PDB IDs, compound names and SMILES (RCSB, PubChem) | ✅ v0.3.0 |

> **A hobby project.** Maker Lab is shared as is and maintained as time allows. It works in local testing, but it has not yet been tried inside real ChatGPT or Claude, so expect rough edges (menu names and host rules there change often). Issues and pull requests are welcome, with no promise of a quick reply.

> **Educational use only.** Maker Lab produces approximate visualisations. It makes no claim of accuracy, safety, or engineering or medical suitability.

## Quick start

```bash
git clone https://github.com/Aryan-sk6/Maker-Lab.git
cd Maker-Lab
npm install
npm run dev
```

Then open **http://localhost:8787/dev** to try all three tools in a local test host (no ChatGPT or Claude needed). To use Maker Lab inside ChatGPT or Claude it has to be reachable over public HTTPS; see [Expose it over HTTPS](#expose-it-over-https-tunnel) and [Connect it](#connect-it) below.

## Requirements

- Node.js 20 or newer (tested on Node 26)
- For ChatGPT or Claude: a public HTTPS URL, either a deployment or a tunnel such as [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) (`brew install cloudflared`)

## Install and run

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` builds the widgets, then starts the server with auto-restart on `http://127.0.0.1:8787/mcp`. If you edit a widget, run `npm run build:widgets` again; the dev server picks up the new file without a restart.

Other scripts:

| Script | Purpose |
|---|---|
| `npm test` | Unit and protocol tests (Vitest) |
| `npm run typecheck` | TypeScript check of server, shared code and widgets |
| `npm run build` | Build widgets and compile the server to `dist/` |
| `npm start` | Run the compiled server (`NODE_ENV=production` recommended) |

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` when deploying. |
| `ALLOWED_HOSTS` | localhost names when bound to localhost | Comma-separated `Host` header values to accept (DNS-rebinding protection), e.g. `maker-lab.example.com` |
| `NODE_ENV` | (unset) | `production` caches widget HTML and disables the `/dev` test host |

### Try it locally without ChatGPT or Claude

With `npm run dev` running, open **http://localhost:8787/dev**. This small test host calls a tool on your server, renders the widget in a sandboxed iframe with the widget's declared CSP applied, and talks to it over the MCP Apps bridge, like ChatGPT and Claude do. Edit the JSON arguments and press **Call tool**.

You can also serve `dist/widgets/` from any static server and open `model-viewer.html`, `simulation.html` (add `?system=rlc_circuit` to pick a system) or `molecule.html` (add `?pdb=1CRN` or `?cid=2519`) to see a widget with demo data. The molecule page downloads its structure live from RCSB or PubChem, so it needs internet access.

### Expose it over HTTPS (tunnel)

ChatGPT and Claude connect from their own servers, so `localhost` is not reachable for them. With the server running (`npm run dev`), open a second terminal:

```bash
npm run tunnel
```

This runs [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) (install it first, e.g. `brew install cloudflared`) and prints a URL like `https://random-words.trycloudflare.com`. Your MCP endpoint is that URL plus `/mcp`. The URL changes every time you restart the tunnel.

The script passes `--http-host-header localhost:8787` so that tunnelled requests look local to the server's DNS-rebinding check; without it the server answers 403. That check also rejects any request that carries an `Origin` header (browsers send one; server-to-server connectors normally do not). If a client still gets 403, stop the server and start it with your tunnel's hostname allowed instead, which accepts that host and rejects all others:

```bash
HOST=0.0.0.0 ALLOWED_HOSTS=random-words.trycloudflare.com npm run dev
```

(Use the hostname cloudflared printed, without `https://`.)

### Deploy

Any Node host with HTTPS works (Render, Railway, Fly.io, a VM behind a reverse proxy):

```bash
npm ci && npm run build
```

```bash
NODE_ENV=production HOST=0.0.0.0 ALLOWED_HOSTS=maker-lab.example.com npm start
```

## Connect it

### ChatGPT (Developer Mode)

Menu names have moved several times during the beta; these are the steps as of October 2026. Check [OpenAI's guide](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt) if they differ.

1. Turn on **Developer mode** in ChatGPT settings (under Apps / Connectors → Advanced, or Security on some accounts). Workspace plans may need an admin to allow it.
2. Go to **chatgpt.com/plugins** → **+** → **Add custom MCP server**.
3. Enter a name ("Maker Lab"), a description, and your URL ending in `/mcp`. Choose **no authentication**.
4. Confirm the risk warning, create it, and check that `render_3d_model` is listed.
5. In a new chat, type `@` and pick Maker Lab, or just ask for a 3D model.
6. After changing the server, press **Refresh** on the connection and start a new chat.

### Claude

claude.ai renders MCP Apps for custom connectors ([Anthropic's connector docs](https://claude.com/docs/connectors/overview)).

1. Go to **Settings → Connectors** (or **Customize → Connectors**) → **Add custom connector**.
2. Enter a name and your URL ending in `/mcp`, then **Add**. No authentication is needed.
3. In a chat, enable the connector from the tools menu and ask for a model.

Claude reaches connectors from Anthropic's cloud, so the URL must be public (a tunnel is fine).

## Tools

### `render_3d_model`

Builds 3D models, and mechanisms that really work: turn the driver and every gear, pulley and rack moves at the right speed. It is designed so that a vague request ("make a big gear turn a little one") is enough. The model only has to name the parts and say how they connect; Maker Lab does the geometry.

**What you can build**

| Part | Shape fields (defaults) |
|---|---|
| `gear` | `teeth` (20), `module` = tooth size (2 mm), `thickness` (6), optional `bore` |
| `pulley` | `diameter` (40), `width` (10), optional `bore` |
| `rack` (a toothed bar that slides) | `length` (120), `module` (2), `height` (12), `thickness` (6) |
| `box`, `cylinder`, `sphere`, `cone`, `bracket` | sizes in mm (no defaults) |

| Link | Meaning |
|---|---|
| `{"type":"mesh","a":…,"b":…}` | two gears' teeth interlock; they turn opposite ways |
| `{"type":"axle","a":…,"b":…}` | b is fixed on a's axle; they turn together (for gear trains) |
| `{"type":"belt","a":…,"b":…}` | a belt joins two pulleys; same direction (or `"crossed": true` for opposite) |
| `{"type":"rack","pinion":…,"rack":…}` | a gear turns, the rack slides |

Optional `"driver": {"part": …, "rpm": 30}` chooses which part you turn; otherwise the first link's first part drives.

The shortest valid mechanism:

```json
{ "parts": [ { "name": "big", "shape": { "type": "gear", "teeth": 40 } },
             { "name": "small", "shape": { "type": "gear", "teeth": 10 } } ],
  "links": [ { "type": "mesh", "a": "big", "b": "small" } ] }
```

**What Maker Lab works out for you**

- **Placement:** linked parts without a `position` are placed at exactly the right distance (for gears, module × (teeth₁ + teeth₂) / 2), in the same plane, in a direction that does not crash into parts already placed.
- **Joints and colours:** linked gears and pulleys are made free to turn; parts get distinct colours.
- **Motion:** the speed and direction of every part, from tooth counts and pulley sizes, with the teeth timed so they interlock. Gear loops that would jam, gears of different tooth sizes, gears placed by hand at the wrong distance, and mismatched link types are reported with the exact fix.
- **Explanation:** the result includes one plain sentence per moving part, e.g. *"small" turns 4 times for every turn of "big", the other way (120 rpm).* The model uses these instead of doing the maths itself.

**Widget**

- **Turn it:** ▶ Play, or drag the "Turn" slider. A white mark on each wheel (and orange marks on belts) makes speeds visible.
- **Speeds panel:** for every moving part, "3× slower, other way, 20 rpm" and how many turns it has made so far; racks show how far they have moved, and warn if they run off the end.
- **Experiment:** click a gear and press − / + to change its teeth (or a pulley's diameter). Parts that were placed automatically move so everything still meshes, and all speeds update. This is the "what happens if…" part for students.
- Also: orbit/zoom/pan, exploded view, click-to-select, and **Download STL** (binary, mm; belts are not included).

Static models (no links) work as before: give each part a `position` [x, y, z] in mm and a `rotation` in degrees, Z up; `parent` attaches one part to another.

Example prompts (they work even phrased loosely):

- "Make a big gear turn a small gear."
- "Show me how a bike's chain makes the back wheel spin faster than the pedals." (pulleys and a belt)
- "Build a gear train that slows a motor down 9 times." (gear, axle, gear)
- "How does turning a steering wheel move a rack?" (rack and pinion)
- "Model a 60 × 40 × 25 mm project box with four 3 mm corner posts, then explode it."

### `run_simulation`

Solves a simple system numerically and shows an interactive plot. **The numbers come from the solver, not from the model**: the server runs a fixed-step fourth-order Runge–Kutta (RK4) and returns key values and sampled points; the widget runs the same code again when you move a slider.

| `system` | Equation | Parameters (units, default) |
|---|---|---|
| `pendulum` | θ'' = −(g/L)·sin θ − b·θ' | `length_m` (1), `gravity_ms2` (9.81), `theta0_deg` (30), `omega0_rads` (0), `damping_per_s` (0) |
| `projectile` | a = −g·ŷ − k·v, ends on landing | `speed_ms` (20), `angle_deg` (45), `height0_m` (0), `gravity_ms2` (9.81), `drag_per_s` (0) |
| `mass_spring_damper` | m·x'' + c·x' + k·x = 0 | `mass_kg` (1), `stiffness_Npm` (20), `damping_Nspm` (1), `x0_m` (0.1), `v0_ms` (0) |
| `rc_circuit` | RC·dV_C/dt = V_s − V_C | `voltage_V` (5), `resistance_ohm` (1000), `capacitance_F` (1e-6), `vc0_V` (0) |
| `rlc_circuit` | L·di/dt = V_s − R·i − V_C, C·dV_C/dt = i | `voltage_V` (5), `resistance_ohm` (10), `inductance_H` (1e-3), `capacitance_F` (1e-6), `vc0_V` (0), `i0_A` (0) |
| `logistic_growth` | dN/dt = r·N·(1 − N/K) | `growth_rate` (0.5), `capacity` (1000), `population0` (10) |

Every parameter has a validated range (see the tool's schema). Optional `duration` (seconds; "time units" for logistic growth) defaults to a window that shows the whole behaviour.

- **Solver and limits:** classical RK4, fixed step = 1/100 of the system's fastest time scale, at most 100 000 steps per run. If a requested duration needs more, the error says what the longest allowed duration is.
- **Key values:** period, range, maximum height, damping ratio, time constant, overshoot, settling time and so on. Each is labelled *from the solution* (read off the RK4 result) or *formula* (closed form, shown for comparison).
- **Widget:** plot with hover read-out and alternative views; a slider and number box per parameter plus simulated time; play/pause, time scrubber and speed for the pendulum (with a drawing of the rod) and the projectile; the list of assumptions under the plot; the label "Educational model with simplifying assumptions."

Example prompts:

- "Simulate a 2 m pendulum released from 60° and tell me its period. How far off is the small-angle formula?"
- "A ball is kicked at 25 m/s at 35°. How far does it go with and without air drag?"
- "I have a 4.7 kΩ resistor and a 10 µF capacitor on 3.3 V. How long until it is 98% charged?"
- "Is a 10 Ω, 1 mH, 1 µF series RLC circuit underdamped? How much does it overshoot?"
- "Show logistic growth for a population of 50 with capacity 2000 and rate 0.3."

### `show_molecule`

Shows a protein, nucleic acid or small molecule in 3D. Give **exactly one** of:

| Input | Source | What you get |
|---|---|---|
| `pdb_id` (4 characters, e.g. `4HHB`) | [RCSB PDB](https://www.rcsb.org/) | An experimental model: proteins, DNA/RNA, complexes. The `.pdb` file, or `.cif` for large entries that have no PDB-format file. |
| `compound_name` (e.g. `caffeine`) | [PubChem](https://pubchem.ncbi.nlm.nih.gov/) | A small molecule's computed 3D conformer. |
| `smiles` (e.g. `CC(=O)OC1=CC=CC=C1C(=O)O`) | PubChem | The same, looked up by structure. |

- **No guessing.** If PubChem has no such name, or the SMILES cannot be parsed, or the compound has no 3D record (large molecules, salts), or a name matches several compounds, the tool says so. For several matches it lists up to five candidates with their SMILES so the model can retry with a more specific name or the right SMILES. Unknown PDB IDs and entries over 120 000 atoms are refused with a message.
- **Honest labels.** PubChem shapes are computed conformers (one plausible shape), not experimental structures; PDB entries are experimental models with a resolution you should check. The panel shows this, plus name, formula, mass, details and a link to the source page. PDB entries have no single formula, so the panel says so.
- **Widget:** stick / sphere / cartoon (cartoon only for structures with a protein or nucleic-acid backbone), colour by element or by chain (chains only where they exist), spin, reset view. Cartoons show ligands as ball-and-stick and hide water. In cartoon style "element" colouring shows secondary structure, since a ribbon has no atoms to colour.
- **Caching and limits:** lookups are cached in memory for an hour (not-found answers for five minutes). Requests to PubChem are spaced at most 4 per second and 300 per minute (PubChem's published limits are 5 and 400); if PubChem reports heavy load the server backs off. A first lookup of a new compound takes a few seconds because of this spacing; repeats take milliseconds.
- **Where the data flows:** the server looks the identifier up and checks that a structure exists. The widget then downloads the structure file itself from `files.rcsb.org` or `pubchem.ncbi.nlm.nih.gov`, the only two hosts in its Content Security Policy, so large files do not pass through the model or the server.

Example prompts:

- "Show me caffeine in 3D and explain which atoms are nitrogen."
- "Show haemoglobin (4HHB) as a cartoon coloured by chain. How many chains does it have?"
- "What does the amino acid L-alanine look like? Use this SMILES: C[C@@H](C(=O)O)N"
- "Show me crambin, PDB 1CRN, and tell me how well resolved it is."

## Known limitations

- **Approximate geometry.** Gears and racks have no undercut, root fillet or backlash; there are no fillets, chamfers, holes (except gear bores) or threads. Parts can overlap; the STL is the union of separate shells, not a single solid. Check it in your slicer.
- **Simulations are simplified.** Each system lists its assumptions: point masses, ideal components, viscous (linear) damping and drag, uniform gravity, closed deterministic populations. Real air drag is closer to v² than to the linear drag used here. Results are for learning, not for design or safety decisions.
- **Molecules need the internet twice.** The server must reach RCSB and PubChem to resolve a lookup, and the host must let the widget download from the two data hosts; if a host blocks that, the widget shows a message with the source link. Public services can be slow or busy; the server reports that rather than failing silently.
- **Molecule detail is limited.** Only the first model of multi-model (NMR) entries is shown, waters are hidden, there are no surfaces or measurements, and entries above 120 000 atoms are refused. PubChem name matching is PubChem's, not ours: a name it does not know is reported as not found.
- **Slider changes stay in the widget.** After you drag a slider the model is not told the new values; ask it to run the tool again if you want it to discuss the new case with fresh numbers.
- **Mechanisms are ideal and flat.** Spur gears with parallel axles only (no bevel, worm or planetary gears, no gears riding on other turning parts), belts without slip or stretch, no friction, backlash, forces or torque. Gears with fewer than 12 teeth are drawn approximately (real ones need specially shaped teeth). Unlinked parts are not checked for collisions; overlaps between round parts are only reported as notes.
- **Downloads depend on the host.** STL export uses the MCP Apps `ui/download-file` request when the host supports it. Otherwise it tries a normal browser download, which some sandboxes block.
- **Preview SDKs.** MCP Apps and the ChatGPT Apps SDK are still changing; menu paths and metadata keys may move.
- **Not checked in a real host.** So far this has been tested with the local `/dev` host, unit tests and an HTTP client, not yet inside ChatGPT or Claude.

## Privacy

Maker Lab has no accounts, no analytics and no tracking. The server is stateless: each request is handled by a fresh instance and nothing from your conversations is stored or logged beyond standard error output. The 3D model viewer and the simulation widget make no network requests: STL files are generated in your browser and simulations run in it.

The molecule tool is different: it sends the identifier you ask about (PDB ID, compound name or SMILES) to RCSB or PubChem, and your browser then downloads the structure file from them directly, so those services see your IP address and the request, as with any website. To avoid repeat requests the server keeps lookups in memory for up to an hour: the identifier and the public result it fetched. Nothing is written to disk or logged, the cache is shared by everyone using the same server, and it disappears when the server restarts.

## Credits

- [Three.js](https://threejs.org/) (MIT): 3D rendering, `OrbitControls` and `STLExporter`.
- [3Dmol.js](https://3dmol.csb.pitt.edu/) (BSD-3-Clause): molecule viewer. If you use it in research, cite Rego & Koes, *3Dmol.js: molecular visualization with WebGL*, Bioinformatics 31(8), 2015.
- [RCSB Protein Data Bank](https://www.rcsb.org/) (structure files and entry data; PDB archive data are released under CC0) and [PubChem](https://pubchem.ncbi.nlm.nih.gov/) (NCBI; compound data and computed 3D conformers). Please follow their usage policies, including PubChem's request limits, which this server respects.
- [Model Context Protocol](https://modelcontextprotocol.io/) TypeScript SDK (Apache-2.0) and [MCP Apps SDK](https://github.com/modelcontextprotocol/ext-apps) (MIT).
- [zod](https://zod.dev/) (MIT), [Vite](https://vite.dev/) (MIT), [vite-plugin-singlefile](https://github.com/richardtallent/vite-plugin-singlefile) (MIT), [Express](https://expressjs.com/) (MIT).

### Adapted snippets

No code was copied from other repositories. These parts follow official documentation examples:

- `server/index.ts`: the `createMcpHandler` + `toNodeHandler` mounting pattern from the `@modelcontextprotocol/server` and `@modelcontextprotocol/node` API docs.
- `server/tools/render3d.ts`: `registerAppTool` / `registerAppResource` usage from the [MCP Apps migration guide](https://apps.extensions.modelcontextprotocol.io/api/documents/Migrate_OpenAI_App.html).
- `widgets/model-viewer/main.ts`: the `app.downloadFile` embedded-blob request from the `App.downloadFile` doc comment in `@modelcontextprotocol/ext-apps`.
- `widgets/dev-host/main.ts`: the `AppBridge` + `PostMessageTransport` setup from the `AppBridge` doc comment in `@modelcontextprotocol/ext-apps`.
- `server/molecule/lookup.ts`: request shapes and limits follow PubChem's [PUG REST documentation](https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest) and usage policy (5 requests per second, 400 per minute) and RCSB's public data API; every response format was checked against the live services.
- `widgets/molecule/main.ts`: 3Dmol.js calls (`createViewer`, `addModel`, `setStyle`, `spin`, selections and colour schemes) follow the 3Dmol.js documentation.
- `widgets/model-viewer/gear.ts`: written from the standard involute-gear formulas (see comments), not from existing code.
- `shared/solver.ts`: the classical RK4 formulas (Kutta, 1901) and Gauss's arithmetic–geometric mean for the exact pendulum period, written from the textbook definitions. The closed-form solutions used in `shared/systems.test.ts` are standard results (damped oscillator, RC and RLC step responses, logistic curve, projectile with linear drag).

## License

[MIT](LICENSE)
