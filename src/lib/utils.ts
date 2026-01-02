/**
 * Utility functions for HogBot
 */

/**
 * Formats a number as coins with the coin emoji and thousands separators
 * @param amount The amount to format
 * @returns Formatted string like "🪙 1,000"
 */
export function formatCoins(amount: number): string {
  return `🪙 ${amount.toLocaleString('en-US')}`;
}

/**
 * Formats duration in seconds to human-readable string
 * Examples:
 *   - 90 seconds → "1m 30s"
 *   - 3665 seconds → "1h 1m 5s"
 *   - 90061 seconds → "1d 1h 1m 1s"
 *
 * @param seconds Total duration in seconds
 * @returns Formatted duration string
 */
export function formatDuration(seconds: number): string {
  if (seconds < 0) return '0s';
  if (seconds === 0) return '0s';

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(' ');
}
