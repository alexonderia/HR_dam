import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  publicDir: "../../public",
  plugins: [react()],
  server: {
    proxy: { "/api": process.env.API_TARGET || "http://127.0.0.1:3000" },
  },
});
