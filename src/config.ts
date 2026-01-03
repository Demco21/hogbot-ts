import { config } from 'dotenv';
import { z } from 'zod';

config();

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  GUILD_ID: z.string().optional(), // Optional: for development/single-server mode
  CASINO_CHANNEL_ID: z.string().optional(), // Deprecated: now stored per-guild in database
  DATABASE_HOST: z.string().default('localhost'),
  DATABASE_PORT: z.string().default('5432'),
  DATABASE_NAME: z.string().default('hogbot'),
  DATABASE_USER: z.string().default('hogbot'),
  DATABASE_PASSWORD: z.string().min(1, 'DATABASE_PASSWORD is required'),
  NODE_ENV: z.enum(['development', 'production']).default('development'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment variables');
}

export const env = parsed.data;

export const Config = {
  discord: {
    token: env.DISCORD_TOKEN,
    // Optional: Only used for development/single-server mode
    // For multi-guild bots, register commands globally
    guildId: env.GUILD_ID,
    // Deprecated: Casino channel is now stored per-guild in database
    // This fallback is kept for backward compatibility only
    casinoChannelId: env.CASINO_CHANNEL_ID,
  },
  database: {
    host: env.DATABASE_HOST,
    port: parseInt(env.DATABASE_PORT, 10),
    database: env.DATABASE_NAME,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
  },
  bot: {
    isDevelopment: env.NODE_ENV === 'development',
  },
} as const;
