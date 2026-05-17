import { z } from 'zod';

// =====================================================================
// RuntimeConfig — the ONLY place process.env is read in the entire app.
// All other modules must receive config via constructor injection.
// =====================================================================

const RuntimeConfigSchema = z.object({
  // Server
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  EXECUTION_MODE: z.enum(['PRODUCTION', 'SANDBOX', 'REPLAY', 'DRY_RUN', 'TEST']).default('PRODUCTION'),

  // MongoDB
  MONGO_URI: z.string().min(1),
  MONGO_DB_NAME: z.string().default('karen'),

  // Redis
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),

  // OpenAI
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_DAILY_TOKEN_BUDGET: z.coerce.number().default(500000),

  // WhatsApp
  WHATSAPP_WEBHOOK_SECRET: z.string().default('changeme'),
  WHATSAPP_VERIFY_TOKEN: z.string().default('changeme'),

  // Security
  ENCRYPTION_KEY: z.string().min(32).optional(),
  ALLOWED_ORIGINS: z.string().default('*'),

  // Feature Flags — runtime configurable without redeploy
  FEATURE_PROACTIVE_MODE: z.coerce.boolean().default(true),
  FEATURE_REFLECTION_AGENT: z.coerce.boolean().default(false),
  FEATURE_ADAPTIVE_BEHAVIOR: z.coerce.boolean().default(false),
  FEATURE_REPLAY_TOOLING: z.coerce.boolean().default(false),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export function loadRuntimeConfig(): RuntimeConfig {
  const result = RuntimeConfigSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[STARTUP] Fatal: Invalid runtime configuration:');
    console.error(result.error.format());
    process.exit(1);
  }
  return result.data;
}
