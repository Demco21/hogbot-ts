import { Listener } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { Message } from 'discord.js';
import { safeLogger as logger } from '../lib/safe-logger.js';
import { AI_CONFIG } from '../constants.js';
import {
  stripBotMention,
  extractQuotableText,
  buildContextualPrompt,
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
      // Ignore bots (including ourselves) to avoid loops.
      if (message.author.bot) return;

      // Guild-scoped feature only, consistent with the rest of the bot.
      // inGuild() (rather than a plain message.guild check) narrows message.channel's
      // type so guild-only members like sendTyping() are usable below.
      if (!message.inGuild()) return;

      const botUser = this.container.client.user;
      if (!botUser || !message.mentions.has(botUser)) return;

      const userId = message.author.id;
      const guildId = message.guild.id;

      // Ensure guild exists in database (required by ai_rate_limits foreign key)
      await this.container.walletService.ensureGuild(guildId, message.guild.name);

      const strippedQuestion = stripBotMention(message.content, botUser.id);
      const quotedChain = await this.fetchReplyChain(message);

      const question = this.resolveQuestion(strippedQuestion, quotedChain);
      if (question === null) {
        // Bare mention with nothing to reply to and nothing typed - nothing to answer.
        return;
      }

      const prompt = buildContextualPrompt(question, quotedChain);

      const limitCheck = this.container.aiService.checkLimits(userId, guildId, prompt);
      if (!limitCheck.allowed) {
        // Plain messages have no ephemeral/private concept - this reply is necessarily
        // visible in the channel, unlike the slash command's ephemeral limit responses.
        await message.reply({ content: limitCheck.message });
        return;
      }

      await message.channel.sendTyping();

      const result = await this.container.aiService.ask(userId, guildId, prompt);

      if (!result.ok) {
        await message.reply({ content: result.message });
        return;
      }

      const embed = buildHogAiAnswerEmbed(result.text);

      await message.reply({ embeds: [embed] });
    } catch (error) {
      logger.error('Error handling messageCreate (HogAI mention trigger):', error);
      // Don't throw - this is a listener, errors should not crash the bot
    }
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

      // No plain content and no embed text to fall back on - genuinely nothing to quote
      // (could still be an intent issue if this is a plain-text message from another user).
      if (content) {
        chain.push({ authorName: referenced.author.username, content });
        accumulatedLength += content.length;
      } else {
        logger.warn(
          `Replied-to message ${referenced.id} had no quotable text - is the Message Content intent enabled?`
        );
      }

      current = referenced;
    }

    return chain.reverse();
  }

  /**
   * Determines the final question text, applying the default mention prompt when a
   * user mentions HogAI on a reply with no question of their own. Returns null when
   * there is nothing to answer (bare mention, no reply, no typed question).
   */
  private resolveQuestion(strippedQuestion: string, quotedChain: QuotedMessage[]): string | null {
    if (strippedQuestion.length > 0) return strippedQuestion;
    if (quotedChain.length > 0) return AI_CONFIG.DEFAULT_MENTION_PROMPT;
    return null;
  }
}
