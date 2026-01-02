import { Listener } from '@sapphire/framework';
import { ChatInputCommandErrorPayload, Events } from '@sapphire/framework';
import { MessageFlags } from 'discord.js';

/**
 * Listener for handling command runtime errors
 * Sends user-friendly error messages and logs errors for debugging
 */
export class CommandErrorListener extends Listener<typeof Events.ChatInputCommandError> {
  public constructor(context: Listener.LoaderContext) {
    super(context, {
      event: Events.ChatInputCommandError,
    });
  }

  public async run(error: Error, payload: ChatInputCommandErrorPayload) {
    // Log the error for debugging
    this.container.logger.error(`Error in command ${payload.command.name}:`, error);

    const userMessage = 'An error occurred while executing this command. Please try again later.';

    try {
      // Reply to the interaction with an ephemeral message
      if (payload.interaction.deferred || payload.interaction.replied) {
        // If already deferred/replied, edit the reply
        await payload.interaction.editReply({
          content: `❌ ${userMessage}`,
        });
      } else {
        // Otherwise, send a new ephemeral reply
        await payload.interaction.reply({
          content: `❌ ${userMessage}`,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (replyError) {
      // If we can't send the error message, log it
      this.container.logger.error('Failed to send command error message:', replyError);
    }
  }
}
