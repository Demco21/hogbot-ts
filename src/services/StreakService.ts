import { DiscordAPIError, Guild, GuildMember, PermissionFlagsBits, RESTJSONErrorCodes, Role } from 'discord.js';
import { db } from '../lib/database.js';
import { safeLogger as logger } from '../lib/safe-logger.js';
import type { VoiceStreakInfo } from '../lib/types.js';
import { STREAK_CONFIG, formatStreakRoleName } from '../constants.js';
import { getDateInTimezone, shiftDate } from '../utils/date-utils.js';
import { GuildSettingsService } from './GuildSettingsService.js';

interface VoiceStreakRow {
  user_id: string;
  current_streak: number;
  longest_streak: number;
  last_active_date: string | null;
}

interface StreakRoleRow {
  streak_days: number;
  role_id: string;
}

export type StreakLeaderboardType = 'current' | 'longest';

const ROLE_UPDATE_REASON = 'HogBot voice streak update';

/**
 * The streak day it currently is in the given timezone. Days start at
 * STREAK_CONFIG.DAY_START_HOUR rather than midnight.
 */
function getStreakDate(timezone: string): string {
  return getDateInTimezone(timezone, new Date(), STREAK_CONFIG.DAY_START_HOUR);
}

/**
 * StreakService tracks daily voice streaks and mirrors them onto Discord roles.
 *
 * Design:
 * - The database (voice_streaks) is the single source of truth. Roles are a projection
 *   of it and are never read back to decide anyone's streak.
 * - A "day" runs from STREAK_CONFIG.DAY_START_HOUR to the same hour the next morning in
 *   the guild's timezone, identified by the date it starts on. Joining a voice channel credits
 *   the day; the first credit of a day extends the streak if yesterday was credited,
 *   otherwise restarts it at 1. A daily rollover resets streaks whose last credited day
 *   is older than yesterday.
 * - Role work is idempotent: syncMemberRoles() makes a member's roles match their DB
 *   streak *at the time it runs*, so tasks can't apply stale transitions. All role work
 *   for a guild runs through a serial queue so concurrent updates can't create duplicate
 *   roles or race a rename against an assignment.
 * - Only roles recorded in streak_roles (created by HogBot) are ever modified or deleted.
 * - A streak role exists only while at least one member's DB streak equals its length,
 *   so the role count is the number of distinct streak lengths currently held.
 */
export class StreakService {
  private guildSettingsService: GuildSettingsService;

  /** Per-guild promise chain that serializes all Discord role operations */
  private roleQueues: Map<string, Promise<void>> = new Map();

  /** Guilds already warned about a missing Manage Roles permission (avoids DM spam) */
  private missingPermissionNotified: Set<string> = new Set();

  constructor(guildSettingsService: GuildSettingsService) {
    this.guildSettingsService = guildSettingsService;
  }

  // ───────────────────────────── Public API ─────────────────────────────

  /**
   * Record that a member joined a (non-AFK) voice channel. Credits today at most once.
   */
  async recordActivity(member: GuildMember): Promise<void> {
    if (member.user.bot) return;

    const settings = await this.guildSettingsService.getStreakSettings(member.guild.id);
    if (!settings) return;

    const today = getStreakDate(settings.timezone);
    const newStreak = this.creditActivity(member.guild.id, member.id, today);
    if (newStreak === null) return;

    logger.info(`Voice streak for ${member.user.username} in guild ${member.guild.id} is now ${newStreak}`);
    await this.enqueueRoleWork(member.guild, () => this.syncMemberRoles(member.guild, member.id));
  }

