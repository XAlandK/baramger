/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// CesiumJS loads its workers and assets from CESIUM_BASE_URL.
// public/cesiumStatic links to node_modules/cesium/Build/Cesium,
// public/package links to ../data/package (the offline mission package).
export default defineConfig({
  define: {
    CESIUM_BASE_URL: JSON.stringify("/cesiumStatic"),
  },
  server: {
    port: 5173,
    // The mission assistant runs in the Cloudflare Worker: start it with `npx wrangler dev` (port 8787,
    // keys from app/.dev.vars). Without it the Ask tab says the assistant isn't available.
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        // the Worker only answers its own site and the sites in ALLOWED_ORIGINS: through the proxy it is its own site
        configure: (proxy) => proxy.on("proxyReq", (req) => req.removeHeader("origin")),
      },
    },
  },
  build: { chunkSizeWarningLimit: 8000 },
  // The layout tests read style.css as text (vitest gives an empty string for CSS files it is not told about).
  test: { css: { include: [/style\.css/] } },
});
