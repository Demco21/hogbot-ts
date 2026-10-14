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
  PermissionFlagsBits,
  type ButtonInteraction,
} from 'discord.js';
import { EMBED_COLORS } from '../constants.js';
import { DEFAULT_TIMEZONE } from '../services/GuildSettingsService.js';

/**
 * Timezones offered by the shared timezone picker, keyed by button custom ID.
 * Shared by the beers channel rename and the voice streak day boundary.
 */
const TIMEZONE_OPTIONS = [
  { customId: 'tz_eastern', label: 'Eastern (ET)', timezone: 'America/New_York' },
  { customId: 'tz_central', label: 'Central (CT)', timezone: 'America/Chicago' },
  { customId: 'tz_mountain', label: 'Mountain (MT)', timezone: 'America/Denver' },
  { customId: 'tz_pacific', label: 'Pacific (PT)', timezone: 'America/Los_Angeles' },
  { customId: 'tz_utc', label: 'UTC', timezone: 'UTC' },
] as const;

function getTimezoneLabel(timezone: string): string {
  return TIMEZONE_OPTIONS.find((option) => option.timezone === timezone)?.label ?? timezone;
}

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
          .setCustomId('config_ai_access_role')
          .setLabel('Set HogAI Access Role')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🤖')
      );

      const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('config_timezone')
          .setLabel('Set Timezone')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🕛'),
        new ButtonBuilder()
          .setCustomId('config_voice_streaks')
          .setLabel('Voice Streaks')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🔥'),
        new ButtonBuilder()
          .setCustomId('config_reset')
          .setLabel('Reset All')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🔄')
      );

      const response = await interaction.reply({
        embeds: [embed],
        components: [row, row2],
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
          } else if (buttonInteraction.customId === 'config_ai_access_role') {
            await this.handleAiAccessRoleConfig(buttonInteraction, guildId, guild);
          } else if (buttonInteraction.customId === 'config_timezone') {
            await this.handleTimezoneConfig(buttonInteraction, guildId);
          } else if (buttonInteraction.customId === 'config_voice_streaks') {
            await this.handleVoiceStreaksConfig(buttonInteraction, guildId);
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
      timezone: string;
      guildName: string | null;
      aiAccessRoleId: string | null;
      streaksEnabled: boolean;
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

    const aiAccessRoleName = settings.aiAccessRoleId
      ? guild?.roles.cache.get(settings.aiAccessRoleId)?.name || '*Role not found*'
      : '*Not set (unrestricted - anyone can use it)*';

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
          value: beersChannelName,
          inline: false,
        },
        {
          name: '🤖 HogAI Access Role',
          value: aiAccessRoleName,
          inline: false,
        },
        {
          name: '🕛 Server Timezone',
          value: `${getTimezoneLabel(settings.timezone)}\n*Midnight for the beers channel and voice streaks*`,
          inline: false,
        },
        {
          name: '🔥 Voice Streaks',
          value: settings.streaksEnabled
            ? 'Enabled - daily voice channel streaks shown as roles'
            : '*Disabled*',
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

  private async handleAiAccessRoleConfig(
    interaction: Command.ChatInputCommandInteraction | any,
    guildId: string,
    _guild: Command.ChatInputCommandInteraction['guild']
  ) {
    // Create role select menu
    const selectMenu = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId('select_ai_access_role')
        .setPlaceholder('Select the role allowed to use HogAI')
    );

    const removeButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('remove_ai_access_role')
        .setLabel('Remove Restriction')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('❌')
    );

    await interaction.reply({
      content:
        '**Select HogAI Access Role**\n\n' +
        'Choose the role allowed to @mention HogAI (server Administrators can always use it), ' +
        'or click "Remove Restriction" to let anyone use it.',
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
        if (i.customId === 'select_ai_access_role' && i.isRoleSelectMenu()) {
          const selectedRoleId = i.values[0];
          const role = _guild?.roles.cache.get(selectedRoleId);

          if (!role) {
            await i.reply({ content: 'Role not found.', flags: MessageFlags.Ephemeral });
            return;
          }

          await this.container.guildSettingsService.setAiAccessRoleId(guildId, selectedRoleId);

          await i.update({
            content: `✅ HogAI access role set to **${role.name}**\n\nOnly members with that role (and admins) can @mention HogAI now.`,
            components: [],
          });
        } else if (i.customId === 'remove_ai_access_role') {
          await this.container.guildSettingsService.setAiAccessRoleId(guildId, null);

          await i.update({
            content: '✅ HogAI access restriction removed - anyone can @mention HogAI now.',
            components: [],
          });
        }

        collector.stop();
      } catch (error) {
        this.container.logger.error('Error setting HogAI access role:', error);
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
          const timezone = await this.container.guildSettingsService.getTimezone(guildId);
          await this.container.guildSettingsService.setBeersChannelId(guildId, selectedChannelId);

          // Immediately rename the channel to today's name for instant feedback
          const renameResult = await this.container.guildSettingsService.renameBeersChannel(
            guild!,
            selectedChannelId,
            timezone
          );

          const tzName = getTimezoneLabel(timezone);
          await i.update({
            content:
              `✅ Beers channel configured!\n\n` +
              `**Channel:** <#${selectedChannelId}>\n` +
              `**Timezone:** ${tzName} *(server timezone - change it with "Set Timezone")*\n\n` +
              (renameResult.success
                ? `Channel renamed to: **${renameResult.newName}**\n\n`
                : `⚠️ ${renameResult.error}\n\n`) +
              `The channel will be automatically renamed each day at midnight ${tzName}.`,
            components: [],
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

  private async handleTimezoneConfig(interaction: ButtonInteraction, guildId: string) {
    const currentTimezone = await this.container.guildSettingsService.getTimezone(guildId);

    const timezoneRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      TIMEZONE_OPTIONS.map((option) =>
        new ButtonBuilder()
          .setCustomId(option.customId)
          .setLabel(option.label)
          .setStyle(option.timezone === currentTimezone ? ButtonStyle.Success : ButtonStyle.Primary)
      )
    );

    await interaction.reply({
      content:
        '**Select Server Timezone**\n\n' +
        `Current: **${getTimezoneLabel(currentTimezone)}**\n\n` +
        'This sets when "midnight" is for the beers channel rename and the voice streak day.',
      components: [timezoneRow],
      flags: MessageFlags.Ephemeral,
    });

    // Collect on the reply message itself. A collector from reply()'s InteractionResponse is
    // bound to the message the clicked button lives on (the main /config panel), so clicks on
    // this new message would never reach it.
    const response = await interaction.fetchReply();
    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 60000, // 1 minute
    });

    collector.on('collect', async (i) => {
      if (i.user.id !== interaction.user.id) {
        await i.reply({ content: 'Only the command user can interact with this.', flags: MessageFlags.Ephemeral });
        return;
      }

      try {
        const option = TIMEZONE_OPTIONS.find((candidate) => candidate.customId === i.customId);
        if (!option) return;

        await this.container.guildSettingsService.setTimezone(guildId, option.timezone);

        // Bring the beers channel name in line with the new timezone right away
        const settings = await this.container.guildSettingsService.getAllSettings(guildId);
        if (settings.beersChannelId && interaction.guild) {
          await this.container.guildSettingsService.renameBeersChannel(
            interaction.guild,
            settings.beersChannelId,
            option.timezone
          );
        }

        await i.update({
          content:
            `✅ Server timezone set to **${option.label}**\n\n` +
            (settings.streaksEnabled && option.timezone !== currentTimezone
              ? '⚠️ Voice streaks now roll over at midnight in this timezone. The day of the change, ' +
                'some members may see their streak count one day early or late.'
              : 'Daily features now roll over at midnight in this timezone.'),
          components: [],
        });

        collector.stop();
      } catch (error) {
        this.container.logger.error('Error setting server timezone:', error);
        await i.reply({ content: 'An error occurred while updating the setting.', flags: MessageFlags.Ephemeral });
      }
    });

    collector.on('end', (collected) => {
      if (collected.size === 0) {
        interaction.editReply({ content: 'Selection timed out.', components: [] }).catch(() => {});
      }
    });
  }

  private async handleVoiceStreaksConfig(interaction: ButtonInteraction, guildId: string) {
    const { streaksEnabled } = await this.container.guildSettingsService.getAllSettings(guildId);

    const toggleRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      streaksEnabled
        ? new ButtonBuilder()
            .setCustomId('disable_voice_streaks')
            .setLabel('Disable Voice Streaks')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌')
        : new ButtonBuilder()
            .setCustomId('enable_voice_streaks')
            .setLabel('Enable Voice Streaks')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🔥')
    );

    await interaction.reply({
      content:
        '**Voice Streaks**\n\n' +
        'Members build a daily streak by joining any voice channel at least once a day ' +
        '(the AFK channel doesn\'t count). Missing a full day resets it to 0.\n\n' +
        'Each member\'s streak is shown as a role like **🔥 3 Day Streak**. HogBot creates and deletes these ' +
        'roles automatically, keeping only one role per streak length currently held.\n\n' +
        `Status: **${streaksEnabled ? 'Enabled' : 'Disabled'}**`,
      components: [toggleRow],
      flags: MessageFlags.Ephemeral,
    });

    // See handleTimezoneConfig: collect on the reply message, not the InteractionResponse
    const response = await interaction.fetchReply();
    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 60000, // 1 minute
    });

    collector.on('collect', async (i) => {
      if (i.user.id !== interaction.user.id) {
        await i.reply({ content: 'Only the command user can interact with this.', flags: MessageFlags.Ephemeral });
        return;
      }

      const guild = interaction.guild;
      if (!guild) return;

      try {
        if (i.customId === 'enable_voice_streaks') {
          if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
            await i.update({
              content:
                '❌ I need the **Manage Roles** permission to create and assign streak roles.\n' +
                'Please grant me this permission and try again.',
              components: [],
            });
            collector.stop();
            return;
          }

          // Enabling reconciles roles with Discord, which can take a moment on larger servers
          await i.deferUpdate();
          await this.container.streakService.enable(guild);

          await i.editReply({
            content:
              '✅ Voice streaks enabled!\n\n' +
              'Members currently in voice have been credited for today. Everyone else starts their streak ' +
              'the next time they join a voice channel.',
            components: [],
          });
        } else if (i.customId === 'disable_voice_streaks') {
          await i.deferUpdate();
          await this.container.streakService.disable(guild);

          await i.editReply({
            content:
              '✅ Voice streaks disabled.\n\n' +
              'All streak roles have been removed. Streak counts are kept, so streaks still alive today ' +
              'will come back if you re-enable the feature.',
            components: [],
          });
        }

        collector.stop();
      } catch (error) {
        this.container.logger.error('Error toggling voice streaks:', error);
        await i.followUp({ content: 'An error occurred while updating the setting.', flags: MessageFlags.Ephemeral });
      }
    });

    collector.on('end', (collected) => {
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
        '• Disable beers channel feature\n' +
        '• Remove HogAI access restriction (allow everyone)\n' +
        '• Disable voice streaks (streak roles are deleted; streak counts are kept)\n' +
        `• Reset the server timezone to ${getTimezoneLabel(DEFAULT_TIMEZONE)}\n\n` +
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
          await this.container.guildSettingsService.setAiAccessRoleId(guildId, null);
          await this.container.guildSettingsService.setTimezone(guildId, DEFAULT_TIMEZONE);
          await this.container.streakService.disable(guild!);

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
