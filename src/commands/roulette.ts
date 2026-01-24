import { Command } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { ComponentType, MessageFlags, type ChatInputCommandInteraction, type ButtonInteraction } from 'discord.js';
import { Config } from '../config.js';
import { GameSource, GAME_BET_LIMITS, GAME_INTERACTION_TIMEOUT_MINUTES } from '../constants.js';
import {
  RouletteBetType,
  BTN_ID_RED,
  BTN_ID_BLACK,
  BTN_ID_ODD,
  BTN_ID_EVEN,
  BTN_ID_LOW,
  BTN_ID_HIGH,
  BTN_ID_SPIN,
  BTN_ID_PICK_NUMBER,
  BTN_ID_CLEAR,
  BTN_ID_CANCEL,
  BTN_ID_BACK,
  BTN_ID_PAGE_GREEN,
  BTN_ID_PAGE_1_12,
  BTN_ID_PAGE_13_24,
  BTN_ID_PAGE_25_36,
  type NumberPickerPage,
} from '../services/RouletteService.js';

/** Button ID to bet type mapping */
const BUTTON_TO_BET_TYPE: Record<string, RouletteBetType> = {
  [BTN_ID_RED]: RouletteBetType.RED,
  [BTN_ID_BLACK]: RouletteBetType.BLACK,
  [BTN_ID_ODD]: RouletteBetType.ODD,
  [BTN_ID_EVEN]: RouletteBetType.EVEN,
  [BTN_ID_LOW]: RouletteBetType.LOW,
  [BTN_ID_HIGH]: RouletteBetType.HIGH,
};

/** Page button ID to page mapping */
const PAGE_BUTTON_TO_PAGE: Record<string, NumberPickerPage> = {
  [BTN_ID_PAGE_GREEN]: 'green',
  [BTN_ID_PAGE_1_12]: '1-12',
  [BTN_ID_PAGE_13_24]: '13-24',
  [BTN_ID_PAGE_25_36]: '25-36',
};

@ApplyOptions<Command.Options>({
  name: 'roulette',
  description: 'Play American Roulette',
  preconditions: ['CasinoChannelOnly'],
})
export class RouletteCommand extends Command {
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
                `Base bet amount per wager (${GAME_BET_LIMITS.ROULETTE.MIN.toLocaleString()}-${GAME_BET_LIMITS.ROULETTE.MAX.toLocaleString()})`
              )
              .setRequired(false)
              .setMinValue(GAME_BET_LIMITS.ROULETTE.MIN)
              .setMaxValue(GAME_BET_LIMITS.ROULETTE.MAX)
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
      const baseBet = interaction.options.getInteger('bet') ?? GAME_BET_LIMITS.ROULETTE.MIN;
      const userId = interaction.user.id;
      const guildId = interaction.guildId!;

      // Ensure guild and user exist in database
      await this.container.walletService.ensureGuild(guildId, interaction.guild?.name);
      await this.container.walletService.ensureUser(userId, guildId, interaction.user.username);

      // Check for crashed game and recover
      await this.container.gameStateService.checkAndRecoverCrashedGame(userId, guildId, GameSource.ROULETTE);

      // Start the game and get the response message
      const response = await this.container.rouletteService.startGame(interaction, baseBet);

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
            content: "This isn't your roulette table. Start your own game with /roulette.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // Get the game instance from the service
        const game = this.container.rouletteService.getGame(userId, guildId);
        if (!game) {
          await buttonInteraction.reply({
            content: '🚫 No active roulette game found. Start a new game with **/roulette**.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        try {
          const customId = buttonInteraction.customId;
          let gameEnded = false;

          // Handle spin button
          if (customId === BTN_ID_SPIN) {
            gameEnded = await game.handleSpin(buttonInteraction);
          }
          // Handle cancel button
          else if (customId === BTN_ID_CANCEL) {
            gameEnded = await game.handleCancel(buttonInteraction);
          }
          // Handle clear button
          else if (customId === BTN_ID_CLEAR) {
            await game.handleClear(buttonInteraction);
          }
          // Handle pick number button (opens number picker)
          else if (customId === BTN_ID_PICK_NUMBER) {
            await game.handlePickNumber(buttonInteraction);
          }
          // Handle back to main button (exits number picker)
          else if (customId === BTN_ID_BACK) {
            await game.handleBackToMain(buttonInteraction);
          }
          // Handle page navigation buttons
          else if (PAGE_BUTTON_TO_PAGE[customId]) {
            await game.handlePageNavigation(buttonInteraction, PAGE_BUTTON_TO_PAGE[customId]);
          }
          // Handle number buttons (straight bets)
          else if (customId.startsWith('num_')) {
            const number = this.parseNumberFromCustomId(customId);
            if (number !== null) {
              await game.handleStraightBet(buttonInteraction, number);
            }
          }
          // Handle outside bet buttons (red, black, odd, even, low, high)
          else if (BUTTON_TO_BET_TYPE[customId]) {
            await game.handleOutsideBet(buttonInteraction, BUTTON_TO_BET_TYPE[customId]);
          }

          if (gameEnded) {
            collector.stop('completed');
          }
        } catch (error) {
          this.container.logger.error('Error handling roulette button:', error);

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
          await this.container.gameStateService.finishGame(userId, guildId, GameSource.ROULETTE);
          this.container.rouletteService.endGame(userId, guildId);

          if (reason === 'time') {
            this.container.logger.info(`Roulette game timed out for user ${userId}`);

            // Get the game to handle timeout
            const game = this.container.rouletteService.getGame(userId, guildId);
            if (game && game.getStatus() === 'betting') {
              await game.handleTimeout(interaction);
            }
          }
        } catch (error) {
          this.container.logger.error('Error cleaning up roulette game:', error);
        }
      });
    } catch (error) {
      this.container.logger.error('Error in roulette command:', error);

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: 'An error occurred while starting roulette. Please try again.',
        });
      } else {
        await interaction.reply({
          content: 'An error occurred while starting roulette. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  }

  private parseNumberFromCustomId(customId: string): number | '00' | null {
    if (!customId.startsWith('num_')) return null;
    const numStr = customId.slice(4);
    if (numStr === '00') return '00';
    const num = parseInt(numStr, 10);
    if (isNaN(num) || num < 0 || num > 36) return null;
    return num;
  }
}