  /**
   * Run the daily rollover for a guild if it hasn't run yet today (in the guild's
   * timezone). Driven by stored dates rather than timers, so it's idempotent and catches
   * up after downtime: whatever resets are due get applied on the next call.
   */
  async runRolloverIfDue(guild: Guild): Promise<void> {
    const settings = await this.guildSettingsService.getStreakSettings(guild.id);
    if (!settings) return;

    const today = getStreakDate(settings.timezone);
    if (settings.lastRolloverDate === today) return;

    // Members sitting in voice across the day start never "join", so credit them for the new day
    const creditedUserIds = this.creditMembersInVoice(guild, today);
    const resetUserIds = this.resetBrokenStreaks(guild.id, shiftDate(today, -1));
    await this.guildSettingsService.setStreakLastRolloverDate(guild.id, today);

    logger.info(
      `Voice streak rollover for guild ${guild.id} (${today}): ` +
        `${resetUserIds.length} reset, ${creditedUserIds.length} credited while in voice`
    );

    if (resetUserIds.length === 0 && creditedUserIds.length === 0) return;

    // Resets first, so a role vacated by a reset member can't be renamed while they still wear it
    await this.enqueueRoleWork(guild, () => this.syncMembersAndCleanup(guild, [...resetUserIds, ...creditedUserIds]));
  }

  /**
   * Bring a guild fully up to date: apply any missed rollover, credit members already in
   * voice, and reconcile every streak role with the database. Used on startup and when
   * the feature is enabled.
   */
  async initializeGuild(guild: Guild): Promise<void> {
    const settings = await this.guildSettingsService.getStreakSettings(guild.id);
    if (!settings) return;

    await this.runRolloverIfDue(guild);
    // Covers a restart mid-day: anyone still in voice was most likely there all along
    this.creditMembersInVoice(guild, getStreakDate(settings.timezone));

    await this.enqueueRoleWork(guild, () => this.reconcile(guild));
  }

  async enable(guild: Guild): Promise<void> {
    await this.guildSettingsService.setStreaksEnabled(guild.id, true);
    await this.initializeGuild(guild);
  }

  /**
   * Disable streaks and delete every HogBot streak role. Streak data is kept, so
   * re-enabling restores roles for streaks that are still alive.
   */
  async disable(guild: Guild): Promise<void> {
    await this.guildSettingsService.setStreaksEnabled(guild.id, false);
    await this.enqueueRoleWork(guild, () => this.deleteAllStreakRoles(guild));
  }

  /**
   * A member left the server: their streak is deleted, and their role with it if they
   * were its last holder.
   */
  async handleMemberLeave(guild: Guild, userId: string): Promise<void> {
    const { changes } = db.prepare('DELETE FROM voice_streaks WHERE user_id = ? AND guild_id = ?').run(userId, guild.id);
    if (changes === 0) return;

    logger.info(`Deleted voice streak for departed member ${userId} in guild ${guild.id}`);
    await this.enqueueRoleWork(guild, () => this.deleteUnusedRoles(guild));
  }

  /**
   * A role was deleted. If it was a HogBot streak role deleted by someone else, forget it
   * and give its holders a fresh one. Runs inside the queue so HogBot's own deletions
   * (which remove the streak_roles row before the queue moves on) are ignored.
   */
  async handleRoleDelete(role: Role): Promise<void> {
    await this.enqueueRoleWork(role.guild, async () => {
      const row = db.prepare('SELECT streak_days FROM streak_roles WHERE role_id = ?').get(role.id) as
        | { streak_days: number }
        | undefined;
      if (!row) return;

      db.prepare('DELETE FROM streak_roles WHERE role_id = ?').run(role.id);
      logger.warn(`Streak role "${role.name}" was deleted externally in guild ${role.guild.id}; recreating for holders`);

      if (!(await this.guildSettingsService.getStreakSettings(role.guild.id))) return;

      const holders = db
        .prepare('SELECT user_id FROM voice_streaks WHERE guild_id = ? AND current_streak = ?')
        .all(role.guild.id, row.streak_days) as { user_id: string }[];
      await this.syncMembersAndCleanup(
        role.guild,
        holders.map((holder) => holder.user_id)
      );
    });
  }

