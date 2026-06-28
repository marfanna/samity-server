import 'dotenv/config';
import { z } from 'zod';

/**
 * Typed, validated environment. Fail fast on boot if a required var is missing —
 * never read process.env directly elsewhere.
 */
const boolFromEnv = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}, z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be >=32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be >=32 chars'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  CORS_ORIGIN: z.string().default('*'),

  SMS_ENABLED: boolFromEnv.default(false),
  SMS_BASE_URL: z.string().url().optional(),
  SMS_SEND_PATH: z.string().default(''),
  SMS_API_KEY: z.string().optional(),
  SMS_SENDER_ID: z.string().optional(),
  SMS_METHOD: z.enum(['GET', 'POST']).default('GET'),
  SMS_BODY_FORMAT: z.enum(['query', 'form', 'json']).default('query'),
  SMS_AUTH_PARAM: z.string().default('api_key'),
  SMS_SENDER_PARAM: z.string().default('senderid'),
  SMS_TO_PARAM: z.string().default('number'),
  SMS_MESSAGE_PARAM: z.string().default('message'),
  SMS_SUCCESS_REGEX: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
