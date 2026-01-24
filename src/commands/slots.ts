import { Command } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { ComponentType, MessageFlags, type ChatInputCommandInteraction, type ButtonInteraction } from 'discord.js';
import { Config } from '../config.js';
import { GameSource, GAME_BET_LIMITS, GAME_INTERACTION_TIMEOUT_MINUTES } from '../constants.js';
import { SlotsService, BTN_ID_CRANK } from '../services/SlotsService.js';
import { handleGameTimeoutUI } from '../utils/game-utils.js';

@ApplyOptions<Command.Options>({
  name: 'slots',
  description: 'Play the Hog Pen Slots with progressive jackpot',
  preconditions: ['CasinoChannelOnly'],
})
export class SlotsCommand extends Command {
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
                `Bet amount (${GAME_BET_LIMITS.SLOTS.MIN.toLocaleString()}-${GAME_BET_LIMITS.SLOTS.MAX.toLocaleString()})`
              )
              .setRequired(false)
              .setMinValue(GAME_BET_LIMITS.SLOTS.MIN)
              .setMaxValue(GAME_BET_LIMITS.SLOTS.MAX)
          ),
      process.env.NODE_ENV === 'production'
        ? {}
        : Config.discord.guildId
          ? { guildIds: [Config.discord.guildId] }
          : {}
    );
  }

  public override async chatInputRun(interaction: ChatInputCommandInteraction) {
    try {
      const bet = interaction.options.getInteger('bet') ?? GAME_BET_LIMITS.SLOTS.MIN;
      const userId = interaction.user.id;
      const guildId = interaction.guildId!;

      // Ensure guild and user exist in database
      await this.container.walletService.ensureGuild(guildId, interaction.guild?.name);
      await this.container.walletService.ensureUser(userId, guildId, interaction.user.username);

      // Check for crashed game and recover
      await this.container.gameStateService.checkAndRecoverCrashedGame(userId, guildId, GameSource.SLOTS);

      // Start the game and get the response message
      const response = await this.container.slotsService.startGame(interaction, bet);

      // If no response, the game didn't start (error or validation failed)
      if (!response) {
        return;
      }

      // Create a collector for button interactions
      const collector = response.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: GAME_INTERACTION_TIMEOUT_MINUTES * 60 * 1000,
      });

      collector.on('collect', async (buttonInteraction: ButtonInteraction) => {
        // Ensure the button was clicked by the player
        if (buttonInteraction.user.id !== userId) {
          await buttonInteraction.reply({
            content: "This isn't your slot machine. Go start your own spin. 🎰",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // Get the game instance from the service
        const game = this.container.slotsService.getGame(userId);
        if (!game) {
          await buttonInteraction.reply({
            content: '🚫 No active slots game found. Start a new game with **/slots**.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        try {
          // Handle the crank button click
          if (buttonInteraction.customId === BTN_ID_CRANK) {
            const gameEnded = await game.handleCrank(
              buttonInteraction,
              this.container.slotsService.contributeToJackpotBound,
              this.container.slotsService.resetJackpotBound,
              this.container.slotsService.getJackpotBound
            );

            if (gameEnded) {
              collector.stop('completed');
            }
          }
        } catch (error) {
          this.container.logger.error('Error handling slots button:', error);

          if (!buttonInteraction.replied && !buttonInteraction.deferred) {
            await buttonInteraction.reply({
              content: 'An error occurred. Please try again.',
              flags: MessageFlags.Ephemeral,
            });
          }
        }
      });

      collector.on('end', async (_collected, reason) => {
        try {
          // Finish game in database
          await this.container.gameStateService.finishGame(userId, guildId, GameSource.SLOTS);

          if (reason === 'time') {
            this.container.logger.info(`Slots game timed out for user ${userId}`);

            // Get the game to handle timeout stats
            const game = this.container.slotsService.getGame(userId);
            if (game) {
              await game.handleTimeout();
            }

            // Update UI with timeout state
            await handleGameTimeoutUI({
              interaction,
              response,
              footerText: SlotsService.FOOTER_TIMEOUT,
              logger: this.container.logger,
            });
          }
        } catch (error) {
          this.container.logger.error('Error cleaning up slots game:', error);
        }
      });
    } catch (error) {
      this.container.logger.error('Error in slots command:', error);

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: 'An error occurred while starting the slot machine. Please try again.',
        });
      } else {
        await interaction.reply({
          content: 'An error occurred while starting the slot machine. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  }
}
