import { Listener } from '@sapphire/framework';
import { ChatInputCommandDeniedPayload, Events } from '@sapphire/framework';
import { MessageFlags } from 'discord.js';

/**
 * Listener for handling precondition failures (like CasinoChannelOnly)
 * Sends user-friendly error messages instead of "Application did not respond"
 */
export class CommandDeniedListener extends Listener<typeof Events.ChatInputCommandDenied> {
  public constructor(context: Listener.LoaderContext) {
    super(context, {
      event: Events.ChatInputCommandDenied,
    });
  }

  public async run(error: any, payload: ChatInputCommandDeniedPayload) {
    // Extract the error message from the precondition
    const message = error.message || 'You do not have permission to use this command.';

    try {
      // Reply to the interaction with an ephemeral message
      if (payload.interaction.deferred || payload.interaction.replied) {
        // If already deferred/replied, edit the reply
        await payload.interaction.editReply({
          content: `❌ ${message}`,
        });
      } else {
        // Otherwise, send a new ephemeral reply
        await payload.interaction.reply({
          content: `❌ ${message}`,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (replyError) {
      // If we can't send the error message, log it
      this.container.logger.error('Failed to send precondition error message:', replyError);
    }
  }
}
