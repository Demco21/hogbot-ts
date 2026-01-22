/**
 * Shared game utilities
 *
 * Common functionality used across multiple game commands.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ComponentType,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type Message,
} from 'discord.js';

export interface TimeoutHandlerOptions {
  /** The original interaction to edit */
  interaction: ChatInputCommandInteraction;
  /** The message response from the interaction */
  response: Message;
  /** Custom footer text for the timeout message */
  footerText?: string;
  /** Logger for error handling */
  logger?: { error: (message: string, error?: unknown) => void };
}

const DEFAULT_TIMEOUT_FOOTER = '⏰ Game timed out, thanks for the donation!';

/**
 * Handle game timeout by disabling all buttons and updating the embed footer.
 *
 * This utility handles the common UI updates when a game times out:
 * 1. Fetches the current message state
 * 2. Disables all button components
 * 3. Updates the embed footer with a timeout message
 *
 * Note: Game-specific logic (logging losses, updating stats) should be handled
 * by the calling code before calling this function.
 */
export async function handleGameTimeoutUI(options: TimeoutHandlerOptions): Promise<void> {
  const { interaction, response, footerText = DEFAULT_TIMEOUT_FOOTER, logger } = options;

  try {
    const message = await response.fetch();
    const embeds = message.embeds;
    const components = message.components;

    // Type assertion needed due to complex discord.js v14.25+ component types
    const disabledComponents = (components as { components: { type: ComponentType }[] }[]).map((row) => {
      const actionRow = new ActionRowBuilder<ButtonBuilder>();
      for (const component of row.components) {
        if (component.type === ComponentType.Button) {
          const button = ButtonBuilder.from(component as Parameters<typeof ButtonBuilder.from>[0]);
          button.setDisabled(true);
          actionRow.addComponents(button);
        }
      }
      return actionRow;
    });

    if (embeds.length > 0) {
      const embed = EmbedBuilder.from(embeds[0]);
      embed.setFooter({ text: footerText });

      await interaction.editReply({
        embeds: [embed],
        components: disabledComponents,
      });
    } else {
      await interaction.editReply({
        components: disabledComponents,
      });
    }
  } catch (error) {
    logger?.error('Error handling game timeout UI:', error);
    // Fallback to just removing components
    await interaction.editReply({ components: [] }).catch(() => {});
  }
}
