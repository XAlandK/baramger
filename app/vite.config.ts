import { defineConfig } from "vite";

// CesiumJS loads its workers and assets from CESIUM_BASE_URL.
// public/cesiumStatic links to node_modules/cesium/Build/Cesium,
// public/package links to ../data/package (the offline mission package).
export default defineConfig({
  define: {
    CESIUM_BASE_URL: JSON.stringify("/cesiumStatic"),
  },
  server: { port: 5173 },
  build: { chunkSizeWarningLimit: 8000 },
});
