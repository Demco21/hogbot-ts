import { Listener } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { VoiceState } from 'discord.js';
import { safeLogger as logger } from '../lib/safe-logger.js';

/**
 * VoiceStateUpdate listener - Fires when a user's voice state changes
 * Handles: joining voice, leaving voice, switching channels, mute/deafen (ignored)
 *
 * AFK Channel Exclusion:
 * - Uses guild.afkChannelId to automatically filter out Discord's built-in AFK channel
 * - Time spent in AFK channel is not tracked
 */
@ApplyOptions<Listener.Options>({
  event: 'voiceStateUpdate',
})
export class VoiceStateUpdateListener extends Listener {
  public override async run(oldState: VoiceState, newState: VoiceState) {
    try {
      const userId = newState.id;
      const guildId = newState.guild.id;

      // Get AFK channel ID for this guild (returns null if not set)
      const afkChannelId = newState.guild.afkChannelId;

      const wasInVoice = oldState.channelId !== null && oldState.channelId !== afkChannelId;
      const isInVoice = newState.channelId !== null && newState.channelId !== afkChannelId;

      // Case 1: User joined voice (wasn't in voice, now is)
      if (!wasInVoice && isInVoice) {
        logger.debug(`User ${userId} joined voice channel ${newState.channelId} in guild ${guildId}`);
        await this.container.voiceTimeService.trackVoiceJoin(userId, guildId, newState.channelId!);
        return;
      }

      // Case 2: User left voice (was in voice, now isn't)
      if (wasInVoice && !isInVoice) {
        logger.debug(`User ${userId} left voice in guild ${guildId}`);
        await this.container.voiceTimeService.trackVoiceLeave(userId, guildId);
        return;
      }

      // Case 3: User switched channels (was in voice, still in voice, but different channel)
      if (wasInVoice && isInVoice && oldState.channelId !== newState.channelId) {
        logger.debug(
          `User ${userId} switched from ${oldState.channelId} to ${newState.channelId} in guild ${guildId}`
        );
        // trackVoiceJoin handles channel switches internally
        await this.container.voiceTimeService.trackVoiceJoin(userId, guildId, newState.channelId!);
        return;
      }

      // Case 4: User muted/unmuted, deafened/undeafened (ignore - no channel change)
      // These events trigger voiceStateUpdate but we don't track them
    } catch (error) {
      logger.error('Error handling voiceStateUpdate:', error);
      // Don't throw - this is a listener, errors should not crash the bot
    }
  }
}
