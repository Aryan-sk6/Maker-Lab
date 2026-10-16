# Architecture

Maker Lab is one small Node.js server plus one HTML file per tool. This page explains how the pieces fit, in the order a request flows through them.

## The big picture

```
 ChatGPT / Claude (the "host")
   │  1. tools/list, tools/call         ▲  4. text summary + structuredContent
   ▼                                    │
 ┌──────────────────────────── server/ ───────────────────────────┐
 │ index.ts   Express app, POST /mcp → createMcpHandler (stateless)│
 │ mcp.ts     builds a fresh McpServer per request                 │
 │ tools/     one file per tool: zod schema in, result out         │
 │ widgets.ts reads dist/widgets/<name>.html                       │
 └────────────────────────────────────────────────────────────────┘
   │  2. resources/read ui://maker-lab/model-viewer-v1.html
   ▼
 Host puts the HTML in a sandboxed iframe, applies the CSP from _meta.ui.csp
   │  3. postMessage (MCP Apps bridge): ui/initialize,
   │     ui/notifications/tool-input, ui/notifications/tool-result
   ▼
 ┌──────────────────────────── widgets/ ──────────────────────────┐
 │ model-viewer/  Three.js scene, built into one self-contained   │
 │ simulation/    canvas plot + sliders + the same RK4 solver     │
 │ molecule/      3Dmol.js; downloads the structure file itself   │
 │                (each built into one HTML file by build.mjs)     │
 └────────────────────────────────────────────────────────────────┘
```

## 1. The MCP server (`server/`)

- **Transport.** `server/index.ts` mounts `createMcpHandler` from `@modelcontextprotocol/server` at `/mcp`, adapted to Express with `toNodeHandler` from `@modelcontextprotocol/node`. It serves the current protocol revision and falls back to plain stateless Streamable HTTP for older clients.
- **Stateless.** Every request gets a new `McpServer` from `createMakerLabServer()`. Nothing is kept between requests, which is why there are no sessions, no user data and nothing to clean up. It also means the server scales horizontally with no shared state.
- **Host checks.** `createMcpExpressApp` adds DNS-rebinding protection. Bound to `127.0.0.1` it only accepts `Host: localhost`; when deployed, set `HOST=0.0.0.0` and `ALLOWED_HOSTS=your.domain`.
- **`/dev`.** Outside production, the server also serves a tiny test host (`widgets/dev-host`). See section 4.

## 2. A tool (`server/tools/render3d.ts`)

Each tool file registers two things using helpers from `@modelcontextprotocol/ext-apps/server`:

