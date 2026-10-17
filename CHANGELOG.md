# Changelog

All notable changes to Maker Lab. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-10-17

### Added
- Working mechanisms in `render_3d_model`: new `pulley` and `rack` parts, and `links` (`mesh`, `axle`, `belt`, `rack`) with an optional `driver`.
- Automatic layout (`shared/mechanism.ts`): linked parts without a position are placed at exactly the right distance in a free direction; linked gears and pulleys are made free to turn; colours and shape sizes default sensibly. A two-gear mechanism needs only two names and one link.
- Motion solver (`shared/kinematics.ts`): speed ratio, direction and tooth timing for every part, rack travel, belt length, and clear errors for jammed loops, different tooth sizes, wrong distances and wrong link types (with the fix).
- Plain-language motion in the tool result ("small turns 4 times for every turn of big, the other way") and structured `motion` data.
- Widget: Play / Turn slider, speed panel with live turn counts, white marks on wheels and moving marks on belts, belt drawing, and − / + buttons to change a gear's teeth or a pulley's size, after which the mechanism re-lays itself out.
- Tests that turn mechanisms through a full revolution and check geometrically that teeth never pass through each other.

### Changed
- Gears: 8–150 teeth (was 6–200), module 0.5–20 mm, with defaults (20 teeth, module 2, 6 mm). Positions and colours are optional. Rotating joints no longer need a parent.
- Widget resource is now `ui://maker-lab/model-viewer-v2.html` (hosts cache by URI).
- Tool description rewritten for vague, child-level requests, with recipes.

### Fixed
- `npm run tunnel` now passes `--http-host-header localhost:8787`; before, tunnelled requests were rejected with 403 by the DNS-rebinding check.

### Changed
- README: added a Quick start (clone, install, run) and rewrote the tunnel section, including the `ALLOWED_HOSTS` alternative.
- LICENSE copyright holder is now Aryan SK.

## [0.3.0] - 2026-10-17

### Added
- `show_molecule` tool: give exactly one of a PDB ID, a compound name or a SMILES string. PDB entries come from RCSB (`.pdb`, or `.cif` for entries that have no PDB-format file); compounds are resolved through PubChem PUG REST to a computed 3D conformer (SDF). Empty strings for the unused fields are ignored, because models often send them.
- Clear messages instead of guesses: unknown PDB ID, unknown name, unparsable SMILES, compound with no 3D record, entries over 120 000 atoms, and names that match several compounds (the first five candidates are listed with their SMILES so the model can retry).
- In-memory lookup cache (1 hour; "not found" answers for 5 minutes; concurrent identical lookups share one request) and per-host request spacing. PubChem is limited to 4 requests per second and 300 per minute, below its published 5 and 400, and the server backs off when PubChem reports Yellow/Red/Black load in `X-Throttling-Control`.
- Molecule widget (3Dmol.js 2.5.5, bundled): stick, sphere and cartoon styles, colour by element or chain, spin, reset view, name/formula/mass/details panel with a source link, ligands drawn as ball-and-stick on cartoons, water hidden. The widget downloads the structure itself; its CSP allows exactly `https://files.rcsb.org` and `https://pubchem.ncbi.nlm.nih.gov`.
- Tests with a fake network and clock (22 lookup tests: not found, ambiguity, caching, throttling, failures) and for input validation and the tool's metadata and CSP.
- `?pdb=` and `?cid=` options for the standalone widget preview; `show_molecule` example in the `/dev` test host.

### Changed
- Package version 0.3.0; the server now registers three tools.

## [0.2.0] - 2026-10-16

### Added
- `run_simulation` tool: simple pendulum (nonlinear, optional damping), projectile (optional linear drag), mass-spring-damper, series RC, series RLC and logistic growth. Parameters have units, defaults and ranges; invalid input returns a per-field message the model can act on.
- Fixed-step RK4 solver (`shared/solver.ts`). The step is 1/100 of the system's fastest time scale and a run takes at most 100 000 steps. Projectile landing is located exactly with a Newton refinement of the last step.
- Simulation widget: canvas plot with SI-prefixed axes, hover read-out, alternative views (e.g. phase portrait), a slider and number box for every parameter plus simulated time (the same solver re-runs locally on each change), play/pause with a time scrubber and speed control for the pendulum (with a rig drawing) and the projectile, key-value read-outs labelled "from the solution" or "formula", and the assumptions list for each system.
- The tool result carries the solver's key values and nine sampled points, so the model can quote real numbers and clients without widgets still get a full text report.
- Tests against closed-form solutions: small-angle and damped pendulum, exact large-amplitude period (AGM), projectile with and without drag, mass-spring-damper (under-, critically and over-damped), RC charging, RLC step response (under- and over-damped, overshoot formula), logistic growth.
- `?system=` option for the standalone widget preview; `run_simulation` example in the `/dev` test host.

### Changed
- Widgets: `hidden` now always wins over component display rules.

## [0.1.0] - 2026-10-16

### Added
- MCP server on Streamable HTTP at `/mcp` (stateless, one server instance per request), built on MCP TypeScript SDK 2.x and MCP Apps (`@modelcontextprotocol/ext-apps` 2.0.3).
- `render_3d_model` tool: zod-validated parametric parts (box, cylinder, sphere, cone, involute spur gear, L-bracket), up to 50 parts, 0.1–1000 mm, parent/child joints (fixed or rotating).
- Three.js model viewer widget: orbit/zoom/pan, exploded view along joint axes, clickable part list and canvas picking, joint angle slider, binary STL export in mm (host download via `ui/download-file`, browser download as fallback), light/dark theme from the host, fullscreen when the host offers it.
- Local test host at `/dev` that renders widgets over the MCP Apps bridge with the widget's declared CSP enforced.
- Unit tests for input validation, gear geometry, primitive geometry, STL output and the MCP protocol surface.
