import { Listener } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { Role } from 'discord.js';
import { safeLogger as logger } from '../lib/safe-logger.js';

/**
 * RoleDelete listener - Fires when a role is deleted
 *
 * If someone deletes a HogBot voice streak role by hand, StreakService forgets it and
 * gives the affected members a replacement so nobody silently loses their streak role.
 */
@ApplyOptions<Listener.Options>({
  event: 'roleDelete',
})
export class RoleDeleteListener extends Listener {
  public override async run(role: Role) {
    try {
      await this.container.streakService.handleRoleDelete(role);
    } catch (error) {
      logger.error(`Error handling roleDelete for ${role.id} in guild ${role.guild.id}:`, error);
    }
  }
}
