import { Command } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { ComponentType, MessageFlags, type ChatInputCommandInteraction, type ButtonInteraction } from 'discord.js';
import { Config } from '../config.js';
import { GameSource, GAME_BET_LIMITS, GAME_INTERACTION_TIMEOUT_MINUTES } from '../constants.js';

@ApplyOptions<Command.Options>({
  name: 'blackjack',
  description: 'Play Blackjack against the dealer',
  preconditions: ['CasinoChannelOnly'],
})
export class BlackjackCommand extends Command {
  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand(
      (builder) =>
        builder
          .setName(this.name)
          .setDescription(this.description)
          .addIntegerOption((option) =>
            option
              .setName('bet')
              .setDescription(
                `Bet amount (${GAME_BET_LIMITS.BLACKJACK.MIN}-${GAME_BET_LIMITS.BLACKJACK.MAX})`
              )
              .setRequired(false)
              .setMinValue(GAME_BET_LIMITS.BLACKJACK.MIN)
              .setMaxValue(GAME_BET_LIMITS.BLACKJACK.MAX)
          ),
      // Production: Always register globally for instant multi-guild support
      // Development: Register to specific guild for instant testing
      process.env.NODE_ENV === 'production'
        ? {} // Global registration
        : Config.discord.guildId
          ? { guildIds: [Config.discord.guildId] }
          : {}
    );
  }

  public override async chatInputRun(interaction: ChatInputCommandInteraction) {
    try {
      const bet = interaction.options.getInteger('bet') ?? GAME_BET_LIMITS.BLACKJACK.MIN;
      const userId = interaction.user.id;
      const guildId = interaction.guildId!;

      // Ensure guild and user exist in database with proper names
      await this.container.walletService.ensureGuild(guildId, interaction.guild?.name);
      await this.container.walletService.ensureUser(userId, guildId, interaction.user.username);

      // Check for crashed game and recover
      await this.container.gameStateService.checkAndRecoverCrashedGame(
        userId,
        guildId,
        GameSource.BLACKJACK
      );

      // Start the game and get the response message
      const response = await this.container.blackjackService.startGame(interaction, bet);

      // If no response, the game didn't start (error or validation failed)
      if (!response) {
        return;
      }

      // Create a collector for button interactions (consistent with other games)
      const collector = response.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: GAME_INTERACTION_TIMEOUT_MINUTES * 60 * 1000,
      });

      collector.on('collect', async (buttonInteraction: ButtonInteraction) => {
        // Ensure the button was clicked by the player
        if (buttonInteraction.user.id !== userId) {
          await buttonInteraction.reply({
            content: "This isn't your blackjack game.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // Get the game instance from the service
        const game = this.container.blackjackService.getGame(userId);
        if (!game) {
          await buttonInteraction.reply({
            content: '🚫 No active blackjack game found. Start a new game with **/blackjack**.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const customId = buttonInteraction.customId;

        try {
          // Route to the appropriate game method based on button clicked
          if (customId === 'bj_hit') {
            await game.hit(buttonInteraction);
          } else if (customId === 'bj_stand') {
            await game.stand(buttonInteraction);
          } else if (customId === 'bj_double') {
            await game.double(buttonInteraction);
          } else if (customId === 'bj_split') {
            await game.split(buttonInteraction);
          }
        } catch (error) {
          this.container.logger.error('Error handling blackjack button:', error);

          // Try to send error message if we haven't responded yet
          if (!buttonInteraction.replied && !buttonInteraction.deferred) {
            await buttonInteraction.reply({
              content: 'An error occurred. Please try again.',
              flags: MessageFlags.Ephemeral,
            });
          }
        }
      });

      collector.on('end', (_collected, reason) => {
        if (reason === 'time') {
          this.container.logger.info(`Blackjack game timed out for user ${userId}`);
        }
      });
    } catch (error) {
      this.container.logger.error('Error in blackjack command:', error);

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: 'An error occurred while starting Blackjack. Please try again.',
        });
      } else {
        await interaction.reply({
          content: 'An error occurred while starting Blackjack. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  }
}
