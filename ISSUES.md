# Known Issues & Redesign Tasks

## ✅ Fixed Issues

### 1. ✅ Interaction Timeout Errors (FIXED - Dec 30, 2025)
**Error:** `DiscordAPIError[10062]: Unknown interaction` and `Interaction has already been acknowledged`

**Root Cause:** Commands were taking too long to respond (>3 seconds). Discord requires interaction acknowledgment within 3 seconds.

**Solution Applied:** Added `deferReply()` to all commands for database-heavy operations
```typescript
await interaction.deferReply();
// ... do database work ...
await interaction.editReply({ embeds: [embed] });
```

**Status:** ✅ All Milestone 3 commands (mywallet, beg, loan, leaderboard, stats) now properly defer replies

---

### 2. ✅ Beg Command Logic (FIXED - Dec 30, 2025)
**Original Issue:**
- Had 5-minute cooldown (incorrect)
- Worked regardless of balance (incorrect)

**Correct Behavior (from Python version - `services/gamble_service.py:365`):**
- ONLY works when balance is **exactly 0**
- **NO cooldown** (can beg repeatedly while broke)
- Gives random amount between 50-200
- Has fun random messages

**Solution Applied:**
- ✅ Removed all cooldown logic (no more `last_beg_time` checks)
- ✅ Added balance check: only works when balance = 0
- ✅ Gives 50-200 coins randomly
- ✅ Added fun random messages from Python version

**Status:** ✅ Beg command now matches Python behavior exactly

---

### 3. ✅ Stats Not Recording in Games (FIXED - Dec 30, 2025)
**Original Issue:** After playing slots, `/stats` command shows "You haven't played any games yet!"

**Root Cause:** Game commands were calling `WalletService.updateBalance()` but NOT calling `StatsService.updateGameStats()` to record game results in the `game_stats` table.

**Solution Implemented:**
1. **Updated slots command** - Added `statsService.updateGameStats()` call after every game result (win or loss)
2. **Fixed StatsService.updateGameStats()** - Changed extra_stats merging logic to INCREMENT numeric counters instead of overwriting them
3. **Documented pattern in CLAUDE.md** - Added explicit instructions for future game implementations

**Code Pattern (must be used in ALL game commands):**
```typescript
// After EVERY game result
await this.container.statsService.updateGameStats(
  userId,
  GameSource.GAME_NAME,
  wonOrLost, // true for win, false for loss
  betAmount,
  payoutAmount, // 0 if lost
  extraStats // e.g., { bonus_spins: 1, jackpot_hits: 1 }
);
```

**Status:** ✅ Fixed in slots, pattern documented for future games

---

### 4. ✅ Metadata Field Pollution (VERIFIED FIXED - Dec 30, 2025)
**Original Issue:** `extra_metadata` JSONB field could store entire database connection object if wrong parameter passed

**Verification Status:** ✅ **Not an issue in current implementation**

**Verified Locations:**
- `WalletService.updateBalance()` - Line 122: ✅ Properly passes `JSON.stringify(metadata)`
- `WalletService.transferCoins()` - Line 228: ✅ Passes `{ receiver_id, amount }`
- `WalletService.transferCoins()` - Line 240: ✅ Passes `{ sender_id, amount }`

**Current Implementation:**
```typescript
// updateBalance accepts metadata parameter (defaults to {})
async updateBalance(
  userId: string,
  amount: number,
  gameSource: GameSource,
  updateType: UpdateType,
  metadata: Record<string, any> = {}  // ✅ Correct type
): Promise<number>

// Properly JSON stringifies metadata
await client.query(
  'SELECT * FROM update_wallet_with_history($1, $2, $3, $4, $5)',
  [userId, amount, gameSource, updateType, JSON.stringify(metadata)]  // ✅ Correct
);
```

**Status:** ✅ No action needed - implementation is correct

---

## 🟡 Database Schema Issues (Redesign Required)

### 4. User ID Data Type Mismatch
**Current:** User IDs stored as `BIGINT` (numbers)

**Problem:**
- Discord snowflake IDs should be strings in application code
- TypeScript uses `string` for user IDs
- Database uses `BIGINT`
- Potential for overflow or precision loss

**Solution Options:**
1. Change database column to `TEXT` or `VARCHAR(20)`
2. Keep `BIGINT` but ensure proper casting everywhere

**Recommendation:** Use `TEXT` for consistency with Discord API

---

### 5. ID Field Type - Integer vs UUID
**Current:** Using auto-incrementing `SERIAL` integers for primary keys

**Question:** Should we use UUIDs instead?

**Trade-offs:**
| Aspect | SERIAL (Integer) | UUID |
|--------|-----------------|------|
| **Size** | 4-8 bytes | 16 bytes |
| **Performance** | Faster (sequential) | Slightly slower |
| **Predictability** | Sequential (security risk) | Random (more secure) |
| **Distribution** | Good for single DB | Better for distributed systems |
| **Human-readable** | Yes (1, 2, 3...) | No (550e8400-e29b-41d4-a716-446655440000) |

**Current Context:** Single PostgreSQL database, not distributed

**Recommendation:** Keep `SERIAL` for now unless there's a specific security/distribution concern

---

## 📋 Summary by Priority

### ✅ Fixed & Verified (Dec 30, 2025):
1. ✅ Interaction timeout errors - All commands now defer replies properly
2. ✅ Beg command logic - Fixed to match Python behavior (balance = 0, no cooldown)
3. ✅ Stats not recording in games - Added `statsService.updateGameStats()` calls, fixed counter incrementation
4. ✅ Metadata field pollution - Verified implementation is correct, no issues found

### 🟡 Can Fix Later (Architectural - Non-blocking):
5. ⏸️ User ID data type (works but inconsistent)
6. ⏸️ ID field type decision (works fine as-is)

---

## Next Steps

### Ready for Milestone 4! 🎉
All critical issues are resolved. We can proceed with implementing game commands:
- `/blackjack` - Classic card game
- `/slots` - Slot machine with progressive jackpot
- `/ceelo` - Dice rolling game
- `/ridethebus` - Card-based game

### Future Improvements (Optional):
1. **Later:** Consider user ID migration to TEXT for consistency with Discord API
2. **Later:** Document ID strategy decision (SERIAL is fine for current use case)

---

## References

- Python Beg Command: `E:\dev\repos\hogbot\cogs\gamble_cog.py` (check `!beg` command implementation)
- Metadata Issue: Search for all calls to `update_wallet_with_history()` in services

● I found the issue! The blackjack animations are passing interaction to safeEdit() multiple times in the same sequence, but button interactions can only be responded to once (3-second window). After that, you must use message.edit() directly.

  Let me fix the animation timing and game cleanup issues: