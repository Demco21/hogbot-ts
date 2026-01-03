import { Command } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { Config } from '../config.js';
import { formatDuration } from '../lib/utils.js';

/**
 * VoiceTime command - Show voice channel time stats
 *
 * Usage:
 * - /voicetime (no params) - Show your own stats
 * - /voicetime user:@mention - Show another user's stats
 * - /voicetime leaderboard:week - Show weekly top 10
 * - /voicetime leaderboard:alltime - Show all-time top 10
 */
@ApplyOptions<Command.Options>({
  name: 'voicetime',
  description: 'View voice channel time statistics',
  // NO preconditions - usable in any channel
})
export class VoiceTimeCommand extends Command {
  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand(
      (builder) =>
        builder
          .setName(this.name)
          .setDescription(this.description)
          .addUserOption((option) =>
            option
              .setName('user')
              .setDescription('View stats for a specific user')
              .setRequired(false)
          )
          .addStringOption((option) =>
            option
              .setName('leaderboard')
              .setDescription('Show leaderboard for a specific period')
              .addChoices(
                { name: 'Weekly (Last 7 Days)', value: 'week' },
                { name: 'All-Time', value: 'alltime' }
              )
              .setRequired(false)
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

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    try {
      // Defer reply immediately to prevent timeout (don't check deferred/replied status)
      await interaction.deferReply();

      const guildId = interaction.guildId!;
      const leaderboardOption = interaction.options.getString('leaderboard');
      const userOption = interaction.options.getUser('user');

      // Case 1: Leaderboard view
      if (leaderboardOption) {
        await this.showLeaderboard(interaction, guildId, leaderboardOption as 'week' | 'alltime');
        return;
      }

      // Case 2: User stats view (self or mentioned user)
      const targetUser = userOption ?? interaction.user;
      await this.showUserStats(interaction, guildId, targetUser.id);
    } catch (error) {
      this.container.logger.error('Error in voicetime command:', error);

      // Attempt to send error message
      try {
        await interaction.editReply({
          content: 'An error occurred while fetching voice time stats. Please try again later.',
        });
      } catch (replyError) {
        // Interaction expired or already handled - silently fail
        this.container.logger.debug('Could not send error reply (interaction expired)');
      }
    }
  }

  /**
   * Show user's voice time stats (weekly + all-time + active session indicator)
   */
  private async showUserStats(
    interaction: Command.ChatInputCommandInteraction,
    guildId: string,
    userId: string
  ): Promise<void> {
    const stats = await this.container.voiceTimeService.getUserStats(userId, guildId);

    if (!stats) {
      await interaction.editReply({
        content: `<@${userId}> has not spent any time in voice channels yet.`,
      });
      return;
    }

    // Build embed
    const embed = new EmbedBuilder()
      .setColor(0x5865f2) // Discord blurple
      .setTitle(`🎙️ Voice Time Stats`)
      .setDescription(`**User:** <@${userId}>`)
      .addFields(
        {
          name: '📅 This Week (Last 7 Days)',
          value: formatDuration(stats.weekly_seconds),
          inline: true,
        },
        {
          name: '📊 All-Time Total',
          value: formatDuration(stats.total_seconds),
          inline: true,
        }
      )
      .setFooter({ text: 'Excludes time spent in AFK channel' })
      .setTimestamp();

    // Add active session indicator if user is currently in voice
    if (stats.active_session_seconds > 0) {
      embed.addFields({
        name: '🔴 Currently in Voice',
        value: `${formatDuration(stats.active_session_seconds)} this session`,
        inline: false,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  }

  /**
   * Show voice time leaderboard (weekly or all-time)
   */
  private async showLeaderboard(
    interaction: Command.ChatInputCommandInteraction,
    guildId: string,
    period: 'week' | 'alltime'
  ): Promise<void> {
    const topUsers = await this.container.voiceTimeService.getTopUsers(guildId, period, 10);

    if (topUsers.length === 0) {
      const periodLabel = period === 'week' ? 'this week' : 'all-time';
      await interaction.editReply({
        content: `📊 No voice time data found for ${periodLabel} yet!`,
      });
      return;
    }

    // Build leaderboard display
    const leaderboardLines = topUsers.map((user, index) => {
      const rank = index + 1;
      const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`;
      const timeStr = formatDuration(user.seconds);

      return `${medal} <@${user.user_id}> — ${timeStr}`;
    });

    const periodLabel = period === 'week' ? 'Weekly (Last 7 Days)' : 'All-Time';
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`🎙️ Voice Time Leaderboard - ${periodLabel}`)
      .setDescription(leaderboardLines.join('\n'))
      .setFooter({ text: 'Excludes time spent in AFK channel • Includes active sessions' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
}
