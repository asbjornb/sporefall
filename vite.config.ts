import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        // Hidden evolutionary-simulator page. Unlinked from index.html and
        // tagged noindex — only reachable by typing /evo.html directly.
        evo: resolve(__dirname, "evo.html"),
      },
    },
  },
  server: {
    host: true,
  },
});
