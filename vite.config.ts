import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;

// Read the version from package.json at build time so the about page can never
// drift from the real version on a release. Exposed as `__APP_VERSION__` global.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf-8"),
) as { version: string };

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    // pdfjs's worker legitimately ships ~2 MB and the codemirror bundle sits
    // around 600 KB. For a Tauri desktop app these load from local disk in ms;
    // the 500 KB default warning is a web-app heuristic that doesn't apply here.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Split heavy vendor libs into their own chunks so:
        //   - opening a PDF doesn't drag in docx-preview, codemirror, etc.
        //   - vendors that rarely change (react, codemirror) stay cached across releases
        //   - the main `index.js` bundle stays small enough to be in the critical path
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("pdfjs-dist")) return "pdfjs";
          if (id.includes("docx-preview")) return "docx";
          if (id.includes("xlsx")) return "xlsx";
          if (id.includes("@codemirror") || id.includes("@uiw/react-codemirror") || id.includes("@lezer")) {
            return "codemirror";
          }
          if (id.includes("react-markdown") || id.includes("remark-") || id.includes("micromark") || id.includes("highlight.js")) {
            return "markdown";
          }
          if (id.includes("@sentry")) return "sentry";
          if (id.includes("react-dom") || id.includes("scheduler") || id.includes("/react/")) {
            return "react-vendor";
          }
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
