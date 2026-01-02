import { Command } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { Config } from '../config.js';

@ApplyOptions<Command.Options>({
  name: 'roll',
  description: 'Roll a number between 1 and 100 or between a custom from value and to value.',
})
export class RollCommand extends Command {
  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand(
      (builder) =>
        builder
          .setName(this.name)
          .setDescription(this.description)
          .addIntegerOption((option) =>
            option
              .setName('from')
              .setDescription('Floor value of the roll')
              .setRequired(false)
              .setMinValue(1)
          )
          .addIntegerOption((option) =>
            option
              .setName('to')
              .setDescription('Ceiling value of the roll')
              .setRequired(false)
              .setMinValue(1)
          ),
      // Register to specific guild if GUILD_ID is set (dev mode), otherwise register globally
      Config.discord.guildId ? { guildIds: [Config.discord.guildId] } : {}
    );
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    try {
      // Defer reply immediately to prevent timeout
      await interaction.deferReply();

      const fromValue = interaction.options.getInteger('from') ?? 1;
      const toValue   = interaction.options.getInteger('to') ?? 100;

      // Validate value is positive
      if (toValue <= 0) {
        await interaction.editReply({ content: '❌ Value must be greater than 0' });
        return;
      }

      // Validate value is positive
      if (fromValue <= 0) {
        await interaction.editReply({ content: '❌ Value must be greater than 0' });
        return;
      }

      if (fromValue >= toValue) {
        await interaction.editReply({ content: '❌ \'fromValue\' must be less than \'toValue\'' })
        return;
      }

      const roll = Math.floor(Math.random() * (toValue - fromValue + 1)) + fromValue;

      // Create success embed
      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle(`🎲 Roll From ${fromValue} to ${toValue}`)
        .setDescription(
          `${interaction.user} rolled a **${roll}**!`
        )

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      this.container.logger.error('Error in roll command:', error);

      const errorMessage = 'An error occurred while rolling. Please try again later.';

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: errorMessage });
        } else if (!interaction.replied) {
          await interaction.reply({ content: errorMessage, flags: MessageFlags.Ephemeral });
        }
      } catch (replyError) {
        this.container.logger.error('Failed to send error message:', replyError);
      }
    }
  }
}
