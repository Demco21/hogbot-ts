/**
 * Shared helpers for HogAI's @mention message trigger - prompt construction
 * and embed formatting live here.
 */
import { EmbedBuilder, type Attachment, type Message } from 'discord.js';
import { AI_CONFIG, EMBED_COLORS, EMBED_LIMITS } from '../constants.js';

/**
 * A message quoted for context, e.g. the message a user replied to when @mentioning HogAI.
 */
export interface QuotedMessage {
  authorName: string;
  content: string;
  imageUrls: string[];
}

/**
 * Removes a bot's mention token(s) (<@id> / <@!id>) from message content and trims the result.
 */
export function stripBotMention(content: string, botId: string): string {
  const mentionPattern = new RegExp(`<@!?${botId}>`, 'g');
  return content.replace(mentionPattern, '').trim();
}

/**
 * Extracts quotable text from a message. Most of this bot's own replies (HogAI's own
 * answers, /mywallet, game results, etc.) are sent as embeds with no plain message
 * content, so plain `message.content` is empty for almost all of this bot's own
 * output - fall back to the embed's title/description/fields in that case.
 */
export function extractQuotableText(message: Message): string {
  if (message.content.trim()) {
    return message.content;
  }

  const embedTexts = message.embeds.flatMap((embed) => {
    const parts: string[] = [];
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
    for (const field of embed.fields) {
      parts.push(`${field.name}: ${field.value}`);
    }
    return parts;
  });

  return embedTexts.join('\n').trim();
}

/**
 * Extracts up to maxImages image URLs from a message - both directly uploaded image
 * attachments and images Discord auto-embedded from a pasted link. Passed straight to
 * Anthropic as `{type: "image", source: {type: "url", url}}` content blocks - no
 * downloading/re-uploading needed since Discord CDN attachment URLs are public.
 */
export function extractImageUrls(message: Message, maxImages: number): string[] {
  const urls: string[] = [];

  for (const attachment of message.attachments.values()) {
    if (urls.length >= maxImages) return urls;
    if (isImageAttachment(attachment)) {
      urls.push(attachment.url);
    }
  }

  for (const embed of message.embeds) {
    if (urls.length >= maxImages) return urls;
    if (embed.image?.url) {
      urls.push(embed.image.url);
    }
  }

  return urls;
}

function isImageAttachment(attachment: Attachment): boolean {
  if (attachment.contentType?.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp)$/i.test(attachment.name ?? '');
}

/**
 * Merges image URLs from the triggering message and the reply chain into a single
 * capped list to attach to the AI request. The triggering message's own attachments
 * come first (the thing the user is most directly asking about), then the reply chain
 * newest-first - mirroring the priority order buildQuotedChainSection uses for text.
 */
export function collectImageUrls(
  message: Message,
  quotedChain: QuotedMessage[],
  maxImages: number
): string[] {
  const urls = extractImageUrls(message, maxImages);

  for (let i = quotedChain.length - 1; i >= 0 && urls.length < maxImages; i--) {
    for (const url of quotedChain[i]!.imageUrls) {
      if (urls.length >= maxImages) break;
      urls.push(url);
    }
  }

  return urls;
}

/**
 * Composes the final prompt sent to AiService, folding in a reply chain as labeled
 * context when present. All pieces are truncated so the combined result always fits
 * within AI_CONFIG.MAX_PROMPT_LENGTH, the single length limit AiService.checkLimits() enforces.
 */
export function buildContextualPrompt(question: string, quotedChain: QuotedMessage[] = []): string {
  if (quotedChain.length === 0) {
    return question.slice(0, AI_CONFIG.MAX_PROMPT_LENGTH);
  }

  const quotedSection = buildQuotedChainSection(quotedChain);
  const remainingLength = Math.max(0, AI_CONFIG.MAX_PROMPT_LENGTH - quotedSection.length - 2);
  const truncatedQuestion = truncate(question, remainingLength);

  return `${quotedSection}\n\n${truncatedQuestion}`;
}

/**
 * Renders a reply chain (oldest to newest) into a single labeled context block, within
 * AI_CONFIG.MAX_QUOTED_MESSAGE_LENGTH total. Budget is allocated newest-first - the most
 * recent messages in the chain (the ones the user is actually replying to) are the most
 * relevant, so if the chain doesn't fit, older messages are the ones dropped or truncated.
 */
function buildQuotedChainSection(quotedChain: QuotedMessage[]): string {
  const header = 'Referenced conversation (oldest to newest):';
  let remaining = AI_CONFIG.MAX_QUOTED_MESSAGE_LENGTH - header.length;

  const includedLines: string[] = [];
  for (let i = quotedChain.length - 1; i >= 0 && remaining > 0; i--) {
    const quotedMessage = quotedChain[i]!;
    const prefix = `\n${quotedMessage.authorName}: "`;
    const suffix = '"';
    const available = remaining - prefix.length - suffix.length;
    if (available <= 0) break;

    const content = truncate(quotedMessage.content, available);
    includedLines.unshift(`${prefix}${content}${suffix}`);
    remaining -= prefix.length + content.length + suffix.length;
  }

  return `${header}${includedLines.join('')}`;
}

/**
 * Disclaimer jokes shown in the HogAI answer embed footer. One is picked at random
 * per answer so regular users see some variety instead of the same line every time.
 */
const HOG_AI_FOOTER_JOKES = [
  'Hogbot never makes mistakes. No need to verify any info.',
  "Hogbot is just like you, he's not a cop.",
  "Your personal data and autonomy is absolutely safe with Hogbot!"
];

function randomFooterJoke(): string {
  return HOG_AI_FOOTER_JOKES[Math.floor(Math.random() * HOG_AI_FOOTER_JOKES.length)]!;
}

/**
 * Builds the standard HogAI answer embed - just the response itself, no title/author.
 * Who asked and what was asked are both already visible elsewhere: the question is in
 * the message being replied to, and the reply itself shows who sent it.
 */
export function buildHogAiAnswerEmbed(answerText: string): EmbedBuilder {
  const truncatedAnswer = truncate(answerText, EMBED_LIMITS.DESCRIPTION_MAX_LENGTH);

  return new EmbedBuilder()
    .setColor(EMBED_COLORS.INFO)
    .setDescription(truncatedAnswer)
    .setFooter({ text: randomFooterJoke() })
    .setTimestamp();
}

/**
 * Truncates text to maxLength, appending an ellipsis if it was cut short.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}
