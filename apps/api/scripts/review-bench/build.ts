/**
 * Bundles the ReviewBench agent into one file for its image, so the image
 * holds Node, git, and this bundle, and nothing else from the repository.
 * Run with `pnpm --filter @not-quite-my-tempo/api bench:rb-build`.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// esbuild comes with tsx, which runs this script.
const require = createRequire(import.meta.resolve("tsx"));

// The one esbuild call made here; its types aren't installed for this app.
interface BuildOptions {
  readonly entryPoints: readonly string[];
  readonly outfile: string;
  readonly bundle: boolean;
  readonly platform: "node";
  readonly format: "esm";
  readonly target: string;
  readonly banner: { readonly js: string };
  readonly logLevel: "info";
}

interface Esbuild {
  readonly build: (
    options: BuildOptions,
  ) => Promise<{ readonly errors: readonly object[] }>;
}

// SAFETY: this is tsx's own esbuild dependency, whose module exports
// `build` with the options used below.
const esbuild = require("esbuild") as Esbuild;

const here = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [join(here, "agent.ts")],
  outfile: join(here, "dist", "agent.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Bundled CommonJS dependencies still call require.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "info",
});
