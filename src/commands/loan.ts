import { Command } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { Config } from '../config.js';
import { CASINO_CONFIG, EMBED_COLORS } from '../constants.js';
import { formatCoins } from '../utils/utils.js';

/**
 * Loan command - Transfer coins to another user
 * Limited to 3 loans per hour to prevent abuse
 */
@ApplyOptions<Command.Options>({
  name: 'loan',
  description: 'Transfer coins to another user (3 per hour limit)',
})
export class LoanCommand extends Command {
  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand(
      (builder) =>
        builder
          .setName(this.name)
          .setDescription(this.description)
          .addUserOption((option) =>
            option
              .setName('user')
              .setDescription('The user to send coins to')
              .setRequired(true)
          )
          .addIntegerOption((option) =>
            option
              .setName('amount')
              .setDescription('Amount of coins to send')
              .setRequired(true)
              .setMinValue(1)
          ),
      process.env.NODE_ENV === 'production'
        ? {}
        : Config.discord.guildId
          ? { guildIds: [Config.discord.guildId] }
          : {}
    );
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const senderId = interaction.user.id;
      const guildId = interaction.guildId!;
      const senderUsername = interaction.user.username;
      const recipient = interaction.options.getUser('user', true);
      const amount = interaction.options.getInteger('amount', true);

      await this.container.walletService.ensureGuild(guildId, interaction.guild?.name);

      if (amount <= 0) {
        await interaction.editReply({ content: '❌ Amount must be greater than 0' });
        return;
      }

      if (senderId === recipient.id) {
        await interaction.editReply({ content: '❌ You cannot send coins to yourself' });
        return;
      }

      if (recipient.bot) {
        await interaction.editReply({ content: '❌ You cannot send coins to bots' });
        return;
      }

      // Check rate limit
      const withinLimit = this.container.walletService.checkLoanRateLimit(
        senderId,
        guildId,
        CASINO_CONFIG.LOAN_RATE_LIMIT,
        CASINO_CONFIG.LOAN_RATE_LIMIT_WINDOW_HOURS
      );

      if (!withinLimit) {
        await interaction.editReply({
          content: `❌ You can only send ${CASINO_CONFIG.LOAN_RATE_LIMIT} loans per hour. Try again later.`,
        });
        return;
      }

      // Ensure both users exist
      const sender = await this.container.walletService.ensureUser(senderId, guildId, senderUsername);
      await this.container.walletService.ensureUser(recipient.id, guildId, recipient.username);

      if (sender.balance < amount) {
        await interaction.editReply({
          content: `❌ Insufficient balance. You have ${formatCoins(sender.balance)} but tried to send ${formatCoins(amount)}.`,
        });
        return;
      }

      // Record rate limit entry
      this.container.walletService.recordLoanRateLimit(senderId, guildId);
      const loansUsed = this.container.walletService.getLoanCount(
        senderId, guildId, CASINO_CONFIG.LOAN_RATE_LIMIT_WINDOW_HOURS
      );
      const loansRemaining = CASINO_CONFIG.LOAN_RATE_LIMIT - loansUsed;

      // Transfer coins
      const result = await this.container.walletService.transferCoins(
        senderId,
        recipient.id,
        guildId,
        amount
      );

      const { senderBalance, receiverBalance } = result;

      // Notify recipient via DM
      try {
        const dmEmbed = new EmbedBuilder()
          .setColor(EMBED_COLORS.SUCCESS)
          .setTitle('💰 You Received a Loan!')
          .setDescription(`${interaction.user.username} sent you **${formatCoins(amount)}**`)
          .addFields({ name: 'Your New Balance', value: formatCoins(receiverBalance) })
          .setTimestamp();

        await recipient.send({ embeds: [dmEmbed] });
      } catch {
        this.container.logger.info(
          `Could not send DM to ${recipient.username} (${recipient.id}) for loan notification`
        );
      }

      const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS.SUCCESS)
        .setTitle('💸 Loan Sent')
        .setDescription(
          `${interaction.user.username} sent **${formatCoins(amount)}** to ${recipient.username}`
        )
        .addFields(
          { name: 'Your New Balance', value: formatCoins(senderBalance), inline: true },
          { name: `${recipient.username}'s New Balance`, value: formatCoins(receiverBalance), inline: true },
          {
            name: 'Loans Remaining',
            value: `${loansRemaining}/${CASINO_CONFIG.LOAN_RATE_LIMIT} this hour`,
          }
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      this.container.logger.error('Error in loan command:', error);

      const errorMessage = 'An error occurred while sending the loan. Please try again later.';

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
