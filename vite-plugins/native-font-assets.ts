import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";

// These dynamically requested fonts are not dependencies of index.css.
// Keep the pinned package's complete native font choices available offline.
export function nativeFontAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const root = path.join(path.dirname(require.resolve("@excalidraw/excalidraw")), "fonts");
  const assets = new Map<string, Buffer>();
  function collect(directory: string, prefix: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) collect(path.join(directory, entry.name), name);
      else if (entry.isFile() && entry.name.endsWith(".woff2")) {
        assets.set(name, readFileSync(path.join(directory, entry.name)));
      }
    }
  }
  collect(root, "excalidraw-assets/fonts");
  return {
    name: "native-font-assets",
    generateBundle() {
      for (const [fileName, source] of assets) this.emitFile({ type: "asset", fileName, source });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname.slice(1);
        const bytes = assets.get(pathname);
        if (!bytes) return next();
        response.setHeader("Content-Type", "font/woff2");
        response.end(bytes);
      });
    },
  };
}