1. **A UI resource** (`registerAppResource`) at a `ui://` URI with MIME type `text/html;profile=mcp-app`. Its `_meta.ui.csp` lists the only network origins the widget may use (`connectDomains` for fetch, `resourceDomains` for scripts/images/fonts). The 3D viewer needs none, so both lists are empty. The URI ends in `-v1`: hosts cache by URI, so a breaking widget change gets a new URI.
2. **The tool** (`registerAppTool`) with:
   - `description`: tells the model *when* to call it, the units, the coordinate frame and each shape's origin, so it can place parts without guessing.
   - `inputSchema`: the zod schema from `shared/model3d.ts`. The SDK validates arguments before the handler runs; if they fail, the host gets an `isError` result whose text lists each bad field and how to fix it, and the model can retry.
   - `annotations`: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false` (it changes nothing and touches no external system).
   - `_meta.ui.resourceUri`: links the tool to its widget. The helper also adds the older flat `ui/resourceUri` key for hosts that still read it.
   - The handler returns `content` (a plain-text summary, so clients without widgets still get something useful) and `structuredContent` (the validated, defaults-filled model the widget renders).

## 3. Shared code (`shared/`)

- `model3d.ts`: the zod schema, the hard limits (50 parts, 0.1–1000 mm), cross-field checks (unique names, parents exist, no cycles, gear and bracket sanity) and the text summary. Used by the server; the widget only imports its *types*.
- `describe3d.ts`: one-line part descriptions, used by both server and widget. It has no zod import, so the widget bundle stays small.

## 4. Widgets (`widgets/`)

- **Build.** `widgets/build.mjs` runs Vite with `vite-plugin-singlefile` for each widget and writes `dist/widgets/<name>.html` with all JS/CSS (including Three.js) inlined. One file means no CDN, no CORS and an empty CSP allow-list.
- **Talking to the host.** `model-viewer/main.ts` creates `new App(...)` from `@modelcontextprotocol/ext-apps`, sets `app.ontoolresult` and calls `app.connect()`. The SDK does the `ui/initialize` handshake over `postMessage` and calls `ontoolresult` with the tool's `structuredContent`. Theme and display mode come from `app.getHostContext()` and `onhostcontextchanged`. No `window.openai` is used: everything goes through the open standard.
- **Downloads.** Sandboxed iframes may not be allowed to download files, so "Download STL" first asks the host via `app.downloadFile` (`ui/download-file`) if the host advertises that capability, and only falls back to a normal browser download otherwise.
- **Standalone mode.** Opened directly in a browser (no parent window), the viewer shows a demo model so you can work on it without a host.
- **`dev-host/`.** A minimal host that uses `AppBridge` from `@modelcontextprotocol/ext-apps/app-bridge`: it calls a tool on the local server, loads the widget into `<iframe sandbox="allow-scripts">` with a CSP built from `_meta.ui.csp`, and forwards the tool input/result. It catches missing CSP domains and bridge mistakes before you go to ChatGPT or Claude.

## 5. The 3D viewer in detail

- **Frame.** Z-up, millimetres, matching most CAD tools and slicers, so the exported STL needs no rotation.
- **Geometry** (`geometry.ts`). Three.js primitives are Y-up, so cylinders and cones are rotated onto Z. The L-bracket is a 2D L profile extruded by its width. The gear outline (`gear.ts`) is computed from involute-gear definitions (pitch radius m·z/2, base radius r·cos 20°, addendum m, dedendum 1.25m, tooth half-angle π/2z + inv α − inv φ) and extruded, with an optional bore hole. There is no undercut or root fillet, which is one reason the model is "approximate".
- **Scene graph.** Each part is `outer group (position, rotation, explode offset) → spin group (joint angle) → mesh`. A child's `outer` is added to its parent's `spin` group, so children turn with rotating parents.
- **Exploded view.** Each child slides along its joint axis (in the parent's frame), away from the parent; top-level parts move away from their common centre. The distance is the slider value × 35% of the model's largest dimension.
- **STL.** `STLExporter` (shipped with Three.js) writes a binary STL of the assembled pose (explode reset to 0, current joint angles) in mm.

## 6. Simulation (tool 2)

**The rule: the model never supplies a number.** It picks a system and parameters; the solver produces everything else.

- `shared/solver.ts`: `integrateRK4`, a classical fourth-order Runge–Kutta with a fixed step, plus helpers to read a solution (zero crossings, settling time, maxima). For projectiles it stops when the height crosses 0 and refines the last partial step with Newton's method so the landing point is exact.
- `shared/systems.ts`: one definition per system with its parameters (unit, default, range, slider scale), assumptions, differential equations, **time scales**, key values, plot views and table columns. It has no zod and no DOM, so both the server and the widget import it.
- **Choosing the step.** Each system computes its fastest rate (the largest pole of the linearised equations, for the pendulum also its fastest swing speed) and uses `dt = 1/(100 × rate)`. A default duration comes from the slowest behaviour (about 8 oscillations, or until the envelope has decayed to about 0.25%, or 6τ for first-order systems). A run is capped at 100 000 steps; an explicit duration that needs more is rejected with the longest allowed one, while an automatic duration is simply shortened.
- `planSimulation` validates parameter names and ranges, runs cross-field checks (a projectile already on the ground), fills in defaults and picks `dt` and `steps`. `shared/simulation.ts` wraps it in zod (`superRefine`), so one rule set produces the model-facing error messages and also limits the widget's sliders.
- **Tool result** (`server/tools/simulation.ts`): the resolved parameters, key values (each marked `numerical` or `formula`), nine sampled points and the assumptions, about 2 KB. It deliberately does not send the full curve: the widget re-solves from the parameters, so identical code gives identical numbers on both sides.
- **Widget** (`widgets/simulation/`): `main.ts` keeps `params` and `durationFactor`; every slider `input` calls `recompute()` → `planSimulation` → `solve` → redraw (about a millisecond for thousands of steps). `plot.ts` is a small canvas plot (nice ticks, SI-prefixed axes, reference lines, hover, animation cursor). The pendulum also draws a rig; play/pause moves a cursor along the solution by real elapsed time × speed.
- **Why a flat parameter bag.** The tool takes `system` plus a `parameters` object with every possible parameter name as an optional number, rather than a union per system. ChatGPT requires the input schema to be a plain object at the top level; per-system checks happen in `planSimulation`, which names the valid parameters when a wrong one is sent.

## 7. Molecules (tool 3)

The only tool that talks to other services, so it has the most moving parts.

- **Who does what.** The **server** (`server/molecule/lookup.ts`) turns the identifier into a verified, citable structure URL: does the PDB entry exist, is there a 3D conformer for the compound, what is its name, formula and mass. The **widget** then downloads the structure file itself from that URL. Large PDB files never pass through the server or the model, and the widget's Content Security Policy names exactly the two hosts it needs: `https://files.rcsb.org` and `https://pubchem.ncbi.nlm.nih.gov` (`_meta.ui.csp.connectDomains`). I checked that the CSP is enforced (a fetch to an unlisted host fails inside the sandboxed frame) and that both hosts answer plain cross-origin GETs with `access-control-allow-origin: *`; the widget sends no custom headers so there is no preflight.
- **PDB.** `GET data.rcsb.org/rest/v1/core/entry/{ID}` gives title, method, resolution, atom count and `pdbx_database_status.pdb_format_compatible`. If that flag is `N` (very large entries), the file is `{ID}.cif`, otherwise `{ID}.pdb`. A 404 means no such entry. Entries over 120 000 atoms are refused. (A HEAD request to the file server would not work for this: it returns no length, and CloudFront rejects HEAD requests that carry an `Origin` header.)
- **PubChem.** Names and SMILES are sent in a POST body to `/compound/{name|smiles}/cids/JSON`, so special characters need no URL escaping. The answer is a list of CIDs: none (404, or CID 0) → "not found"; more than one → list candidates and refuse to choose; exactly one → fetch `/compound/cid/{cid}/SDF?record_type=3d` (a 404 means no 3D record) and `/property/…/JSON` for name, formula, mass, SMILES. Fetching the SDF on the server also gives the atom count from the file's counts line.
- **Caching.** A small `TtlCache` stores *promises*, so concurrent identical lookups share one request. Successful answers last an hour, "not found" answers five minutes, and transient failures (network, 503) are not stored.
- **Rate limiting.** One `Limiter` per host reserves request slots: at least 250 ms apart for PubChem (4 per second) and a hard cap of 300 per minute, 200 ms and 600 per minute for RCSB. PubChem's `X-Throttling-Control` header is read after each answer: Yellow doubles the spacing for a minute, Red or Black blocks new requests for a minute. The cache and limiters are module-level singletons, because the MCP server itself is rebuilt for every request.
- **Errors.** Everything the caller can fix is a `LookupError` whose message says how, and the tool returns it as `isError`. Anything else is a real bug and propagates.
- **Input.** `show_molecule` takes three optional strings and requires exactly one non-empty (`superRefine`), because ChatGPT needs a plain object schema and models often send `""` for unused fields.
- **Widget** (`widgets/molecule/main.ts`). Styles are applied with `viewer.setStyle` and selections such as `{hetflag:false}` (polymer), `{resn:'HOH', invert:true}` (everything but water) and `{and:[{hetflag:true}, …]}` (ligands). Cartoon and chain colouring are enabled only when the file has non-hetero atoms. 3Dmol.js is bundled; its source contains one `eval` (in a py3Dmol helper that runs only when a callback is passed as a string), which this widget never triggers, so a CSP without `unsafe-eval` is fine.
- **Tests** run against a fake `fetch` and a fake clock, using response shapes recorded from the live services, so they never touch the network.

