import { Listener } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { Message, PermissionFlagsBits } from 'discord.js';
import { safeLogger as logger } from '../lib/safe-logger.js';
import { AI_CONFIG } from '../constants.js';
import {
  stripBotMention,
  extractQuotableText,
  extractImageUrls,
  collectImageUrls,
  buildContextualPrompt,
  buildRecentHistorySection,
  buildHogAiAnswerEmbed,
  type QuotedMessage,
} from '../utils/ai-utils.js';

/**
 * MessageCreate listener - HogAI mention trigger.
 * Mentioning the bot (optionally while replying to another message) triggers AiService
 * to generate a response.
 */
@ApplyOptions<Listener.Options>({
  event: 'messageCreate',
})
export class MessageCreateListener extends Listener {
  public override async run(message: Message) {
    try {
      logger.info(`[HogAI debug] messageCreate received, id=${message.id} author=${message.author.id}`);

      // Ignore bots (including ourselves) to avoid loops.
      if (message.author.bot) {
        logger.info('[HogAI debug] exit: author is a bot');
        return;
      }

      // Guild-scoped feature only, consistent with the rest of the bot.
      // inGuild() (rather than a plain message.guild check) narrows message.channel's
      // type so guild-only members like sendTyping() are usable below.
      if (!message.inGuild()) {
        logger.info('[HogAI debug] exit: message not inGuild()');
        return;
      }

      const botUser = this.container.client.user;
      logger.info(
        `[HogAI debug] botUser=${botUser?.id} mentionsHasBotUser=${botUser ? message.mentions.has(botUser) : 'n/a'}`
      );
      if (!botUser || !message.mentions.has(botUser)) {
        logger.info('[HogAI debug] exit: message does not mention botUser');
        return;
      }

      const hasAccess = await this.hasAiAccess(message);
      logger.info(`[HogAI debug] hasAiAccess=${hasAccess}`);
      if (!hasAccess) {
        await message.reply({
          content: '❌ You don\'t have access to HogAI. Ask an admin to grant you the configured access role.',
        });
        return;
      }

      const userId = message.author.id;
      const guildId = message.guild.id;

      // Ensure guild exists in database (required by ai_rate_limits foreign key)
      await this.container.walletService.ensureGuild(guildId, message.guild.name);

      const strippedQuestion = stripBotMention(message.content, botUser.id);
      const quotedChain = await this.fetchReplyChain(message);
      const imageUrls = collectImageUrls(message, quotedChain, AI_CONFIG.MAX_IMAGES_PER_REQUEST);

      const question = this.resolveQuestion(strippedQuestion, quotedChain, imageUrls.length > 0);
      logger.info(
        `[HogAI debug] strippedQuestion="${strippedQuestion}" quotedChainLen=${quotedChain.length} imageUrls=${imageUrls.length} resolvedQuestion=${question === null ? 'null' : `"${question}"`}`
      );
      if (question === null) {
        // Bare mention with nothing to reply to, nothing typed, and no images - nothing to answer.
        return;
      }

      const prompt = buildContextualPrompt(question, quotedChain);

      const limitCheck = this.container.aiService.checkLimits(userId, guildId, prompt);
      logger.info(`[HogAI debug] limitCheck.allowed=${limitCheck.allowed}`);
      if (!limitCheck.allowed) {
        // Plain messages have no ephemeral/private concept - this reply is necessarily
        // visible in the channel, unlike the slash command's ephemeral limit responses.
        await message.reply({ content: limitCheck.message });
        return;
      }

      // Best-effort UX nicety - a transient Discord API failure here (e.g. a raw 500)
      // shouldn't abort the whole mention handler and deny the user their actual answer.
      await message.channel.sendTyping().catch((error) => {
        logger.debug(
          `Could not send typing indicator for HogAI mention trigger ` +
            `[status=${error?.status} method=${error?.method} url=${error?.url}]:`,
          error
        );
      });

      const result = await this.container.aiService.ask(userId, guildId, prompt, imageUrls, () =>
        this.fetchRecentChannelHistory(message)
      );
      logger.info(`[HogAI debug] aiService.ask result.ok=${result.ok}`);

      if (!result.ok) {
        await message.reply({ content: result.message });
        return;
      }

      const embed = buildHogAiAnswerEmbed(result.text);

      await message.reply({ embeds: [embed] });
      logger.info('[HogAI debug] reply with embed sent successfully');
    } catch (error) {
      logger.error('Error handling messageCreate (HogAI mention trigger):', error);
      // Don't throw - this is a listener, errors should not crash the bot
    }
  }

