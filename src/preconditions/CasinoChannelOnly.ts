import { Precondition } from '@sapphire/framework';
import type { CommandInteraction, ContextMenuCommandInteraction, Message } from 'discord.js';

/**
 * Precondition to restrict casino commands to the casino channel only
 * Uses per-guild casino channel configuration from database
 * If no channel is configured, allows commands in all channels
 */
export class CasinoChannelOnlyPrecondition extends Precondition {
  public override async messageRun(message: Message) {
    if (!message.guildId) {
      return this.error({ message: 'This command can only be used in a server.' });
    }
    return await this.checkChannel(message.channelId, message.guildId);
  }

  public override async chatInputRun(interaction: CommandInteraction) {
    if (!interaction.guildId) {
      return this.error({ message: 'This command can only be used in a server.' });
    }
    return await this.checkChannel(interaction.channelId, interaction.guildId);
  }

  public override async contextMenuRun(interaction: ContextMenuCommandInteraction) {
    if (!interaction.guildId) {
      return this.error({ message: 'This command can only be used in a server.' });
    }
    return await this.checkChannel(interaction.channelId, interaction.guildId);
  }

  private async checkChannel(channelId: string, guildId: string) {
    try {
      // Check if guildSettingsService is available
      if (!this.container.guildSettingsService) {
        this.container.logger.error('CasinoChannelOnly precondition: guildSettingsService not available');
        // Fail-open: allow command if service not available
        return this.ok();
      }

      // Get casino channel configuration for this guild
      const casinoChannelId = await this.container.guildSettingsService.getCasinoChannelId(guildId);

      // If no casino channel is configured, allow everywhere
      if (!casinoChannelId) {
        return this.ok();
      }

      // Check if current channel matches configured casino channel
      if (channelId === casinoChannelId) {
        return this.ok();
      }

      return this.error({
        message: `This command can only be used in <#${casinoChannelId}>`,
      });
    } catch (error) {
      // Log error but allow command to proceed (fail-open for safety)
      this.container.logger.error('CasinoChannelOnly precondition error:', error);
      // Allow the command to run if there's a database error
      return this.ok();
    }
  }
}

declare module '@sapphire/framework' {
  interface Preconditions {
    CasinoChannelOnly: never;
  }
}