  /**
   * A member's streak as it stands right now, or null if they've never been credited.
   */
  async getStreak(guildId: string, userId: string): Promise<VoiceStreakInfo | null> {
    const row = db
      .prepare(
        `SELECT user_id, current_streak, longest_streak, last_active_date
         FROM voice_streaks WHERE user_id = ? AND guild_id = ?`
      )
      .get(userId, guildId) as VoiceStreakRow | undefined;
    if (!row) return null;

    const today = getStreakDate(await this.guildSettingsService.getTimezone(guildId));
    return this.toStreakInfo(row, today);
  }

  async getTopStreaks(guildId: string, type: StreakLeaderboardType, limit: number): Promise<VoiceStreakInfo[]> {
    const today = getStreakDate(await this.guildSettingsService.getTimezone(guildId));

    // 'current' excludes streaks already broken but not yet reset by the rollover
    const rows =
      type === 'current'
        ? (db
            .prepare(
              `SELECT user_id, current_streak, longest_streak, last_active_date
               FROM voice_streaks
               WHERE guild_id = ? AND current_streak > 0 AND last_active_date >= ?
               ORDER BY current_streak DESC, last_active_date DESC
               LIMIT ?`
            )
            .all(guildId, shiftDate(today, -1), limit) as VoiceStreakRow[])
        : (db
            .prepare(
              `SELECT user_id, current_streak, longest_streak, last_active_date
               FROM voice_streaks
               WHERE guild_id = ? AND longest_streak > 0
               ORDER BY longest_streak DESC, current_streak DESC
               LIMIT ?`
            )
            .all(guildId, limit) as VoiceStreakRow[]);

    return rows.map((row) => this.toStreakInfo(row, today));
  }

  // ─────────────────────────── Streak bookkeeping (DB) ───────────────────────────

  /**
   * Credit `today` for a member. Returns the new streak, or null if today (or a later
   * date, possible right after the guild's timezone moves west) was already credited.
   */
  private creditActivity(guildId: string, userId: string, today: string): number | null {
    const credit = db.transaction((): number | null => {
      const row = db
        .prepare('SELECT current_streak, last_active_date FROM voice_streaks WHERE user_id = ? AND guild_id = ?')
        .get(userId, guildId) as Pick<VoiceStreakRow, 'current_streak' | 'last_active_date'> | undefined;

      if (row?.last_active_date && row.last_active_date >= today) return null;

      const continuesStreak =
        row !== undefined && row.current_streak > 0 && row.last_active_date === shiftDate(today, -1);
      const newStreak = continuesStreak ? row.current_streak + 1 : 1;

      db.prepare(
        `INSERT INTO voice_streaks (user_id, guild_id, current_streak, longest_streak, last_active_date)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, guild_id) DO UPDATE
         SET current_streak = excluded.current_streak,
             longest_streak = MAX(voice_streaks.longest_streak, excluded.current_streak),
             last_active_date = excluded.last_active_date,
             updated_at = datetime('now')`
      ).run(userId, guildId, newStreak, newStreak, today);

      return newStreak;
    });

    return credit();
  }

  /**
   * Credit today for every non-bot member currently in a non-AFK voice channel.
   * Returns the IDs whose streak changed.
   */
  private creditMembersInVoice(guild: Guild, today: string): string[] {
    const creditedUserIds: string[] = [];

    for (const voiceState of guild.voiceStates.cache.values()) {
      if (!voiceState.channelId || voiceState.channelId === guild.afkChannelId) continue;
      if (!voiceState.member || voiceState.member.user.bot) continue;

      if (this.creditActivity(guild.id, voiceState.id, today) !== null) {
        creditedUserIds.push(voiceState.id);
      }
    }

    return creditedUserIds;
  }

  /**
   * Reset every streak whose last credited day is before yesterday. Returns the reset IDs.
   */
  private resetBrokenStreaks(guildId: string, yesterday: string): string[] {
    const reset = db.transaction((): string[] => {
      const rows = db
        .prepare(
          `SELECT user_id FROM voice_streaks
           WHERE guild_id = ? AND current_streak > 0 AND last_active_date < ?`
        )
        .all(guildId, yesterday) as { user_id: string }[];

      db.prepare(
        `UPDATE voice_streaks
         SET current_streak = 0, updated_at = datetime('now')
         WHERE guild_id = ? AND current_streak > 0 AND last_active_date < ?`
      ).run(guildId, yesterday);

      return rows.map((row) => row.user_id);
    });

    return reset();
  }

