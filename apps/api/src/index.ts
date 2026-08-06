import path from "node:path";
import dotenv from "dotenv";
import { loadRuntimeConfig } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  dotenv.config({ path: path.resolve(".env.local"), quiet: true });
  const config = loadRuntimeConfig();
  const app = await createServer(config);
  await app.listen({ host: "127.0.0.1", port: config.port });
}

main().catch(() => {
  process.exitCode = 1;
});
