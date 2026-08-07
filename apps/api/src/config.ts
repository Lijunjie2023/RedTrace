import { z } from "zod";

const OptionalBooleanSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return value;
}, z.boolean().optional());

const RuntimeConfigSchema = z.object({
  DATA_MODE: z.enum(["mock", "mysql"]),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
  MOCK_ADMIN_USERNAME: z.string().min(1).default("admin"),
  MOCK_ADMIN_PASSWORD: z.string().min(1).default("readtrace-demo"),
  ADMIN_USERNAME: z.string().min(1).optional(),
  ADMIN_PASSWORD: z.string().min(1).optional(),
  SESSION_COOKIE_SECURE: OptionalBooleanSchema
}).superRefine((value, context) => {
  if (value.DATA_MODE !== "mysql") return;
  if (!value.ADMIN_USERNAME) {
    context.addIssue({ code: "custom", path: ["ADMIN_USERNAME"], message: "required_in_mysql_mode" });
  }
  if (!value.ADMIN_PASSWORD) {
    context.addIssue({ code: "custom", path: ["ADMIN_PASSWORD"], message: "required_in_mysql_mode" });
  } else if (value.ADMIN_PASSWORD.length < 8) {
    context.addIssue({ code: "custom", path: ["ADMIN_PASSWORD"], message: "password_too_short" });
  }
  if (value.SESSION_COOKIE_SECURE === false) {
    context.addIssue({ code: "custom", path: ["SESSION_COOKIE_SECURE"], message: "must_be_true_in_mysql_mode" });
  }
});

export interface RuntimeConfig {
  dataMode: "mock" | "mysql";
  port: number;
  adminUsername: string;
  adminPassword: string;
  sessionCookieSecure: boolean;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = RuntimeConfigSchema.safeParse(env);
  if (!parsed.success) throw new Error("runtime_config_invalid");
  const useLiveCredentials = parsed.data.DATA_MODE === "mysql";
  return {
    dataMode: parsed.data.DATA_MODE,
    port: parsed.data.API_PORT,
    adminUsername: useLiveCredentials
      ? parsed.data.ADMIN_USERNAME!
      : parsed.data.ADMIN_USERNAME ?? parsed.data.MOCK_ADMIN_USERNAME,
    adminPassword: useLiveCredentials
      ? parsed.data.ADMIN_PASSWORD!
      : parsed.data.ADMIN_PASSWORD ?? parsed.data.MOCK_ADMIN_PASSWORD,
    sessionCookieSecure: parsed.data.SESSION_COOKIE_SECURE ?? useLiveCredentials
  };
}
