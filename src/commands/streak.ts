import { Command } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { Config } from '../config.js';
import { EMBED_COLORS, STREAK_CONFIG } from '../constants.js';
import type { StreakLeaderboardType } from '../services/StreakService.js';
import { getNextDayStart } from '../utils/date-utils.js';

/**
 * Streak command - Show daily voice streaks
 *
 * Usage:
 * - /streak (no params) - Show your own streak
 * - /streak user:@mention - Show another user's streak
 * - /streak leaderboard:current - Top active streaks
 * - /streak leaderboard:longest - Top all-time longest streaks
 */
@ApplyOptions<Command.Options>({
  name: 'streak',
  description: 'View daily voice channel streaks',
  // NO preconditions - usable in any channel
})
export class StreakCommand extends Command {
  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand(
      (builder) =>
        builder
          .setName(this.name)
          .setDescription(this.description)
          .addUserOption((option) =>
            option.setName('user').setDescription('View the streak of a specific user').setRequired(false)
          )
          .addStringOption((option) =>
            option
              .setName('leaderboard')
              .setDescription('Show a streak leaderboard')
              .addChoices(
                { name: 'Current Streaks', value: 'current' },
                { name: 'Longest Ever', value: 'longest' }
              )
              .setRequired(false)
          ),
      // Global in production; scoped to Config.discord.guildId in development (if set)
      // for instant command updates while testing
      process.env.NODE_ENV === 'production'
        ? {}
        : Config.discord.guildId
          ? { guildIds: [Config.discord.guildId] }
          : {}
    );
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    try {
      const guildId = interaction.guildId!;

      const { streaksEnabled } = await this.container.guildSettingsService.getAllSettings(guildId);
      if (!streaksEnabled) {
        await interaction.reply({
          content: '🔥 Voice streaks aren\'t enabled on this server. An admin can turn them on with `/config`.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const leaderboardOption = interaction.options.getString('leaderboard') as StreakLeaderboardType | null;
      if (leaderboardOption) {
        await this.showLeaderboard(interaction, guildId, leaderboardOption);
        return;
      }

      const targetUser = interaction.options.getUser('user') ?? interaction.user;
      await this.showUserStreak(interaction, guildId, targetUser.id);
    } catch (error) {
      this.container.logger.error('Error in streak command:', error);
      const errorReply = { content: 'An error occurred while fetching streaks.', flags: MessageFlags.Ephemeral } as const;
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorReply).catch(() => {});
      } else {
        await interaction.reply(errorReply).catch(() => {});
      }
    }
  }

  private async showUserStreak(
    interaction: Command.ChatInputCommandInteraction,
    guildId: string,
    userId: string
  ): Promise<void> {
    const streak = await this.container.streakService.getStreak(guildId, userId);
    const isSelf = userId === interaction.user.id;

    const timezone = await this.container.guildSettingsService.getTimezone(guildId);
    const resetTimestamp = Math.floor(getNextDayStart(timezone, STREAK_CONFIG.DAY_START_HOUR).getTime() / 1000);

    let status: string;
    if (!streak || streak.currentStreak === 0) {
      status = isSelf
        ? 'No active streak - join any voice channel to start one!'
        : 'No active streak.';
    } else if (streak.activeToday) {
      status = `✅ Today counted - next day starts <t:${resetTimestamp}:R>`;
    } else {
      status = `⏳ Not counted yet today - join voice before <t:${resetTimestamp}:t> (<t:${resetTimestamp}:R>) to keep it!`;
    }

    const currentStreak = streak?.currentStreak ?? 0;
    const embed = new EmbedBuilder()
      .setColor(STREAK_CONFIG.ROLE_COLOR)
      .setTitle('🔥 Voice Streak')
      .setDescription(`**User:** <@${userId}>`)
      .addFields(
        { name: '🔥 Current Streak', value: formatDays(currentStreak), inline: true },
        { name: '🏆 Longest Streak', value: formatDays(streak?.longestStreak ?? 0), inline: true },
        { name: '📅 Today', value: status, inline: false }
      )
      .setFooter({ text: 'Join any voice channel once a day to keep your streak • AFK channel excluded' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  }

  private async showLeaderboard(
    interaction: Command.ChatInputCommandInteraction,
    guildId: string,
    type: StreakLeaderboardType
  ): Promise<void> {
    const topStreaks = await this.container.streakService.getTopStreaks(guildId, type, STREAK_CONFIG.LEADERBOARD_SIZE);

    if (topStreaks.length === 0) {
      await interaction.reply({
        content:
          type === 'current'
            ? '🔥 Nobody has an active voice streak right now - join a voice channel to start one!'
            : '🔥 No voice streaks recorded yet!',
      });
      return;
    }

    const lines = topStreaks.map((entry, index) => {
      const rank = index + 1;
      const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`;
      const days = type === 'current' ? entry.currentStreak : entry.longestStreak;
      return `${medal} <@${entry.userId}> - ${formatDays(days)}`;
    });

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLORS.GOLD)
      .setTitle(`🔥 Voice Streak Leaderboard - ${type === 'current' ? 'Current Streaks' : 'Longest Ever'}`)
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'Join any voice channel once a day to keep your streak' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  }
}

function formatDays(days: number): string {
  return `${days} day${days === 1 ? '' : 's'}`;
}
