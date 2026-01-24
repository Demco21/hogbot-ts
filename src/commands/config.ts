import { Command } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelType,
  ComponentType,
  MessageFlags,
} from 'discord.js';
import { EMBED_COLORS } from '../constants.js';

@ApplyOptions<Command.Options>({
  name: 'config',
  description: 'Configure HogBot settings for this server (Admin only)',
  preconditions: ['AdministratorOnly'],
})
export class ConfigCommand extends Command {
  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand((builder) => builder.setName(this.name).setDescription(this.description));
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    const guildId = interaction.guildId!;
    const guild = interaction.guild!;

    try {
      // Initialize guild if not exists
      await this.container.guildSettingsService.initializeGuild(guildId, guild.name);

      // Get current settings
      const settings = await this.container.guildSettingsService.getAllSettings(guildId);

      // Build the config embed
      const embed = await this.buildConfigEmbed(guild.name, settings, guild);

      // Build action buttons
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('config_casino_channel')
          .setLabel('Set Casino Channel')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🎲'),
        new ButtonBuilder()
          .setCustomId('config_richest_role')
          .setLabel('Set Richest Role')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('👑'),
        new ButtonBuilder()
          .setCustomId('config_beers_channel')
          .setLabel('Set Beers Channel')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🍺'),
        new ButtonBuilder()
          .setCustomId('config_reset')
          .setLabel('Reset All')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🔄')
      );

      const response = await interaction.reply({
        embeds: [embed],
        components: [row],
        flags: MessageFlags.Ephemeral,
      });

