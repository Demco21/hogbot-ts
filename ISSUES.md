# Outstanding Issues & Potential Improvements

## 🟡 Potential Database Schema Improvements

### User ID Data Type Consistency
**Current:** User IDs stored as `BIGINT` in database, but used as `string` in TypeScript

**Consideration:**
- Discord snowflake IDs are typically handled as strings in application code
- TypeScript uses `string` for user IDs throughout the codebase
- Database uses `BIGINT` which requires casting
- Potential for precision loss with very large numbers

**Options:**
1. Migrate database column to `TEXT` or `VARCHAR(20)` for consistency
2. Keep `BIGINT` and maintain current casting approach

**Status:** Works fine currently, change optional for consistency

---

### Primary Key Strategy
**Current:** Using auto-incrementing `SERIAL` integers for primary keys

**Trade-offs:**
| Aspect | SERIAL (Integer) | UUID |
|--------|-----------------|------|
| **Size** | 4-8 bytes | 16 bytes |
| **Performance** | Faster (sequential) | Slightly slower |
| **Predictability** | Sequential | Random (more secure) |
| **Distribution** | Good for single DB | Better for distributed systems |
| **Human-readable** | Yes (1, 2, 3...) | No |

**Current Context:** Single PostgreSQL database, not distributed

**Recommendation:** Keep `SERIAL` unless scaling to distributed architecture

---

## 💡 Future Enhancements

- Consider user ID migration to `TEXT` for consistency with Discord API
- Document primary key strategy decision for future reference
