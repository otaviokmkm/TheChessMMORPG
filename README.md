# Turn-Based Tile RPG Prototype

A minimal, modular prototype of a server-authoritative, turn-based, tile-based online RPG.

- Server: Python FastAPI, WebSockets, SQLite (SQLAlchemy), JWT auth
- Client: HTML/JS Canvas

## Features

- Server-authoritative turns: 1-second ticks, simultaneous resolution
- Mage class with Fireball (range 3, 1x1 radius) and MP management
- Resource gathering with two minigames: mining and woodcutting
- Inventory with slot grid, stacking, and weight limit
- Expanded world (60x40) with pond/bridge, forest, and an eastern cave
- Cave entrance tiles and rock walls; aggressive bat monsters (stronger than slimes)
- Real-time multiplayer over WebSockets

## Run

- Install Python 3.10+
- Install dependencies: `pip install -r requirements.txt`
- Start server: `python -m uvicorn server.app.main:app --reload`
- Open the game at http://127.0.0.1:8000/ (serves `/client/index.html`)

Alternatively, in VS Code use the Task "Run Server (Py313)".

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for detailed version history and updates.

## Notes

- Actions are queued client-side and resolved on the server each tick
- World size: 60x40; tiles: G=grass, W=water, R=rock wall (blocked), C=cave entrance (doorway), M=mine entrance (doorway)
- Player XP is stored per class (DB persistence wiring present but can be toggled)
- Server is authoritative; clients only send intents