  private getStoredStreak(guildId: string, userId: string): number {
    const row = db
      .prepare('SELECT current_streak FROM voice_streaks WHERE user_id = ? AND guild_id = ?')
      .get(userId, guildId) as { current_streak: number } | undefined;
    return row?.current_streak ?? 0;
  }

  private countStreakHolders(guildId: string, streakDays: number): number {
    const row = db
      .prepare('SELECT COUNT(*) AS count FROM voice_streaks WHERE guild_id = ? AND current_streak = ?')
      .get(guildId, streakDays) as { count: number };
    return row.count;
  }

  private getManagedRoles(guildId: string): StreakRoleRow[] {
    return db.prepare('SELECT streak_days, role_id FROM streak_roles WHERE guild_id = ?').all(guildId) as StreakRoleRow[];
  }

  private toStreakInfo(row: VoiceStreakRow, today: string): VoiceStreakInfo {
    const lastActive = row.last_active_date;
    // A streak whose last day is before yesterday is already broken, even if the
    // rollover for today hasn't run yet
    const isAlive = lastActive !== null && lastActive >= shiftDate(today, -1);

    return {
      userId: row.user_id,
      currentStreak: isAlive ? row.current_streak : 0,
      longestStreak: row.longest_streak,
      lastActiveDate: lastActive,
      activeToday: lastActive !== null && lastActive >= today,
    };
  }

  // ─────────────────────────── Role projection (Discord) ───────────────────────────

  /**
   * Serialize role work per guild. Each task's errors are logged and swallowed so one
   * failure can't break the chain for later tasks.
   */
  private enqueueRoleWork(guild: Guild, task: () => Promise<void>): Promise<void> {
    const previous = this.roleQueues.get(guild.id) ?? Promise.resolve();
    const next = previous.then(task).catch((error) => {
      logger.error(`Voice streak role update failed in guild ${guild.id}:`, error);
    });

    this.roleQueues.set(guild.id, next);
    void next.then(() => {
      if (this.roleQueues.get(guild.id) === next) this.roleQueues.delete(guild.id);
    });

    return next;
  }

  /**
   * Full role reconciliation against the DB. Repairs any drift: streaks of members who
   * left while the bot was offline, streak roles deleted by hand, roles added or removed
   * by hand, and roles no longer held by anyone.
   */
  private async reconcile(guild: Guild): Promise<void> {
    if (!(await this.canManageRoles(guild))) return;

    const members = await guild.members.fetch();

    const streakRows = db
      .prepare('SELECT user_id, current_streak FROM voice_streaks WHERE guild_id = ?')
      .all(guild.id) as Pick<VoiceStreakRow, 'user_id' | 'current_streak'>[];

    const deleteStreak = db.prepare('DELETE FROM voice_streaks WHERE user_id = ? AND guild_id = ?');
    const departedUserIds = streakRows.filter((row) => !members.has(row.user_id)).map((row) => row.user_id);
    db.transaction(() => {
      for (const userId of departedUserIds) deleteStreak.run(userId, guild.id);
    })();

    const deleteManagedRole = db.prepare('DELETE FROM streak_roles WHERE role_id = ?');
    const managedRoleIds = new Set<string>();
    for (const { role_id } of this.getManagedRoles(guild.id)) {
      if (guild.roles.cache.has(role_id)) {
        managedRoleIds.add(role_id);
      } else {
        deleteManagedRole.run(role_id);
      }
    }

    const userIdsToSync = new Set(
      streakRows.filter((row) => row.current_streak > 0 && members.has(row.user_id)).map((row) => row.user_id)
    );
    for (const member of members.values()) {
      if (member.roles.cache.some((role) => managedRoleIds.has(role.id))) userIdsToSync.add(member.id);
    }

    await this.syncMembersAndCleanup(guild, [...userIdsToSync]);

    logger.info(
      `Reconciled voice streak roles in guild ${guild.id}: ${userIdsToSync.size} members synced, ` +
        `${departedUserIds.length} departed streaks removed`
    );
  }

