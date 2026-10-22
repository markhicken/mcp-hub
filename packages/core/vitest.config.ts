import { realpathSync } from "node:fs";
import { defineConfig } from "vitest/config";

// A checkout reached through a symlinked folder (as on some Windows setups) has its root at the link's path but its
// files at the real one, and Vite refuses to load files outside its root. Allow the real location too.
export default defineConfig({
  server: { fs: { allow: [process.cwd(), realpathSync(process.cwd()), realpathSync(`${process.cwd()}/../..`)] } },
  test: { setupFiles: ["./test/setup-hermetic.ts"] },
});
