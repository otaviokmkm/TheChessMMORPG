# Manual

This manual explains the architecture and how to extend the prototype. It should be updated after each code change.

- Server: `server/app`
  - `main.py`: FastAPI app & WebSocket endpoint
  - Serves static client at `/client`; `/` redirects to `/client/index.html`.
  - `auth.py`: JWT login/register, SQLite tables
  - `db.py`, `models.py`: SQLAlchemy setup and User model
  - `schemas.py`: Pydantic request/WS message models
  - `game/engine.py`: tick loop (1s per tick), authoritative action resolution
  - `game/state.py`: world, terrain (tiles), resources (trees/rocks), and player state
  - `game/actions.py`: simultaneous resolution rules
    - Supports class selection (mage), casting (fireball), gathering, with move/cast/gather exclusivity per tick (cast overrides move/gather).
- Client: `client`
  - `index.html`, `style.css`
  - `js/net.js`: auth + websocket (same-origin `fetch` and WS)
  - `js/renderer.js`: canvas render and camera follow (ES modules)
    - Rendering decoupled from state updates; `update()` only applies data, while `draw()` is called by the animation loop.
    - Terrain rendering: grass and water tiles (no grid lines). Trees and rocks are drawn with small HP pips.
    - Targeting preview colors: in-range = warm yellow, out-of-range = muted red; pulsing alpha while targeting; brief green flash on confirm.
  - `js/input.js`: keyboard -> actions (ES modules)
  - `js/main.js`: glue, HUD (loaded as `type="module"`)
    - Press C to toggle the draggable Class panel and choose Mage. The draggable Spells panel shows available spells; click Fireball or press 1 to target; click a tile to set the target. Cast resolves at end of tick.
    - Smooth 60 FPS render loop via `requestAnimationFrame`; spell area/range preview updates continuously between server ticks.
    - After selecting a valid target, the selected spell area remains visible until the next server tick, then clears automatically.
$env:ADMIN_USERS = 'admin'
Gameplay loop: every 1s the server resolves queued actions and broadcasts a state snapshot; the client renders it. One action per tick; clients send intents via WS; server validates moves (bounds/occupancy/terrain/resources) and applies results simultaneously.

World & Rules
- Action exclusivity per tick: a character cannot both move and cast in the same tick. If both are attempted, casting takes precedence and the move is ignored for that tick.
- Tile occupancy: no two units (players or monsters) can occupy the same tile. Player moves to occupied tiles are rejected; simultaneous moves to the same tile resolve deterministically (lowest player id wins).
- Slimes are peaceful until attacked: they do nothing until they take damage, then they aggro the nearest player.
 - Overlap self-heal: if a legacy bug ever leaves a monster on the same tile as a player, the server relocates the monster to the nearest free tile on the next tick.
 - PvP damage: players are affected by AoE spell tiles (e.g., Fireball) and take damage if standing in an effect.
 - Death and respawn: when a player's HP reaches 0, they respawn at world center with full HP. If a slime occupies the spawn tile at that moment, the player immediately dies (lethal spawn hazard).
 - Terrain: the world is a forest with a large pond.
   - Tiles: `G` = grass (walkable), `W` = water (not walkable).
   - Resources: trees and rocks are placed on grass tiles; they block movement until gathered. Each has small HP and is removed on depletion.
 - Gathering: press `G` or right-click the canvas (when not casting) to gather a resource on your tile or adjacent (N/E/S/W). Each gather reduces resource HP by 1; when HP reaches 0 the resource disappears.

Server snapshot fields
- `world`: `{ w, h }`
- `tiles`: array of strings (`'G'`/`'W'`) for each row
- `players`: positions/stats
- `monsters`: positions/stats
- `resources`: list of `{ x, y, type: 'tree'|'rock', hp }`
- `effects`, `pendingSpells`, `damageNumbers`

Add classes: augment `state.Player` with class levels/xp and add leveling logic in `actions.py`.

Make a log of everyupdate of the code in the file "manual"

Run with F5
- Press F5 in VS Code and pick "F5: Server" or "Run Server Task" to start Uvicorn.
- The browser opens to `/client/index.html` automatically when the server is ready.
 - Press F6 to stop the running server task (or stop debugging if active).

