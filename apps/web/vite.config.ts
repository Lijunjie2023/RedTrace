import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repositoryRoot, "");
  const proxyTarget = env.READTRACE_API_PROXY_TARGET;
  return {
    envDir: repositoryRoot,
    plugins: [react()],
    server: {
      proxy: proxyTarget ? {
        "/api": {
          target: proxyTarget,
          changeOrigin: true,
          secure: env.READTRACE_API_PROXY_SECURE !== "false"
        }
      } : undefined
    }
  };
});