  /**
   * Sync several members, then delete roles that ended up unused. One member failing
   * (e.g. a role moved above HogBot) doesn't stop the rest.
   */
  private async syncMembersAndCleanup(guild: Guild, userIds: string[]): Promise<void> {
    for (const userId of userIds) {
      try {
        await this.syncMemberRoles(guild, userId, false);
      } catch (error) {
        logger.error(`Failed to sync voice streak role for ${userId} in guild ${guild.id}:`, error);
      }
    }
    await this.deleteUnusedRoles(guild);
  }

  /**
   * Make a member wear exactly the streak role matching their current DB streak (or none
   * for a streak of 0), then optionally delete roles nobody holds anymore.
   */
  private async syncMemberRoles(guild: Guild, userId: string, cleanup = true): Promise<void> {
    if (!(await this.canManageRoles(guild))) return;

    const member = await this.fetchMember(guild, userId);
    if (!member) {
      // Not in the server anymore (left while we weren't watching) - leaving wipes the streak
      db.prepare('DELETE FROM voice_streaks WHERE user_id = ? AND guild_id = ?').run(userId, guild.id);
    } else {
      const streak = this.getStoredStreak(guild.id, userId);
      const managedRoles = this.getManagedRoles(guild.id);
      const managedDaysByRoleId = new Map(managedRoles.map((row) => [row.role_id, row.streak_days]));
      const heldRoleIds = [...member.roles.cache.keys()].filter((roleId) => managedDaysByRoleId.has(roleId));

      let targetRoleId: string | null = null;
      if (streak > 0) {
        targetRoleId = await this.resolveRoleForStreak(guild, member, streak, heldRoleIds, managedRoles);
        if (targetRoleId && !member.roles.cache.has(targetRoleId)) {
          await member.roles.add(targetRoleId, ROLE_UPDATE_REASON);
        }
      }

      const staleRoleIds = heldRoleIds.filter((roleId) => roleId !== targetRoleId);
      if (staleRoleIds.length > 0) {
        await member.roles.remove(staleRoleIds, ROLE_UPDATE_REASON);
      }
    }

    if (cleanup) await this.deleteUnusedRoles(guild);
  }

  /**
   * Find (or make) the role for a streak length. Prefers, in order:
   * 1. The existing role for that length.
   * 2. Renaming a streak role that only this member holds (one API call instead of
   *    create + assign + unassign + delete, and the role keeps its ID).
   * 3. Creating a new role.
   * Returns null only if the guild is at the role safety cap.
   */
  private async resolveRoleForStreak(
    guild: Guild,
    member: GuildMember,
    streak: number,
    heldRoleIds: string[],
    managedRoles: StreakRoleRow[]
  ): Promise<string | null> {
    const existing = managedRoles.find((row) => row.streak_days === streak);
    if (existing) {
      if (guild.roles.cache.has(existing.role_id)) return existing.role_id;
      db.prepare('DELETE FROM streak_roles WHERE role_id = ?').run(existing.role_id);
    }

    for (const roleId of heldRoleIds) {
      const role = guild.roles.cache.get(roleId);
      const heldDays = managedRoles.find((row) => row.role_id === roleId)?.streak_days;
      if (!role || heldDays === undefined || heldDays === streak) continue;

      // The DB says nobody else has this streak length, and the member cache agrees
      // nobody else wears the role - safe to repurpose it
      const soleHolder =
        this.countStreakHolders(guild.id, heldDays) === 0 && role.members.every((holder) => holder.id === member.id);
      if (!soleHolder) continue;

      await role.setName(formatStreakRoleName(streak), ROLE_UPDATE_REASON);
      db.prepare('UPDATE streak_roles SET streak_days = ? WHERE role_id = ?').run(streak, roleId);
      return roleId;
    }

    if (guild.roles.cache.size >= STREAK_CONFIG.MAX_GUILD_ROLES) {
      logger.warn(`Guild ${guild.id} is near Discord's role limit; skipping streak role for ${streak} days`);
      return null;
    }

    // Default position (bottom of the list) is always below HogBot's role, so HogBot can
    // always manage it; not hoisted so streaks don't split the member list.
    const role = await guild.roles.create({
      name: formatStreakRoleName(streak),
      colors: { primaryColor: STREAK_CONFIG.ROLE_COLOR },
      hoist: false,
      mentionable: false,
      permissions: [],
      reason: ROLE_UPDATE_REASON,
    });
    db.prepare('INSERT INTO streak_roles (guild_id, streak_days, role_id) VALUES (?, ?, ?)').run(
      guild.id,
      streak,
      role.id
    );
    logger.info(`Created streak role "${role.name}" in guild ${guild.id}`);
    return role.id;
  }

