import { container } from '@sapphire/framework';

/**
 * Start background cleanup jobs
 * - Prunes old finished/crashed game sessions daily (keeps 7 days)
 *
 * Note: Crash recovery is handled on-demand when users try to start a new game
 */
export function startCleanupJobs(): void {
  // Prune old finished/crashed games once per day
  setInterval(
    async () => {
      try {
        const pruned = await container.gameStateService.pruneOldGames(7);
        if (pruned > 0) {
          container.logger.info(`Cleanup job: Pruned ${pruned} old game sessions (>7 days)`);
        }
      } catch (error) {
        container.logger.error('Cleanup job failed (prune old games):', error);
      }
    },
    24 * 60 * 60 * 1000
  ); // 24 hours

  container.logger.info('🧹 Cleanup job started (prune old sessions: daily)');
}
