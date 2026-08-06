import { z } from "zod";

const RuntimeConfigSchema = z.object({
  DATA_MODE: z.enum(["mock", "mysql"]),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
  MOCK_ADMIN_USERNAME: z.string().min(1).default("admin"),
  MOCK_ADMIN_PASSWORD: z.string().min(1).default("readtrace-demo")
});

export interface RuntimeConfig {
  dataMode: "mock" | "mysql";
  port: number;
  mockAdminUsername: string;
  mockAdminPassword: string;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = RuntimeConfigSchema.safeParse(env);
  if (!parsed.success) throw new Error("runtime_config_invalid");
  return {
    dataMode: parsed.data.DATA_MODE,
    port: parsed.data.API_PORT,
    mockAdminUsername: parsed.data.MOCK_ADMIN_USERNAME,
    mockAdminPassword: parsed.data.MOCK_ADMIN_PASSWORD
  };
}
