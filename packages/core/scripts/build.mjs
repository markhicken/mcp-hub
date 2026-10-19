// Bundles the daemon into a single ESM file (dist/core.mjs). node:sqlite is a Node builtin and stays external.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
mkdirSync(join(root, "dist"), { recursive: true });

await build({
  entryPoints: [join(root, "src", "cli.ts")],
  outfile: join(root, "dist", "core.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  minify: false,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
 // jsonc-parser's default (UMD) entry loads its own files with a dynamic require that can't be bundled.
 alias: { "jsonc-parser": "jsonc-parser/lib/esm/main.js" },
});
console.log("built dist/core.mjs");
