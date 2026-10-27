/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");

  return {
    // GitHub Pages serves project sites from /<repo>/. The deploy workflow
    // sets VITE_BASE; local dev and local builds stay at the site root.
    base: env.VITE_BASE || "/",
    plugins: [react()],
    server: {
      host: true,
      port: 5173,
    },
    build: {
      target: "es2022",
    },
    test: {
      environment: "node",
      include: ["src/**/*.test.ts"],
    },
  };
});
