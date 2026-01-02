import { Command } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { Config } from '../config.js';
import { CASINO_CONFIG } from '../constants.js';
import { pool } from '../lib/database.js';
import { formatCoins } from '../lib/utils.js';

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
              .setRequired(false)
          )
          .addIntegerOption((option) =>
            option
              .setName('amount')
              .setDescription('Amount of coins to send')
              .setRequired(false)
              .setMinValue(1)
          ),
      // Register to specific guild if GUILD_ID is set (dev mode), otherwise register globally
      Config.discord.guildId ? { guildIds: [Config.discord.guildId] } : {}
    );
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    try {
      // Defer reply immediately to prevent timeout
      await interaction.deferReply();

      const senderId = interaction.user.id;
      const guildId = interaction.guildId!;
      const senderUsername = interaction.user.username;
      const recipient = interaction.options.getUser('user', true);
      const amount = interaction.options.getInteger('amount', true);

      // Validate amount is positive
      if (amount <= 0) {
        await interaction.editReply({ content: '❌ Amount must be greater than 0' });
        return;
      }

      // Prevent sending to self
      if (senderId === recipient.id) {
        await interaction.editReply({ content: '❌ You cannot send coins to yourself' });
        return;
      }

      // Prevent sending to bots
      if (recipient.bot) {
        await interaction.editReply({ content: '❌ You cannot send coins to bots' });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Check rate limit
        const rateLimitCheck = await client.query(
          `SELECT COUNT(*) as loan_count
           FROM loan_rate_limits
           WHERE user_id = $1
           AND guild_id = $2
           AND loan_time > NOW() - INTERVAL '${CASINO_CONFIG.LOAN_RATE_LIMIT_WINDOW_HOURS} hours'`,
          [senderId, guildId]
        );

        const loanCount = parseInt(rateLimitCheck.rows[0].loan_count);
        if (loanCount >= CASINO_CONFIG.LOAN_RATE_LIMIT) {
          await client.query('ROLLBACK');
          await interaction.editReply({
            content: `❌ You can only send ${CASINO_CONFIG.LOAN_RATE_LIMIT} loans per hour. Try again later.`,
          });
          return;
        }

        // Get or create sender
        let sender = await this.container.walletService.getUser(senderId, guildId);
        if (!sender) {
          sender = await this.container.walletService.createUser(senderId, guildId, senderUsername);
        }

        // Check if sender has enough balance
        if (sender.balance < amount) {
          await client.query('ROLLBACK');
          await interaction.editReply({
            content: `❌ Insufficient balance. You have ${formatCoins(sender.balance)} but tried to send ${formatCoins(amount)}.`,
          });
          return;
        }

        // Get or create recipient
        let recipientUser = await this.container.walletService.getUser(recipient.id, guildId);
        if (!recipientUser) {
          recipientUser = await this.container.walletService.createUser(
            recipient.id,
            guildId,
            recipient.username
          );
        }

        // Record loan in rate limit table first
        await client.query(
          'INSERT INTO loan_rate_limits (user_id, guild_id, loan_time) VALUES ($1, $2, NOW())',
          [senderId, guildId]
        );

        await client.query('COMMIT');

        // Transfer coins using WalletService (handles its own transaction)
        const result = await this.container.walletService.transferCoins(
          senderId,
          recipient.id,
          guildId,
          amount
        );

        const senderBalance = result.senderBalance;
        const recipientBalance = result.receiverBalance;

        // Create success embed
        const embed = new EmbedBuilder()
          .setColor(0x00ff00)
          .setTitle('💸 Loan Sent')
          .setDescription(
            `${interaction.user.username} sent **${formatCoins(amount)}** to ${recipient.username}`
          )
          .addFields(
            {
              name: 'Your New Balance',
              value: formatCoins(senderBalance),
              inline: true,
            },
            {
              name: `${recipient.username}'s New Balance`,
              value: formatCoins(recipientBalance),
              inline: true,
            },
            {
              name: 'Loans Remaining',
              value: `${CASINO_CONFIG.LOAN_RATE_LIMIT - loanCount - 1}/${CASINO_CONFIG.LOAN_RATE_LIMIT} this hour`,
            }
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } catch (dbError) {
        await client.query('ROLLBACK');
        throw dbError;
      } finally {
        client.release();
      }
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