Changelog
- World: Added forest tilemap with a large pond; water is impassable. Server now streams `tiles` and `resources` to clients. (2025-08-16)
- Resources: Trees and rocks spawn across grass. They block movement and are gatherable (G key or right-click); each gather reduces HP; removed when depleted. (2025-08-16)
- Tick rate: Server tick speed set to 1 second. (2025-08-16)
- UI: Removed grid lines; added resource rendering with HP pips. (2025-08-16)
- Core: Reverted tick duration back to 1 second and implemented a drift-compensated scheduler. Disabled verbose debug logs by default to prevent slow ticks. Prevented multiple units from occupying the same tile; simultaneous player collisions resolve deterministically. Slimes remain peaceful until attacked, then aggro. (2025-08-16)
- Bugfix: Added server-side enforcement to relocate any monster overlapping a player to the nearest free tile each tick (and after admin wipes). (2025-08-16)
- Combat: Players now take damage from AoE effects (friendly fire/PvP enabled). (2025-08-16)
- Combat: Player death/respawn implemented. Respawn at (1,1); if a slime is at spawn, respawn is lethal immediately. (2025-08-16)
- UI: Added monster health bars above their heads with color-coded health (green > yellow > red). Monster names displayed above health bars. (2025-08-16)
- UI: Added floating damage numbers that appear when units take damage, fade out over time, and float upward. (2025-08-16)
- Visual: Monsters now change color when aggro (red when attacking, green when peaceful). (2025-08-16)
- Server rules: Enforced action exclusivity (cannot move and cast in the same tick; cast overrides move). (2025-08-16)
- Client UX: Added 60 FPS render loop; targeting preview now pulses (yellow in-range, red out-of-range) and flashes green on confirm; selected area persists until the next server tick. (2025-08-16)
- Deployment: Added `gunicorn==21.2.0` to `requirements.txt` to support Render start command. (2025-08-16)
- Added VS Code launch configuration to start the FastAPI server with F5 and auto-open the client. (2025-08-16)
- Added 8-bit calm background music module and UI toggle. (2025-08-16)
- Extended music generator to ~3+ minutes with multiple sections and variations to reduce repetition. (2025-08-16)
- Switched to streaming the provided MP3 with a proper play/pause toggle; stops immediately when muted. (2025-08-16)
- Enhanced damage numbers: Now fade out smoothly like Ragnarok Online with scaling effects and smooth opacity transitions. (2025-08-16)
- Dodge mechanics: Spells now have a 1-tick delay before hitting. Enemies (players and monsters) can avoid damage by moving out of the original cast range after a spell is cast but before it resolves. Pending spells show orange warning indicators with countdown timers. (2025-08-16)
- Fixed damage numbers: Damage numbers now only appear once when damage is dealt, preventing duplicates and repetition. Server now tracks damage per tick to prevent multiple numbers from appearing for the same damage instance. (2025-08-16)
- World: Added a 2-tile wide bridge connecting the central island to the mainland, allowing players to escape from being trapped in the lake. Bridge is generated during map creation and visible after admin world wipe. (2025-08-16)
- UI: Added settings menu with gear icon (⚙️) in the HUD. Initial setting: Grid toggle to show/hide tile grid lines. Settings panel is draggable like other panels. (2025-08-16)

Admin World Wipe (2025-08-16)
- Added admin-only HTTP endpoint `POST /admin/wipe` that resets the in-memory world state: clears monsters and effects, resets all players to spawn with base stats (hp/mp), clears class, spells, and xp; preserves user accounts (usernames/passwords in DB untouched). Map tiles/resources are preserved.
- Added client HUD button "Wipe World" shown only to admins (based on `/auth/me` which returns `{ id, username, is_admin }`). The button asks for double confirmation and calls the endpoint with the bearer token.
- Admin definition: set environment variable `ADMIN_USERS` to a comma-separated list of usernames (default: `admin`). Example: `ADMIN_USERS=admin,gm1`.
- Abuse prevention: server enforces admin check on `/admin/wipe`. Non-admins receive 403. Hiding the button in the client is cosmetic only; authorization is server-side.

Audio
- Toggle music via the checkbox in the HUD. Music now streams the provided MP3 `Gregor Quendel - Debussy - Arabesque No. 1 (Arr. for Music Box).mp3.mp3` from `/media/music`. The player pauses on mute and resets to the beginning when re-enabled. See `client/js/audio.js`.

Admin user creation
- A helper script is available at `server/app/scripts/create_admin.py` to seed an admin user into the database. Run from the repo root so package imports resolve:

```bash
python -m server.app.scripts.create_admin --username admin
```

If `--password` is omitted the script prints a securely generated password and a JWT you can use as a Bearer token. The server determines who is an admin by the `ADMIN_USERS` environment variable (comma-separated usernames). Make sure the username you create is included there (default: `admin`).

Changelog
- Added `server/app/scripts/create_admin.py` to seed admin users and printed JWT for quick testing. (2025-08-16)
