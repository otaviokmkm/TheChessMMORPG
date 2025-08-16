"""Seed an admin user into the SQLite database.

Run as a module from the repository root to ensure package imports work:

  python -m server.app.scripts.create_admin --username admin

If --password is omitted a secure random password is generated and printed.
The script prints a short-lived JWT so you can immediately authenticate in the client.
"""
from __future__ import annotations

import argparse
import secrets
import sys
from typing import Optional

from server.app.db import Base, engine, SessionLocal
from server.app.models import User
from server.app.auth import get_password_hash, create_access_token


def ensure_tables() -> None:
    Base.metadata.create_all(bind=engine)


def create_user(username: str, password: str) -> User:
    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.username == username).first()
        if existing:
            return existing
        u = User(username=username, password_hash=get_password_hash(password))
        db.add(u)
        db.commit()
        db.refresh(u)
        return u
    finally:
        db.close()


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Create/seed an admin user in the game DB")
    parser.add_argument("--username", default="admin", help="Admin username to create (default: admin)")
    parser.add_argument("--password", help="Password to set. If omitted a random password will be generated")
    args = parser.parse_args(argv)

    ensure_tables()

    username = args.username.strip()
    password = args.password or secrets.token_urlsafe(12)

    user = create_user(username, password)
    if user.username == username and (not args.password):
        print(f"Created user '{username}' with generated password:")
    elif user.username == username and args.password:
        print(f"Created user '{username}' with provided password")
    else:
        print(f"User '{username}' already exists. Leaving password unchanged.")

    # Print credentials and a token
    print(f"username: {user.username}")
    if not args.password and user.username == username:
        print(f"password: {password}")

    # Create a token to allow immediate testing (long expiry like normal app)
    token = create_access_token({"sub": str(user.id)})
    print()
    print("Use this token as a Bearer token in the Authorization header:")
    print(token)

    print()
    print("Reminder: ensure the ADMIN_USERS environment variable includes this username (default: 'admin').")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
