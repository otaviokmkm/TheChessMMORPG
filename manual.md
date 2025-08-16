# Manual

This manual explains the architecture and how to extend the prototype. It should be updated after each code change.

- Server: `server/app`
  - `main.py`: FastAPI app & WebSocket endpoint
  - Serves static client at `/client`; `/` redirects to `/client/index.html`.
  - `auth.py`: JWT login/register, SQLite tables
  - `db.py`, `models.py`: SQLAlchemy setup and User model
  - `schemas.py`: Pydantic request/WS message models
  - `game/engine.py`: tick loop, authoritative action resolution
  - `game/state.py`: world and player state
  - `game/actions.py`: simultaneous resolution rules
    - Supports class selection (mage) and casting (fireball) with move/cast exclusivity per tick.
- Client: `client`
  - `index.html`, `style.css`
  - `js/net.js`: auth + websocket (same-origin `fetch` and WS)
  - `js/renderer.js`: canvas render and camera follow (ES modules)
  - `js/input.js`: keyboard -> actions (ES modules)
  - `js/main.js`: glue, HUD (loaded as `type="module"`)
    - Press C to toggle the draggable Class panel and choose Mage. The draggable Spells panel shows available spells; click Fireball or press 1 to target; click a tile to set the target. Cast resolves at end of tick.

Gameplay loop: every 2s the server resolves queued actions and broadcasts a state snapshot; the client renders it. One action per tick; clients send intents via WS; server validates moves (bounds) and applies results simultaneously.

Add classes: augment `state.Player` with class levels/xp and add leveling logic in `actions.py`.

Make a log of everyupdate of the code in the file "manual"

Run with F5
- Press F5 in VS Code and pick "F5: Server" or "Run Server Task" to start Uvicorn.
- The browser opens to `/client/index.html` automatically when the server is ready.

Changelog
- Added VS Code launch configuration to start the FastAPI server with F5 and auto-open the client. (2025-08-16)
- Added 8-bit calm background music module and UI toggle. (2025-08-16)
- Extended music generator to ~3+ minutes with multiple sections and variations to reduce repetition. (2025-08-16)
- Switched to streaming the provided MP3 with a proper play/pause toggle; stops immediately when muted. (2025-08-16)

Audio
- Toggle music via the checkbox in the HUD. Music now streams the provided MP3 `Gregor Quendel - Debussy - Arabesque No. 1 (Arr. for Music Box).mp3.mp3` from `/media/music`. The player pauses on mute and resets to the beginning when re-enabled. See `client/js/audio.js`.
