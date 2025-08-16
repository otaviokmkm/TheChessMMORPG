#!/usr/bin/env python3
"""
Database migration script to add class_xp column to existing users table.
"""

import sqlite3
import json
import os

def migrate_database():
    """Add class_xp column to users table if it doesn't exist."""
    db_path = "game.db"
    
    # Check if backup exists
    if os.path.exists("game.db.backup"):
        print("Found backup database, migrating...")
        # Copy backup to current db
        import shutil
        shutil.copy("game.db.backup", db_path)
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    try:
        # Check if class_xp column exists
        cursor.execute("PRAGMA table_info(users)")
        columns = [column[1] for column in cursor.fetchall()]
        
        if "class_xp" not in columns:
            print("Adding class_xp column to users table...")
            # Add the new column with default empty JSON
            cursor.execute("ALTER TABLE users ADD COLUMN class_xp TEXT DEFAULT '{}'")
            conn.commit()
            print("✅ Successfully added class_xp column")
        else:
            print("✅ class_xp column already exists")
            
    except Exception as e:
        print(f"❌ Migration failed: {e}")
    finally:
        conn.close()

if __name__ == "__main__":
    migrate_database()
