// Builds each widget into one self-contained HTML file in dist/widgets/<name>.html.
// Everything (JS, CSS, Three.js) is inlined, so the widget CSP needs no CDN domains.

import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

// dev-host is the local test host served at /dev; the others are the tool widgets.
const WIDGETS = ["model-viewer", "simulation", "molecule", "dev-host"];
const here = import.meta.dirname;
const outRoot = join(here, "..", "dist", "widgets");

await mkdir(outRoot, { recursive: true });

for (const name of WIDGETS) {
  const tmp = join(outRoot, `.tmp-${name}`);
  await build({
    configFile: false,
    root: join(here, name),
    logLevel: "warn",
    plugins: [viteSingleFile()],
    build: { outDir: tmp, emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  });
  await rename(join(tmp, "index.html"), join(outRoot, `${name}.html`));
  await rm(tmp, { recursive: true, force: true });
  console.log(`built dist/widgets/${name}.html`);
}
