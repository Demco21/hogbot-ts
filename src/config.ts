import { config } from 'dotenv';
import { z } from 'zod';

config();

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  GUILD_ID: z.string().optional(),
  CASINO_CHANNEL_ID: z.string().optional(),
  DATABASE_FILE: z.string().optional(),
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
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
    guildId: env.GUILD_ID,
    casinoChannelId: env.CASINO_CHANNEL_ID,
  },
  database: {
    file: env.DATABASE_FILE ?? './hogbot.db',
  },
  ai: {
    apiKey: env.ANTHROPIC_API_KEY,
  },
  bot: {
    isDevelopment: env.NODE_ENV === 'development',
  },
} as const;
