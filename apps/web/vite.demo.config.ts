// The online demo (apps/web/demo): the reader pages as a static site, no server. The path it is
// served under ("/topka/" on GitHub Pages) comes from `vite build --base`; scripts/build-demo.ts
// adds the data and the per-route copies of index.html.
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./demo", import.meta.url)),
  plugins: [tailwindcss()],
  // React 19's automatic runtime for the demo's own .tsx files.
  oxc: { jsx: { runtime: "automatic" } },
  build: {
    outDir: fileURLToPath(new URL("./build-demo", import.meta.url)),
    emptyOutDir: true,
    // One bundle for the whole demo (about 180 kB gzipped); no route splitting needed.
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      // react-router's "use client" means nothing in a client-only bundle.
      onwarn(warning, warn) {
        if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
      },
    },
  },
  server: { port: 3400, strictPort: true, fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
});