  /**
   * HogAI is restricted to a configurable access role (plus admins) once one has been set
   * per-guild via /config (guildSettingsService.setAiAccessRoleId) - not a Discord
   * permission bit, since servers name/scope their roles however they like. Mirrors
   * CasinoChannelOnlyPrecondition's fail-open convention: if no role is configured yet,
   * access is unrestricted rather than silently admin-only. The guild owner always passes
   * the Administrator check regardless of roles - discord.js grants owners full permissions
   * (GuildMember#permissions) independent of role assignment.
   */
  private async hasAiAccess(message: Message<true>): Promise<boolean> {
    if (message.member?.permissions.has(PermissionFlagsBits.Administrator)) return true;

    const accessRoleId = await this.container.guildSettingsService.getAiAccessRoleId(
      message.guild.id
    );
    if (!accessRoleId) return true;

    return message.member?.roles.cache.has(accessRoleId) ?? false;
  }

  /**
   * Walks up the reply chain (this message's reference, that message's reference, and so
   * on), so replying to HogAI's 2nd answer still surfaces the 1st answer and the message
   * that prompted it - not just the single message directly being replied to. Climbing
   * stops once enough content has been gathered to fill AI_CONFIG.MAX_QUOTED_MESSAGE_LENGTH
   * (the budget buildContextualPrompt ultimately enforces), so a chain of short messages
   * keeps climbing further than a chain of long ones - message *content*, not message
   * *count*, is what determines how much context makes it in. AI_CONFIG.MAX_REPLY_CHAIN_DEPTH
   * is only a safety cap against pathological chains, not the normal stopping point.
   * Returns messages in chronological (oldest-first) order. Best-effort: stops silently on
   * a missing/unfetchable reference (e.g. deleted message) rather than failing the request.
   */
  private async fetchReplyChain(message: Message): Promise<QuotedMessage[]> {
    const chain: QuotedMessage[] = [];
    let current: Message = message;
    let accumulatedLength = 0;

    for (let depth = 0; depth < AI_CONFIG.MAX_REPLY_CHAIN_DEPTH; depth++) {
      if (!current.reference) break;
      if (accumulatedLength >= AI_CONFIG.MAX_QUOTED_MESSAGE_LENGTH) break;

      let referenced: Message;
      try {
        referenced = await current.fetchReference();
      } catch (error) {
        logger.debug('Could not fetch replied-to message for HogAI context:', error);
        break;
      }

      const content = extractQuotableText(referenced);
      const imageUrls = extractImageUrls(referenced, AI_CONFIG.MAX_IMAGES_PER_REQUEST);

      // No plain content, no embed text, and no image to fall back on - genuinely nothing
      // to quote (could still be an intent issue if this is a plain-text message from
      // another user).
      if (content || imageUrls.length > 0) {
        chain.push({ authorName: referenced.author.username, content, imageUrls });
        accumulatedLength += content.length;
      } else {
        logger.warn(
          `Replied-to message ${referenced.id} had no quotable text or images - is the Message Content intent enabled?`
        );
      }

      current = referenced;
    }

    return chain.reverse();
  }

  /**
   * Fetches the channel messages immediately preceding the trigger message and renders
   * them into a labeled block, for the check_recent_channel_messages tool result. Only
   * invoked when Claude actually calls that tool (see AiService.ask()) - this is the
   * "scan the last few messages" fallback for context that a bare reply chain wouldn't
   * catch, e.g. a follow-up sent as a new message instead of a reply. Best-effort: a
   * fetch failure is surfaced to Claude as text rather than failing the whole request,
   * since Claude can just answer without the extra context in that case.
   */
  private async fetchRecentChannelHistory(message: Message<true>): Promise<string> {
    try {
      const recentMessages = await message.channel.messages.fetch({
        limit: AI_CONFIG.CHANNEL_HISTORY_LOOKBACK_COUNT,
        before: message.id,
      });

      // fetch() returns newest-first; buildRecentHistorySection expects oldest-first.
      return buildRecentHistorySection(Array.from(recentMessages.values()).reverse());
    } catch (error) {
      logger.debug('Could not fetch recent channel history for HogAI context tool:', error);
      return 'Could not retrieve recent channel history due to an error.';
    }
  }

  /**
   * Determines the final question text, applying a default prompt when a user mentions
   * HogAI with no question of their own - one geared toward the reply chain if present,
   * otherwise toward any directly-attached images. Returns null when there is nothing to
   * answer (bare mention, no reply, no typed question, no images).
   */
  private resolveQuestion(
    strippedQuestion: string,
    quotedChain: QuotedMessage[],
    hasImages: boolean
  ): string | null {
    if (strippedQuestion.length > 0) return strippedQuestion;
    if (quotedChain.length > 0) return AI_CONFIG.DEFAULT_MENTION_PROMPT;
    if (hasImages) return AI_CONFIG.DEFAULT_IMAGE_PROMPT;
    return null;
  }
}
