import Anthropic from '@anthropic-ai/sdk';
import { db } from '../lib/database.js';
import { safeLogger as logger } from '../lib/safe-logger.js';
import { Config } from '../config.js';
import { AI_CONFIG } from '../constants.js';
import { formatDuration } from '../utils/utils.js';

/**
 * Result of a pre-flight rate/length check, performed before any AI API call is made.
 */
export type AiLimitCheckResult =
  | { allowed: true }
  | { allowed: false; reason: 'prompt_too_long' | 'cooldown' | 'daily_limit'; message: string };

/**
 * Result of an actual AI request.
 */
export type AiAskResult = { ok: true; text: string } | { ok: false; message: string };

/**
 * AiService — simple, stateless prompt/response AI feature backed by the Anthropic API.
 * Each request is independent; no conversation history is stored or sent.
 */
export class AiService {
  private readonly client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: Config.ai.apiKey });
  }

  /**
   * Validates prompt length and rate limits without making an API call.
   * Callers should run this before deferring a reply so limit violations
   * can be answered with a private (ephemeral) message.
   */
  checkLimits(userId: string, guildId: string, prompt: string): AiLimitCheckResult {
    if (prompt.length > AI_CONFIG.MAX_PROMPT_LENGTH) {
      return {
        allowed: false,
        reason: 'prompt_too_long',
        message: `❌ Your prompt is too long. Please keep it under ${AI_CONFIG.MAX_PROMPT_LENGTH} characters.`,
      };
    }

    const secondsSinceLastRequest = this.getSecondsSinceLastRequest(userId, guildId);
    if (secondsSinceLastRequest !== null && secondsSinceLastRequest < AI_CONFIG.COOLDOWN_SECONDS) {
      const retryAfterSeconds = AI_CONFIG.COOLDOWN_SECONDS - secondsSinceLastRequest;
      return {
        allowed: false,
        reason: 'cooldown',
        message: `⏳ Slow down! You can ask again in ${formatDuration(retryAfterSeconds)}.`,
      };
    }

    // Daily cap is a production abuse/cost guard - skip it in development so testing
    // isn't blocked by your own usage. Requests are still recorded and counted either way.
    const requestsToday = this.getRequestCountSince(userId, guildId, 24);
    if (!Config.bot.isDevelopment && requestsToday >= AI_CONFIG.DAILY_LIMIT) {
      return {
        allowed: false,
        reason: 'daily_limit',
        message: `❌ You've hit your daily limit of ${AI_CONFIG.DAILY_LIMIT} AI questions. Try again tomorrow.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Sends the prompt to the AI and records the request for rate limiting.
   * Assumes checkLimits() has already been called and passed.
   */
  async ask(userId: string, guildId: string, prompt: string): Promise<AiAskResult> {
    try {
      const response = await this.client.messages.create({
        model: AI_CONFIG.MODEL,
        max_tokens: AI_CONFIG.MAX_RESPONSE_TOKENS,
        system: AI_CONFIG.SYSTEM_PROMPT,
        tools: [
          {
            type: 'web_search_20260209',
            name: 'web_search',
            max_uses: AI_CONFIG.WEB_SEARCH_MAX_USES,
            // Required for models (e.g. Haiku) that don't support programmatic tool
            // calling - restricts the tool to being called directly by the model.
            allowed_callers: ['direct'],
          },
        ],
        messages: [{ role: 'user', content: prompt }],
      });

      this.recordRequest(userId, guildId);

      const text = this.joinTextBlocks(this.extractFinalAnswerBlocks(response.content)).trim();

      if (!text) {
        return { ok: false, message: '❌ The AI did not return a response. Please try again.' };
      }

      return { ok: true, text };
    } catch (error) {
      logger.error('Error calling Anthropic API:', error);
      return {
        ok: false,
        message: '❌ Something went wrong reaching the AI. Please try again in a moment.',
      };
    }
  }

  /**
   * Extracts only the text blocks that make up Claude's final answer, discarding any
   * preamble text written before a tool call (e.g. "I need to search for X..."). Content
   * blocks arrive in order; when a tool is used, the response looks like:
   *   [text: preamble] [server_tool_use] [web_search_tool_result] [text: real answer]
   * The preamble is throwaway narration about what the model is about to do - only the
   * text blocks after the last tool-related block are the actual answer. If no tool was
   * used at all, every block is text and this returns all of them, unchanged from before.
   */
  private extractFinalAnswerBlocks(content: Anthropic.ContentBlock[]): string[] {
    const lastToolBlockIndex = content.reduce(
      (lastIndex, block, index) => (block.type === 'text' ? lastIndex : index),
      -1
    );

    return content
      .slice(lastToolBlockIndex + 1)
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text);
  }

  /**
   * Joins Claude's text blocks back into one string. Blocks are split around tool calls
   * (e.g. web search), not around paragraphs, so each block is a direct continuation of
   * the previous one - most of the time they should be joined with nothing. However,
   * Claude sometimes resumes generation after a tool call without the leading space it
   * would normally include, producing artifacts like "Show.George" - so a single space
   * is inserted only when a block ends mid-sentence (on '.', '!', or '?') and the next
   * block resumes directly with a letter or digit, i.e. two sentences glued together.
   */
  private joinTextBlocks(blocks: string[]): string {
    return blocks.reduce((joined, block) => {
      if (!joined) return block;

      const prevChar = joined.slice(-1);
      const nextChar = block.charAt(0);
      const needsSpace = /[.!?]/.test(prevChar) && /[A-Za-z0-9]/.test(nextChar);

      return needsSpace ? `${joined} ${block}` : `${joined}${block}`;
    }, '');
  }

  private getSecondsSinceLastRequest(userId: string, guildId: string): number | null {
    const row = db
      .prepare(
        `SELECT CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER) as seconds_ago
         FROM ai_rate_limits
         WHERE user_id = ? AND guild_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(userId, guildId) as { seconds_ago: number } | undefined;

    return row ? row.seconds_ago : null;
  }

  private getRequestCountSince(userId: string, guildId: string, hours: number): number {
    const row = db
      .prepare(
        `SELECT COUNT(*) as request_count
         FROM ai_rate_limits
         WHERE user_id = ? AND guild_id = ? AND created_at > datetime('now', ?)`
      )
      .get(userId, guildId, `-${hours} hours`) as { request_count: number };

    return row.request_count;
  }

  private recordRequest(userId: string, guildId: string): void {
    db.prepare('INSERT INTO ai_rate_limits (user_id, guild_id) VALUES (?, ?)').run(userId, guildId);
  }
}
