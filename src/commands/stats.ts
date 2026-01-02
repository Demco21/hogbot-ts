import { Command } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { AttachmentBuilder, EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { Config } from '../config.js';
import { GameSource } from '../constants.js';
import { formatCoins } from '../lib/utils.js';

@ApplyOptions<Command.Options>({
  name: 'stats',
  description: 'Show your Hog Coin balance trend over the last 100 rounds',
  preconditions: ['CasinoChannelOnly'],
})
export class StatsCommand extends Command {
  private chartRenderer: ChartJSNodeCanvas;

  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, options);
    // Initialize chart renderer (600x300 px, similar to Python's figsize=(6,3))
    this.chartRenderer = new ChartJSNodeCanvas({ width: 600, height: 300 });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand(
      (builder) =>
        builder
          .setName(this.name)
          .setDescription(this.description)
          .addUserOption((option) =>
            option
              .setName('member')
              .setDescription('The member to view stats for (defaults to you)')
              .setRequired(false)
          ),
      // Register to specific guild if GUILD_ID is set (dev mode), otherwise register globally
      Config.discord.guildId ? { guildIds: [Config.discord.guildId] } : {}
    );
  }

  public override async chatInputRun(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    try {
      const targetUser = interaction.options.getUser('member') ?? interaction.user;
      const userId = targetUser.id;
      const guildId = interaction.guildId!;
      const username = targetUser.username;

      // Get balance history
      const balanceHistory = await this.container.walletService.getBalanceHistory(userId, guildId);

      if (!balanceHistory || balanceHistory.length === 0) {
        await interaction.editReply({
          content: `${targetUser} has no balance history yet.`,
        });
        return;
      }

      // Extract balance values for graph
      const balanceValues = balanceHistory.map((h) => h.balance);

      // Generate balance graph
      const graphBuffer = await this.generateBalanceGraph(balanceValues, username);
      const attachment = new AttachmentBuilder(graphBuffer, { name: 'stats.png' });

      // Build embed with stats
      const embed = new EmbedBuilder()
        .setTitle(`📈 ${username}'s Hog Coin Stats`)
        .setColor(0x00ff00)
        .setImage('attachment://stats.png');

      // Add stat summary
      const summaryValue = await this.buildStatSummary(userId, guildId);
      if (summaryValue) {
        embed.addFields({ name: '📊 Stat Summary', value: summaryValue, inline: false });
      }

      // Add per-game stats
      const gameFields = await this.buildGameFields(userId, guildId);
      for (const field of gameFields) {
        embed.addFields(field);
      }

      await interaction.editReply({
        embeds: [embed],
        files: [attachment],
      });
    } catch (error) {
      this.container.logger.error('Error in stats command:', error);
      await interaction.editReply({
        content: 'An error occurred while generating your stats.',
      });
    }
  }

  /**
   * Generate balance progression graph
   */
  private async generateBalanceGraph(history: number[], username: string): Promise<Buffer> {
    const configuration = {
      type: 'line' as const,
      data: {
        labels: history.map((_, i) => i.toString()),
        datasets: [
          {
            label: 'Balance',
            data: history,
            borderColor: 'rgb(75, 192, 192)',
            backgroundColor: 'rgba(75, 192, 192, 0.2)',
            tension: 0.1,
            pointRadius: 3,
            pointHoverRadius: 5,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          title: {
            display: true,
            text: `${username}'s Hog Coin Progression`,
            font: {
              size: 16,
            },
          },
          legend: {
            display: false,
          },
        },
        scales: {
          x: {
            title: {
              display: true,
              text: 'Round',
            },
            grid: {
              color: 'rgba(200, 200, 200, 0.3)',
            },
          },
          y: {
            title: {
              display: true,
              text: 'Balance',
            },
            grid: {
              color: 'rgba(200, 200, 200, 0.3)',
            },
          },
        },
      },
    };

    return await this.chartRenderer.renderToBuffer(configuration);
  }

  /**
   * Build stat summary section
   */
  private async buildStatSummary(userId: string, guildId: string): Promise<string | null> {
    const user = await this.container.walletService.getUser(userId, guildId);
    if (!user) return null;

    const balance = user.balance;

    // Get highest balance from balance_history
    const balanceHistory = await this.container.walletService.getBalanceHistory(userId, guildId);
    const highestBalance = balanceHistory && balanceHistory.length > 0
      ? Math.max(...balanceHistory.map((h) => h.balance))
      : balance;

    // Get highest bet, payout, loss from game_stats
    const allGameStats = await this.container.statsService.getAllGameStats(userId, guildId);

    let highestBet = 0;
    let highestBetGame = 'N/A';
    let highestPayout = 0;
    let highestPayoutGame = 'N/A';
    let highestLoss = 0;
    let highestLossGame = 'N/A';

    for (const stat of allGameStats) {
      if (stat.highest_bet > highestBet) {
        highestBet = stat.highest_bet;
        highestBetGame = this.getGameDisplayName(stat.game_source);
      }
      if (stat.highest_payout > highestPayout) {
        highestPayout = stat.highest_payout;
        highestPayoutGame = this.getGameDisplayName(stat.game_source);
      }
      if (stat.highest_loss > highestLoss) {
        highestLoss = stat.highest_loss;
        highestLossGame = this.getGameDisplayName(stat.game_source);
      }
    }

    // Count beg transactions
    const begCount = await this.container.walletService.getBegCount(userId, guildId);

    return [
      `**Current Balance:** ${formatCoins(balance)}`,
      `**Highest Balance:** ${formatCoins(highestBalance)}`,
      `🎯 **Highest Bet:** ${formatCoins(highestBet)} (${highestBetGame})`,
      `💰 **Highest Payout:** ${formatCoins(highestPayout)} (${highestPayoutGame})`,
      `💀 **Biggest Loss:** ${formatCoins(highestLoss)} (${highestLossGame})`,
      `🙏 **Beg Count:** ${begCount.toLocaleString('en-US')}`,
    ].join('\n');
  }

  /**
   * Build per-game stat fields
   */
  private async buildGameFields(userId: string, guildId: string): Promise<Array<{ name: string; value: string; inline: boolean }>> {
    const gameStats = await this.container.statsService.getAllGameStats(userId, guildId);
    const fields: Array<{ name: string; value: string; inline: boolean }> = [];

    // Order: slots, ridethebus, ceelo, blackjack
    const gameOrder = [GameSource.SLOTS, GameSource.RIDE_THE_BUS, GameSource.CEELO, GameSource.BLACKJACK];

    for (const gameSource of gameOrder) {
      const stat = gameStats.find((s) => s.game_source === gameSource);
      if (!stat) continue;

      const displayName = this.getGameDisplayName(gameSource);
      const valueLines: string[] = [];

      // Basic stats
      valueLines.push(`Played: **${stat.played.toLocaleString('en-US')}**`);
      valueLines.push(this.formatWinLossLine(stat.wins, stat.losses));
      valueLines.push(`Best Win Streak: **${stat.best_win_streak.toLocaleString('en-US')}**`);
      valueLines.push(`Worst Loss Streak: **${stat.worst_losing_streak.toLocaleString('en-US')}**`);

      // Game-specific stats
      if (gameSource === GameSource.SLOTS && stat.extra_stats) {
        const bonusSpins = stat.extra_stats.bonus_spins || 0;
        const jackpotHits = stat.extra_stats.jackpot_hits || 0;
        valueLines.push(`Bonus Spins: **${bonusSpins.toLocaleString('en-US')}**`);
        valueLines.push(`Jackpot Hits: **${jackpotHits.toLocaleString('en-US')}**`);
      }

      if (gameSource === GameSource.RIDE_THE_BUS && stat.extra_stats) {
        // Add Round 1 color stats
        const colorStats = this.getRTBColorStats(stat.extra_stats);
        valueLines.push(colorStats);

        // Add per-round win/loss stats from extra_stats
        for (const round of ['1', '2', '3', '4']) {
          const roundWins = (stat.extra_stats[`round_${round}_wins`] as number) || 0;
          const roundLosses = (stat.extra_stats[`round_${round}_losses`] as number) || 0;
          if (roundWins + roundLosses > 0) {
            valueLines.push(`↳ Round ${round}: ${this.formatWinLossLine(roundWins, roundLosses)}`);
          }
        }
      }

      if (gameSource === GameSource.BLACKJACK && stat.extra_stats) {
        const doubleDownWins = stat.extra_stats.double_down_wins || 0;
        const doubleDownLosses = stat.extra_stats.double_down_losses || 0;
        const blackjackWins = stat.extra_stats.blackjack_wins || 0;

        if (doubleDownWins > 0 || doubleDownLosses > 0) {
          valueLines.push(`Double Downs: ${this.formatWinLossLine(doubleDownWins, doubleDownLosses)}`);
        }
        if (blackjackWins > 0) {
          valueLines.push(`Blackjacks Won: **${blackjackWins.toLocaleString('en-US')}**`);
        }
      }

      let value = valueLines.join('\n').trim();
      if (value.length > 1024) {
        value = value.substring(0, 1020) + '…';
      }

      fields.push({ name: displayName, value, inline: false });
    }

    return fields;
  }

  /**
   * Format win/loss line with percentages
   */
  private formatWinLossLine(wins: number, losses: number): string {
    const total = wins + losses;
    const winPct = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';
    const lossPct = total > 0 ? ((losses / total) * 100).toFixed(1) : '0.0';

    return `W: **${wins.toLocaleString('en-US')}** (${winPct}%) | L: **${losses.toLocaleString('en-US')}** (${lossPct}%)`;
  }

  /**
   * Get RTB Round 1 color stats from extra_stats
   */
  private getRTBColorStats(extraStats: Record<string, any>): string {
    const red = (extraStats.red_count as number) || 0;
    const black = (extraStats.black_count as number) || 0;
    const total = red + black;

    if (total === 0) {
      return 'Round 1 Color: _no data yet_';
    }

    const redPct = ((red / total) * 100).toFixed(1);
    const blackPct = ((black / total) * 100).toFixed(1);

    return `Round 1 Color: Red **${red.toLocaleString('en-US')}** (${redPct}%) • Black **${black.toLocaleString('en-US')}** (${blackPct}%)`;
  }

  /**
   * Get display name for game source
   */
  private getGameDisplayName(gameSource: GameSource): string {
    const names: Record<GameSource, string> = {
      [GameSource.SLOTS]: '🎰 Slots',
      [GameSource.RIDE_THE_BUS]: '🚌 Ride the Bus',
      [GameSource.CEELO]: '🎲 Cee-Lo',
      [GameSource.BLACKJACK]: '🃏 Blackjack',
      [GameSource.LOAN]: 'Loan',
      [GameSource.BEG]: 'Beg',
      [GameSource.ADMIN]: 'Admin',
    };

    return names[gameSource] || gameSource.replace('_', ' ').replace(/\b\w/g, (l) => l.toUpperCase());
  }
}
