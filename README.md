# Turn-Based Tile RPG Prototype

A minimal, modular prototype of a server-authoritative, turn-based, tile-based online RPG.

- Server: Python FastAPI, WebSockets, SQLite (SQLAlchemy), JWT auth
- Client: HTML/JS Canvas

## Run

- Install Python 3.10+
- Install dependencies
- Start server
- Open `client/index.html` in a browser (or serve it statically)

## Notes

- 2s ticks; actions queued then resolved simultaneously on server
- World 20x20; camera follows player
- Player XP is per-class-ready (future classes: mage/knight/archer)
- Server is authoritative; clients only send intents