      // Create collector for button interactions
      const collector = response.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 300000, // 5 minutes
      });

      collector.on('collect', async (buttonInteraction) => {
        if (buttonInteraction.user.id !== interaction.user.id) {
          await buttonInteraction.reply({
            content: 'Only the command user can interact with these buttons.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        try {
          if (buttonInteraction.customId === 'config_casino_channel') {
            await this.handleCasinoChannelConfig(buttonInteraction, guildId, guild);
          } else if (buttonInteraction.customId === 'config_richest_role') {
            await this.handleRichestRoleConfig(buttonInteraction, guildId, guild);
          } else if (buttonInteraction.customId === 'config_beers_channel') {
            await this.handleBeersChannelConfig(buttonInteraction, guildId, guild);
          } else if (buttonInteraction.customId === 'config_reset') {
            await this.handleResetConfig(buttonInteraction, guildId, guild);
          }
        } catch (error) {
          this.container.logger.error('Error handling config button interaction:', error);
          await buttonInteraction.reply({
            content: 'An error occurred while processing your request.',
            flags: MessageFlags.Ephemeral,
          });
        }
      });

      collector.on('end', () => {
        // Disable buttons after timeout
        interaction
          .editReply({
            components: [],
          })
          .catch(() => {
            // Ignore errors if message was deleted
          });
      });
    } catch (error) {
      this.container.logger.error('Error in config command:', error);
      await interaction.reply({
        content: 'An error occurred while loading configuration.',
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  private async buildConfigEmbed(
    guildName: string,
    settings: {
      richestMemberRoleId: string | null;
      casinoChannelId: string | null;
      beersChannelId: string | null;
      beersTimezone: string | null;
      guildName: string | null
    },
    guild: Command.ChatInputCommandInteraction['guild']
  ): Promise<EmbedBuilder> {
    // Resolve channel and role names
    const casinoChannelName = settings.casinoChannelId
      ? `<#${settings.casinoChannelId}>`
      : '*Not set (gambling allowed everywhere)*';

    const richestRoleName = settings.richestMemberRoleId
      ? guild?.roles.cache.get(settings.richestMemberRoleId)?.name || '*Role not found*'
      : '*Not set (feature disabled)*';

    const beersChannelName = settings.beersChannelId
      ? `<#${settings.beersChannelId}>`
      : '*Not set (feature disabled)*';

    const beersTimezone = settings.beersTimezone || 'America/New_York';

    return new EmbedBuilder()
      .setColor(EMBED_COLORS.INFO)
      .setTitle(`🎰 HogBot Configuration - ${guildName}`)
      .setDescription('Configure bot settings for your server using the buttons below.')
      .addFields(
        {
          name: '🎲 Casino Channel',
          value: casinoChannelName,
          inline: false,
        },
        {
          name: '👑 Richest Member Role',
          value: richestRoleName,
          inline: false,
        },
        {
          name: '🍺 Beers Channel',
          value: settings.beersChannelId
            ? `${beersChannelName}\n*Timezone: ${beersTimezone}*`
            : beersChannelName,
          inline: false,
        }
      )
      .setFooter({ text: 'Use the buttons below to modify settings' })
      .setTimestamp();
  }

  private async handleCasinoChannelConfig(
    interaction: Command.ChatInputCommandInteraction | any,
    guildId: string,
    guild: Command.ChatInputCommandInteraction['guild']
  ) {
    // Create channel select menu
    const selectMenu = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('select_casino_channel')
        .setPlaceholder('Select a channel for casino commands')
        .setChannelTypes(ChannelType.GuildText)
    );

    const removeButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('remove_casino_channel')
        .setLabel('Allow in All Channels')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🌐')
    );

    await interaction.reply({
      content: '**Select Casino Channel**\n\nChoose a channel where gambling commands can be used, or click "Allow in All Channels" to remove the restriction.',
      components: [selectMenu, removeButton],
      flags: MessageFlags.Ephemeral,
    });

    // Wait for selection
    const response = await interaction.fetchReply();
    const collector = response.createMessageComponentCollector({
      time: 60000, // 1 minute
    });

    collector.on('collect', async (i: any) => {
      if (i.user.id !== interaction.user.id) {
        await i.reply({ content: 'Only the command user can interact with this.', flags: MessageFlags.Ephemeral });
        return;
      }

      try {
        if (i.customId === 'select_casino_channel' && i.isChannelSelectMenu()) {
          const selectedChannelId = i.values[0];
          await this.container.guildSettingsService.setCasinoChannelId(guildId, selectedChannelId);

          await i.update({
            content: `✅ Casino channel set to <#${selectedChannelId}>\n\nGambling commands can now only be used in that channel.`,
            components: [],
          });
        } else if (i.customId === 'remove_casino_channel') {
          await this.container.guildSettingsService.setCasinoChannelId(guildId, null);

          await i.update({
            content: '✅ Casino channel restriction removed.\n\nGambling commands can now be used in all channels.',
            components: [],
          });
        }

        collector.stop();
      } catch (error) {
        this.container.logger.error('Error setting casino channel:', error);
        await i.reply({ content: 'An error occurred while updating the setting.', flags: MessageFlags.Ephemeral });
      }
    });

    collector.on('end', (collected: any) => {
      if (collected.size === 0) {
        interaction.editReply({ content: 'Selection timed out.', components: [] }).catch(() => {});
      }
    });
  }

  private async handleRichestRoleConfig(
    interaction: Command.ChatInputCommandInteraction | any,
    guildId: string,
    guild: Command.ChatInputCommandInteraction['guild']
  ) {
    // Create role select menu
    const selectMenu = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId('select_richest_role')
        .setPlaceholder('Select a role for the richest member')
    );

    const removeButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('remove_richest_role')
        .setLabel('Disable Feature')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('❌')
    );

    await interaction.reply({
      content:
        '**Select Richest Member Role**\n\n' +
        'Choose a role to automatically assign to the user with the highest balance, or click "Disable Feature" to turn it off.',
      components: [selectMenu, removeButton],
      flags: MessageFlags.Ephemeral,
    });

    // Wait for selection
    const response = await interaction.fetchReply();
    const collector = response.createMessageComponentCollector({
      time: 60000, // 1 minute
    });

    collector.on('collect', async (i: any) => {
      if (i.user.id !== interaction.user.id) {
        await i.reply({ content: 'Only the command user can interact with this.', flags: MessageFlags.Ephemeral });
        return;
      }

      try {
        if (i.customId === 'select_richest_role' && i.isRoleSelectMenu()) {
          const selectedRoleId = i.values[0];
          const role = guild?.roles.cache.get(selectedRoleId);

          if (!role) {
            await i.reply({ content: 'Role not found.', flags: MessageFlags.Ephemeral });
            return;
          }

          // Validate role hierarchy
          const botMember = guild?.members.me;
          if (!botMember) {
            await i.reply({ content: 'Unable to verify bot permissions.', flags: MessageFlags.Ephemeral });
            return;
          }

          if (!botMember.permissions.has('ManageRoles')) {
            await i.update({
              content:
                '❌ I need the **Manage Roles** permission to assign the richest member role.\n' +
                'Please grant me this permission and try again.',
              components: [],
            });
            return;
          }

          if (role.position >= botMember.roles.highest.position) {
            await i.update({
              content:
                `❌ I cannot manage the role **${role.name}** because it is higher than or equal to my highest role in the role hierarchy.\n\n` +
                'Please either:\n' +
                '1. Move my role above the target role in Server Settings → Roles\n' +
                '2. Choose a different role that is below my highest role',
              components: [],
            });
            return;
          }

          await this.container.guildSettingsService.setRichestMemberRoleId(guildId, selectedRoleId);
          await this.container.leaderboardService.updateRichestMemberForGuild(guildId);

          await i.update({
            content: `✅ Richest member role set to **${role.name}**\n\nThe role will be automatically assigned to the user with the highest balance.`,
            components: [],
          });
        } else if (i.customId === 'remove_richest_role') {
          await this.container.guildSettingsService.setRichestMemberRoleId(guildId, null);

          await i.update({
            content: '✅ Richest member feature disabled.',
            components: [],
          });
        }

        collector.stop();
      } catch (error) {
        this.container.logger.error('Error setting richest role:', error);
        await i.reply({ content: 'An error occurred while updating the setting.', flags: MessageFlags.Ephemeral });
      }
    });

    collector.on('end', (collected: any) => {
      if (collected.size === 0) {
        interaction.editReply({ content: 'Selection timed out.', components: [] }).catch(() => {});
      }
    });
  }

  private async handleBeersChannelConfig(
    interaction: Command.ChatInputCommandInteraction | any,
    guildId: string,
    guild: Command.ChatInputCommandInteraction['guild']
  ) {
    // Create voice channel select menu
    const selectMenu = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('select_beers_channel')
        .setPlaceholder('Select a voice channel for daily beers')
        .setChannelTypes(ChannelType.GuildVoice)
    );

    const removeButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('remove_beers_channel')
        .setLabel('Disable Feature')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('❌')
    );

    await interaction.reply({
      content:
        '**Configure Beers Channel**\n\n' +
        'Select a voice channel that will be automatically renamed each day:\n' +
        '• Monday: 🍺 Monday Beers\n' +
        '• Tuesday: 🍺 Tuesday Beers\n' +
        '• etc.\n\n' +
        'Click "Disable Feature" to turn off automatic renaming.',
      components: [selectMenu, removeButton],
      flags: MessageFlags.Ephemeral,
    });

    // Wait for selection
    const response = await interaction.fetchReply();
    const collector = response.createMessageComponentCollector({
      time: 60000, // 1 minute
    });

    collector.on('collect', async (i: any) => {
      if (i.user.id !== interaction.user.id) {
        await i.reply({ content: 'Only the command user can interact with this.', flags: MessageFlags.Ephemeral });
        return;
      }

      try {
        if (i.customId === 'select_beers_channel' && i.isChannelSelectMenu()) {
          const selectedChannelId = i.values[0];

          // Now show timezone selector
          const timezoneOptions = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('tz_eastern').setLabel('Eastern (ET)').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tz_central').setLabel('Central (CT)').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tz_mountain').setLabel('Mountain (MT)').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tz_pacific').setLabel('Pacific (PT)').setStyle(ButtonStyle.Primary)
          );

          const timezoneOptions2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('tz_utc').setLabel('UTC').setStyle(ButtonStyle.Secondary)
          );

          await i.update({
            content: `✅ Beers channel set to <#${selectedChannelId}>\n\n**Now select your timezone:**\nThis determines when the channel name changes each day (at midnight).`,
            components: [timezoneOptions, timezoneOptions2],
          });

          // Create new collector for timezone selection
          const tzCollector = response.createMessageComponentCollector({
            time: 60000,
          });

          tzCollector.on('collect', async (tzInteraction: any) => {
            if (tzInteraction.user.id !== interaction.user.id) {
              await tzInteraction.reply({
                content: 'Only the command user can interact with this.',
                flags: MessageFlags.Ephemeral,
              });
              return;
            }

            const timezoneMap: Record<string, string> = {
              tz_eastern: 'America/New_York',
              tz_central: 'America/Chicago',
              tz_mountain: 'America/Denver',
              tz_pacific: 'America/Los_Angeles',
              tz_utc: 'UTC',
            };

            const timezone = timezoneMap[tzInteraction.customId];
            if (timezone) {
              await this.container.guildSettingsService.setBeersChannelId(guildId, selectedChannelId);
              await this.container.guildSettingsService.setBeersTimezone(guildId, timezone);

              // Immediately rename the channel to today's name for instant feedback
              const renameResult = await this.container.guildSettingsService.renameBeersChannel(
                guild!,
                selectedChannelId,
                timezone
              );

              const tzName = tzInteraction.component.label;
              await tzInteraction.update({
                content:
                  `✅ Beers channel configured!\n\n` +
                  `**Channel:** <#${selectedChannelId}>\n` +
                  `**Timezone:** ${tzName}\n\n` +
                  (renameResult.success
                    ? `Channel renamed to: **${renameResult.newName}**\n\n`
                    : `⚠️ ${renameResult.error}\n\n`) +
                  `The channel will be automatically renamed each day at midnight ${tzName}.`,
                components: [],
              });

              tzCollector.stop();
            }
          });

          tzCollector.on('end', (collected: any) => {
            if (collected.size === 0) {
              interaction
                .editReply({
                  content: 'Timezone selection timed out. Please run /config again to complete setup.',
                  components: [],
                })
                .catch(() => {});
            }
          });

          collector.stop();
        } else if (i.customId === 'remove_beers_channel') {
          await this.container.guildSettingsService.setBeersChannelId(guildId, null);

          await i.update({
            content: '✅ Beers channel feature disabled.\n\nThe channel will no longer be automatically renamed.',
            components: [],
          });

          collector.stop();
        }
      } catch (error) {
        this.container.logger.error('Error setting beers channel:', error);
        await i.reply({ content: 'An error occurred while updating the setting.', flags: MessageFlags.Ephemeral });
      }
    });

    collector.on('end', (collected: any) => {
      if (collected.size === 0) {
        interaction.editReply({ content: 'Selection timed out.', components: [] }).catch(() => {});
      }
    });
  }

  private async handleResetConfig(
    interaction: Command.ChatInputCommandInteraction | any,
    guildId: string,
    guild: Command.ChatInputCommandInteraction['guild']
  ) {
    // Confirm reset
    const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('confirm_reset').setLabel('Yes, Reset All').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('cancel_reset').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      content:
        '⚠️ **Are you sure you want to reset all settings?**\n\n' +
        'This will:\n' +
        '• Remove casino channel restriction (allow everywhere)\n' +
        '• Disable richest member role feature\n' +
        '• Disable beers channel feature\n\n' +
        'This action cannot be undone.',
      components: [confirmRow],
      flags: MessageFlags.Ephemeral,
    });

    const response = await interaction.fetchReply();
    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 30000, // 30 seconds
    });

    collector.on('collect', async (i: any) => {
      if (i.user.id !== interaction.user.id) {
        await i.reply({ content: 'Only the command user can interact with this.', flags: MessageFlags.Ephemeral });
        return;
      }

      try {
        if (i.customId === 'confirm_reset') {
          await this.container.guildSettingsService.setCasinoChannelId(guildId, null);
          await this.container.guildSettingsService.setRichestMemberRoleId(guildId, null);
          await this.container.guildSettingsService.setBeersChannelId(guildId, null);

          await i.update({
            content: '✅ All settings have been reset to default values.',
            components: [],
          });
        } else if (i.customId === 'cancel_reset') {
          await i.update({
            content: 'Reset cancelled.',
            components: [],
          });
        }

        collector.stop();
      } catch (error) {
        this.container.logger.error('Error resetting config:', error);
        await i.reply({ content: 'An error occurred while resetting settings.', flags: MessageFlags.Ephemeral });
      }
    });

    collector.on('end', (collected: any) => {
      if (collected.size === 0) {
        interaction.editReply({ content: 'Reset timed out.', components: [] }).catch(() => {});
      }
    });
  }
}