## 8. Tests

`npm test` runs Vitest:

- `shared/model3d.test.ts`: every validation rule and its message.
- `widgets/model-viewer/geometry.test.ts`: gear radii and winding, primitive sizes and orientation, STL byte layout.
- `shared/systems.test.ts`: the solver against closed-form solutions (pendulum small-angle, damped and exact large-amplitude period; projectile with and without drag; mass-spring-damper in all regimes; RC charging; RLC step response; logistic growth), RK4's fourth-order convergence, and the step/duration limits.
- `shared/simulation.test.ts`: input validation messages for `run_simulation`.
- `server/molecule/lookup.test.ts`: the lookup logic against a fake network and clock: PDB and PubChem success, mmCIF selection, not found, ambiguity, no 3D record, size limit, caching, transient failures, request spacing, the per-minute cap and PubChem's throttling header.
- `shared/molecule.test.ts`: input validation for `show_molecule`.
- `server/mcp.test.ts`: a real MCP client connected in memory, checking all three tools' listing, widget resources, CSP (including the exact molecule hosts), results and error text. Only paths that make no network request are exercised there.

## What is ChatGPT-specific?

Nothing so far. The server and widget use only MCP and MCP Apps keys, which both ChatGPT and Claude read. `window.openai` extensions (for example `widgetState`) would be added only behind a feature check, if a later tool needs them.
