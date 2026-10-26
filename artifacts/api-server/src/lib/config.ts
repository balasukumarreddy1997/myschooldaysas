import { z } from "zod";

const runtimeEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535),
    DATABASE_URL: z.string().url().optional(),
    JWT_SECRET: z.string().optional(),
    INTERNAL_API_KEY: z.string().optional(),
    REDIS_URL: z.string().url().optional(),
    LIVEKIT_PUBLIC_URL: z.preprocess(
      (value) => value === "" ? undefined : value,
      z.string().url().optional(),
    ),
    LIVEKIT_API_KEY: z.string().optional(),
    LIVEKIT_API_SECRET: z.string().optional(),
    LIVEKIT_INTERNAL_URL: z.string().url().optional(),
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  })
  .superRefine((env, context) => {
    if (env.DATABASE_URL && !/^postgres(ql)?:\/\//.test(env.DATABASE_URL)) {
      context.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "Must use the PostgreSQL URL scheme." });
    }
    if (env.REDIS_URL && !/^rediss?:\/\//.test(env.REDIS_URL)) {
      context.addIssue({ code: "custom", path: ["REDIS_URL"], message: "Must use the Redis URL scheme." });
    }
    if (
      env.LIVEKIT_PUBLIC_URL &&
      !/^wss?:\/\//.test(env.LIVEKIT_PUBLIC_URL)
    ) {
      context.addIssue({ code: "custom", path: ["LIVEKIT_PUBLIC_URL"], message: "Must use a ws:// or wss:// URL." });
    }
    if (env.NODE_ENV !== "production") return;

    const requiredKeys = [
      "DATABASE_URL",
      "JWT_SECRET",
      "INTERNAL_API_KEY",
      "REDIS_URL",
      "LIVEKIT_PUBLIC_URL",
      "LIVEKIT_API_KEY",
      "LIVEKIT_API_SECRET",
      "RAZORPAY_KEY_ID",
      "RAZORPAY_KEY_SECRET",
      "RAZORPAY_WEBHOOK_SECRET",
    ] as const;
    for (const key of requiredKeys) {
      if (!env[key]) {
        context.addIssue({ code: "custom", path: [key], message: "Required in production." });
      }
    }

    const secretKeys = [
      "JWT_SECRET",
      "INTERNAL_API_KEY",
      "LIVEKIT_API_SECRET",
      "RAZORPAY_KEY_SECRET",
      "RAZORPAY_WEBHOOK_SECRET",
    ] as const;
    for (const key of secretKeys) {
      const value = env[key];
      if (value && value.length < 32) {
        context.addIssue({ code: "custom", path: [key], message: "Must be at least 32 characters in production." });
      }
    }

    const nonSecretKeys = ["JWT_SECRET", "INTERNAL_API_KEY", "LIVEKIT_API_KEY", ...secretKeys] as const;
    for (const key of new Set(nonSecretKeys)) {
      const value = env[key];
      if (value && /development|change.?me|example|devkey|mock/i.test(value)) {
        context.addIssue({ code: "custom", path: [key], message: "Development placeholders are not allowed in production." });
      }
    }
  });

export type RuntimeConfig = z.infer<typeof runtimeEnvSchema>;

export function loadRuntimeConfig(input: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const result = runtimeEnvSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return result.data;
}
