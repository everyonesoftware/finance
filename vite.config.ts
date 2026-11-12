import { defineConfig } from "vite";
import { financePwa } from "./build/pwa";

const appVersion = process.env["APP_VERSION"] ?? "dev";

export default defineConfig({
  plugins: [financePwa(appVersion)],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
