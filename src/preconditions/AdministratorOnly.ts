import { Precondition } from '@sapphire/framework';
import type { CommandInteraction, ContextMenuCommandInteraction, Message } from 'discord.js';

/**
 * Precondition to restrict commands to server administrators only
 */
export class AdministratorOnlyPrecondition extends Precondition {
  public override async messageRun(message: Message) {
    return this.checkAdminPermission(message.member?.permissions);
  }

  public override async chatInputRun(interaction: CommandInteraction) {
    return this.checkAdminPermission(interaction.memberPermissions);
  }

  public override async contextMenuRun(interaction: ContextMenuCommandInteraction) {
    return this.checkAdminPermission(interaction.memberPermissions);
  }

  private checkAdminPermission(permissions: any) {
    if (permissions?.has('Administrator')) {
      return this.ok();
    }

    return this.error({
      message: '❌ This command requires Administrator permission',
    });
  }
}

declare module '@sapphire/framework' {
  interface Preconditions {
    AdministratorOnly: never;
  }
}
