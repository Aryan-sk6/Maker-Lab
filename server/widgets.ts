// Loads the single-file widget bundles produced by `npm run build:widgets`.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Works both from source (server/ → ../dist/widgets) and compiled (dist/server/ → ../widgets).
const candidates = [
  process.env.WIDGET_DIR,
  join(import.meta.dirname, "..", "dist", "widgets"),
  join(import.meta.dirname, "..", "widgets"),
].filter((dir): dir is string => dir !== undefined);

const cache = new Map<string, string>();

export function loadWidget(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  for (const dir of candidates) {
    const file = join(dir, `${name}.html`);
    if (existsSync(file)) {
      const html = readFileSync(file, "utf8");
      // In dev (tsx watch) re-read on every request so widget rebuilds show up without a restart.
      if (process.env.NODE_ENV === "production") cache.set(name, html);
      return html;
    }
  }
  throw new Error(`Widget "${name}" has not been built. Run "npm run build:widgets" first.`);
}
