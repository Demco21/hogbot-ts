import { Command } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { Config } from '../config.js';
import { formatCoins } from '../lib/utils.js';

/**
 * Leaderboard command - Shows the top 10 richest users
 */
@ApplyOptions<Command.Options>({
  name: 'leaderboard',
  description: 'View the top 10 richest users',
})
export class LeaderboardCommand extends Command {
  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand(
      (builder) => builder.setName(this.name).setDescription(this.description),
      // Register to specific guild if GUILD_ID is set (dev mode), otherwise register globally
      Config.discord.guildId ? { guildIds: [Config.discord.guildId] } : {}
    );
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    try {
      // Defer reply immediately to prevent timeout
      await interaction.deferReply();

      const guildId = interaction.guildId!;

      // Get top 10 users
      const topUsers = await this.container.leaderboardService.getTopUsers(guildId, 10);

      if (topUsers.length === 0) {
        await interaction.editReply({ content: '📊 No users found in the leaderboard yet!' });
        return;
      }

      // Build leaderboard display with real-time username updates
      const leaderboardLines = await Promise.all(
        topUsers.map(async (user, index) => {
          const rank = index + 1;
          const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`;

          // Try to fetch real Discord username, fallback to database username
          let displayName = user.username;
          try {
            const member = await interaction.guild?.members.fetch(user.user_id);
            if (member) {
              displayName = member.user.username;
              // Update database with fresh username
              await this.container.walletService.updateUsername(user.user_id, guildId, displayName);
            }
          } catch (error) {
            // User might have left server, use database username
            this.container.logger.debug(`Could not fetch member ${user.user_id}:`, error);
          }

          // Use Discord mention format instead of plain text
          return `${medal} <@${user.user_id}> — ${formatCoins(user.balance)}`;
        })
      );

      // Create embed
      const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle('🏆 Leaderboard - Top 10 Richest Users')
        .setDescription(leaderboardLines.join('\n'))
        .setFooter({ text: 'Keep gambling to climb the ranks!' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      this.container.logger.error('Error in leaderboard command:', error);

      const errorMessage = 'An error occurred while fetching the leaderboard. Please try again later.';

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
