import { Listener } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { GuildMember, PartialGuildMember } from 'discord.js';
import { safeLogger as logger } from '../lib/safe-logger.js';

/**
 * GuildMemberRemove listener - Fires when a member leaves (or is kicked/banned from) a server
 *
 * Leaving the server deletes the member's voice streak; their streak role is deleted too
 * if no one else holds it. Receives partial members for uncached users (Partials.GuildMember).
 */
@ApplyOptions<Listener.Options>({
  event: 'guildMemberRemove',
})
export class GuildMemberRemoveListener extends Listener {
  public override async run(member: GuildMember | PartialGuildMember) {
    try {
      await this.container.streakService.handleMemberLeave(member.guild, member.id);
    } catch (error) {
      logger.error(`Error handling guildMemberRemove for ${member.id} in guild ${member.guild.id}:`, error);
    }
  }
}