  /**
   * Delete every streak role whose length no member currently has.
   */
  private async deleteUnusedRoles(guild: Guild): Promise<void> {
    const unusedRoles = db
      .prepare(
        `SELECT sr.streak_days, sr.role_id
         FROM streak_roles sr
         WHERE sr.guild_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM voice_streaks vs
             WHERE vs.guild_id = sr.guild_id AND vs.current_streak = sr.streak_days
           )`
      )
      .all(guild.id) as StreakRoleRow[];

    for (const { role_id } of unusedRoles) {
      await this.deleteStreakRole(guild, role_id);
    }
  }

  private async deleteAllStreakRoles(guild: Guild): Promise<void> {
    for (const { role_id } of this.getManagedRoles(guild.id)) {
      await this.deleteStreakRole(guild, role_id);
    }
  }

  /**
   * Delete a HogBot streak role, then forget it. If Discord refuses for any reason other
   * than the role already being gone, the row is kept so a later cleanup retries.
   */
  private async deleteStreakRole(guild: Guild, roleId: string): Promise<void> {
    try {
      await guild.roles.delete(roleId, ROLE_UPDATE_REASON);
      logger.info(`Deleted unused streak role ${roleId} in guild ${guild.id}`);
    } catch (error) {
      if (!(error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownRole)) {
        logger.error(`Failed to delete streak role ${roleId} in guild ${guild.id}:`, error);
        return;
      }
    }
    db.prepare('DELETE FROM streak_roles WHERE role_id = ?').run(roleId);
  }

  private async fetchMember(guild: Guild, userId: string): Promise<GuildMember | null> {
    try {
      return await guild.members.fetch(userId);
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMember) return null;
      throw error;
    }
  }

  /**
   * Check for Manage Roles. Streaks keep accruing in the DB without it; the guild owner
   * is told once (per bot run) so they can fix the permission, after which the next sync
   * or restart catches roles up.
   */
  private async canManageRoles(guild: Guild): Promise<boolean> {
    if (guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      this.missingPermissionNotified.delete(guild.id);
      return true;
    }

    if (this.missingPermissionNotified.has(guild.id)) return false;
    this.missingPermissionNotified.add(guild.id);

    logger.warn(`Missing Manage Roles permission in guild ${guild.id}; voice streak roles can't be updated`);
    try {
      const owner = await guild.fetchOwner();
      await owner.send(
        `⚠️ **Voice Streak Roles Paused**\n\n` +
          `HogBot needs the **Manage Roles** permission in **${guild.name}** to assign voice streak roles. ` +
          `Streaks are still being counted - roles will catch up once the permission is granted.`
      );
    } catch (dmError) {
      logger.warn(`Could not DM guild owner for ${guild.id} about streak permissions:`, dmError);
    }
    return false;
  }
}
