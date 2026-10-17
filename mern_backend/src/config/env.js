import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  FRONTEND_URL: z.string().url(),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  GITHUB_CALLBACK_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  TOKEN_ENCRYPTION_KEY: z.string().min(1, 'TOKEN_ENCRYPTION_KEY is required'),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  // Vercel integration — optional: without it the OAuth "Connect Vercel"
  // button is disabled and users connect by pasting a personal token instead.
  VERCEL_CLIENT_ID: z.string().min(1).optional(),
  VERCEL_CLIENT_SECRET: z.string().min(1).optional(),
  VERCEL_INTEGRATION_SLUG: z.string().min(1).optional(),
  VERCEL_REDIRECT_URI: z.string().url().optional(),
});

export const env = envSchema.parse(process.env);
export const isProd = env.NODE_ENV === 'production';

export const vercelOAuthConfigured = Boolean(
  env.VERCEL_CLIENT_ID && env.VERCEL_CLIENT_SECRET && env.VERCEL_INTEGRATION_SLUG && env.VERCEL_REDIRECT_URI
);
