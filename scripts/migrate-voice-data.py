#!/usr/bin/env python3
"""
Migration script to import voice time data from old bot
Reads from data/persistence_data.json and populates voice_time_aggregates table

ONE-TIME USE SCRIPT - Hardcoded guild ID
"""

import json
import os
import psycopg2
from psycopg2.extras import execute_values

# Hardcoded guild ID for migration
GUILD_ID = '367904135548239872'

def parse_time_to_seconds(time_string):
    """
    Parses time string format "days:hours:minutes:seconds" to total seconds
    Example: "76:04:59:37" = (76 days * 86400) + (4 hours * 3600) + (59 min * 60) + 37 sec
    """
    parts = [int(x) for x in time_string.split(':')]

    if len(parts) != 4:
        raise ValueError(f"Invalid time format: {time_string}")

    days, hours, minutes, seconds = parts
    return (days * 86400) + (hours * 3600) + (minutes * 60) + seconds

def extract_user_id_from_voice_key(key):
    """
    Extracts user_id from key like "223647480741363713_voice"
    Returns None if not a voice key
    """
    if not key.endswith('_voice'):
        return None

    return key.replace('_voice', '')

def migrate_voice_data():
    """Main migration function"""
    print('📊 Starting voice time data migration...\n')

    # Read and parse JSON file
    json_path = './data/persistence_data.json'
    with open(json_path, 'r') as f:
        data = json.load(f)

    print(f'🏰 Guild ID: {GUILD_ID}\n')

    # Extract voice data
    voice_data = {}

    # Process lifetime_sums
    for key, time_string in data['lifetime_sums'].items():
        user_id = extract_user_id_from_voice_key(key)
        if user_id:
            lifetime_seconds = parse_time_to_seconds(time_string)
            voice_data[user_id] = {
                'lifetime_seconds': lifetime_seconds,
                'weekly_seconds': 0
            }

    # Process this_week_time_sums
    for key, time_string in data['this_week_time_sums'].items():
        user_id = extract_user_id_from_voice_key(key)
        if user_id:
            weekly_seconds = parse_time_to_seconds(time_string)
            if user_id in voice_data:
                voice_data[user_id]['weekly_seconds'] = weekly_seconds
            else:
                # User has weekly data but no lifetime data (shouldn't happen, but handle it)
                voice_data[user_id] = {
                    'lifetime_seconds': weekly_seconds,
                    'weekly_seconds': weekly_seconds
                }

    print(f'👥 Found {len(voice_data)} users with voice time data\n')

    # Hardcoded database credentials (REPLACE WITH YOUR VALUES)
    conn = psycopg2.connect(
        host='YOUR_AWS_RDS_HOST.rds.amazonaws.com',
        port='5432',
        database='hogbot',
        user='hogbot',
        password='YOUR_DATABASE_PASSWORD'
    )

    try:
        cur = conn.cursor()

        # Ensure guild exists in database
        cur.execute(
            """INSERT INTO guild_settings (guild_id)
               VALUES (%s)
               ON CONFLICT (guild_id) DO NOTHING""",
            (GUILD_ID,)
        )

        # Prepare data for batch insert
        insert_data = []
        for user_id, times in voice_data.items():
            insert_data.append((
                user_id,
                GUILD_ID,
                times['lifetime_seconds'],
                times['weekly_seconds']
            ))

        # Batch insert with ON CONFLICT
        insert_query = """
            INSERT INTO voice_time_aggregates (user_id, guild_id, total_seconds, weekly_seconds, weekly_updated_at)
            VALUES %s
            ON CONFLICT (user_id, guild_id) DO UPDATE
            SET total_seconds = EXCLUDED.total_seconds,
                weekly_seconds = EXCLUDED.weekly_seconds,
                weekly_updated_at = NOW(),
                updated_at = NOW()
        """

        execute_values(
            cur, insert_query, insert_data,
            template="(%s, %s, %s, %s, NOW())"
        )

        conn.commit()

        print(f'\n✅ Migration complete!')
        print(f'   📥 Inserted/Updated: {len(insert_data)} users')

        # Show sample of migrated data
        print('\n📊 Sample migrated data:')
        cur.execute(
            """SELECT user_id, total_seconds, weekly_seconds
               FROM voice_time_aggregates
               WHERE guild_id = %s
               ORDER BY total_seconds DESC
               LIMIT 5""",
            (GUILD_ID,)
        )

        print('\nTop 5 users by total voice time:')
        for row in cur.fetchall():
            user_id, total_seconds, weekly_seconds = row
            hours = total_seconds // 3600
            weekly_hours = weekly_seconds // 3600
            print(f'  User {user_id}: {hours:,} hours total, {weekly_hours:,} hours this week')

        cur.close()

    except Exception as e:
        conn.rollback()
        print(f'❌ Migration failed: {e}')
        raise
    finally:
        conn.close()

if __name__ == '__main__':
    try:
        migrate_voice_data()
    except Exception as e:
        print(f'Fatal error: {e}')
        exit(1)
