from __future__ import annotations
from typing import Dict, Optional, List, Tuple
from fastapi import WebSocket
import asyncio
import json
from datetime import datetime
from .state import GameState, Monster, WORLD_W, WORLD_H
from .actions import resolve_actions, resolve_pending_spells
from ..db import SessionLocal

class GameEngine:
    def __init__(self, tick_seconds: float = 0.25, debug: bool = False):
        self.tick_seconds = tick_seconds
        self.debug = debug
        self.state = GameState()
        self.tick_index = 0
        self._connections: Dict[int, WebSocket] = {}
        self._ws_to_player: Dict[WebSocket, int] = {}
        self._action_queue: Dict[int, dict] = {}
        self._lock = asyncio.Lock()
        # Scheduled monster respawns: list of (due_time, kind, x, y)
        self._monster_respawns: List[Tuple[float, str, int, int]] = []

    def connect_player(self, user_id: int, ws: WebSocket) -> int:
        # Authoritative: spawn or get player and attach connection
        player_id = self.state.ensure_player(user_id)
        
        # Load XP from database when player connects
        # TODO: Re-enable when database schema issue is resolved
        # db = SessionLocal()
        # try:
        #     self.state.load_player_xp(player_id, db)
        # finally:
        #     db.close()
            
        self._connections[player_id] = ws
        self._ws_to_player[ws] = player_id
        return player_id

    def disconnect_ws(self, ws: WebSocket):
        pid = self._ws_to_player.pop(ws, None)
        if pid is not None:
            # Save XP when player disconnects
            # TODO: Re-enable when database schema issue is resolved
            # db = SessionLocal()
            # try:
            #     self.state.save_player_xp(pid, db)
            # finally:
            #     db.close()
            self._connections.pop(pid, None)

    def queue_action(self, player_id: int, action_msg):
        # Replace queued action before the tick resolves, but never downgrade a cast to a move
        msg = action_msg.model_dump()
        existing = self._action_queue.get(player_id)
        if existing and existing.get("type") == "cast" and msg.get("type") == "move":
            # Keep the cast; ignore move for the remainder of this tick
            return
        # If player is currently casting, ignore movement and new casts until finished
        p = self.state.players.get(player_id)
        if p and getattr(p, 'casting', None):
            if msg.get("type") in ("move", "gather", "cast"):
                return
        self._action_queue[player_id] = msg

    async def run(self):
        # Startup diagnostics
        try:
            print(f"INFO: Game loop starting with tick_seconds={self.tick_seconds}", flush=True)
        except Exception:
            pass
        # Drift-compensated scheduler to keep a steady tick cadence ~1s
        import time
        next_tick = time.perf_counter()
        while True:
            next_tick += self.tick_seconds
            # Sleep until the scheduled next tick; if we're late, sleep 0
            delay = max(0.0, next_tick - time.perf_counter())
            if delay:
                await asyncio.sleep(delay)
            else:
                # If consistently late, don't spin: reschedule from now
                next_tick = time.perf_counter()
            await self._tick()

    async def _tick(self):
        async with self._lock:
            # Tick diagnostics: helpful to verify cadence in logs
            if self.debug:
                try:
                    now = datetime.now().strftime('%H:%M:%S')
                    print(f"DEBUG: Tick {self.tick_index + 1} start at {now} (interval={self.tick_seconds}s)", flush=True)
                except Exception:
                    pass
            # Monotonic now for time-based logic (casting, cooldowns)
            import time as _t
            monotonic_now = _t.perf_counter()
            # Ensure map exists
            self.state.ensure_map()
            # Ensure initial NPCs exist
            try:
                self.state.ensure_initial_npcs()
            except Exception:
                pass
            # Clear damage tracking from previous tick
            self.state.clear_tick_damage_tracking()
            
            actions = self._action_queue
            self._action_queue = {}
            # Resolve simultaneously
            resolve_actions(self.state, actions, monotonic_now)
            # Resolve any pending spells (for dodge mechanics)
            resolve_pending_spells(self.state)
            # Ensure initial monsters exist
            self.state.ensure_initial_monsters()
            # Safety: remove any accidental overlaps between players and monsters
            self.state.enforce_no_overlap()
            # Simple monster AI and combat
            self._monsters_act()
            # Advance projectiles and handle impacts
            self._advance_projectiles()
            # Decay effects AFTER damage application
            self._decay_effects()
            # Update damage numbers (decay TTL)
            self.state.update_damage_numbers()
            # Update notifications TTLs
            self.state.update_notifications()
            # Process scheduled monster respawns
            self._process_monster_respawns(monotonic_now)
            # Periodic XP save (every 10 ticks to prevent excessive DB writes)
            # TODO: Re-enable when database schema issue is resolved
            # if self.tick_index % 10 == 0:
            #     db = SessionLocal()
            #     try:
            #         self.state.save_all_player_xp(db)
            #     finally:
            #         db.close()
            # Handle player death/respawn after all damage for the tick
            self._respawn_dead_players()
            # Regeneration per tick (simple): skip dead players (class system removed)
            for p in self.state.players.values():
                if p.hp <= 0:
                    continue
                # Default baseline regen
                p.hp = min(p.hp_max, p.hp + 2)
                p.mp = min(p.mp_max, p.mp + 1)
            self.tick_index += 1
            # Broadcast new state snapshot
            snapshot = self.state.snapshot(monotonic_now)
            message = json.dumps({"type": "state", "tick": self.tick_index, "state": snapshot})
            await self._broadcast(message)

    async def admin_wipe(self):
        """Reset world state: monsters, effects, player positions/xp/stats. Keep connections.
        Does not touch DB users. Admin-only caller ensures authorization."""
        async with self._lock:
            # Reset monsters/effects
            self.state.monsters.clear()
            self.state._next_monster_id = 1
            self.state.effects.clear()
            self.state.damage_numbers.clear()
            self.state.pending_spells.clear()  # Clear pending spells too
            self.state._damage_this_tick.clear()  # Clear damage tracking
            # Reset NPCs
            self.state.npcs.clear()
            self.state._next_npc_id = 1
            # Reset players (keep same ids and user ids)
            cx, cy = WORLD_W // 2, WORLD_H // 2
            for p in self.state.players.values():
                p.x, p.y = self.state.find_free_near(cx, cy)
                p.xp.clear()
                p.clazz = None
                p.spells.clear()
                p.hp_max = 10
                p.hp = 10
                p.mp_max = 0
                p.mp = 0
            # Reset tick index
            self.tick_index = 0
            # Force map regeneration by clearing existing tiles
            self.state.tiles = None
            # Rebuild world and entities immediately
            self.state.ensure_map()
            self.state.ensure_initial_npcs()
            self.state.ensure_initial_monsters()
            self.state.enforce_no_overlap()
            # Prepare snapshot while holding lock for consistency
            snapshot = self.state.snapshot()
        # Broadcast after releasing the lock
        message = json.dumps({"type": "state", "tick": self.tick_index, "state": snapshot})
        await self._broadcast(message)

    def _monsters_act(self):
        # Peaceful until attacked: monsters only aggro once damaged.
        players = list(self.state.players.values())
        if not players:
            return
        if self.debug:
            print(f"DEBUG: Monsters act - {len(self.state.monsters)} monsters, {len(self.state.effects)} effects")
            for m in self.state.monsters.values():
                print(f"DEBUG: Monster {m.id} ({m.kind}) at ({m.x}, {m.y}) HP: {m.hp}/{m.hp_max} aggro: {m.aggro}")
            for pos, effect in self.state.effects.items():
                print(f"DEBUG: Effect at {pos}: {effect}")
        # Apply any AoE effects damage baseline before moving (10 dmg). Damage may cause aggro.
        effect_damage = 10
        # Damage monsters standing in effects
        for m in list(self.state.monsters.values()):
            if (m.x, m.y) in self.state.effects:
                if self.debug:
                    print(f"DEBUG: Monster {m.id} at ({m.x}, {m.y}) taking {effect_damage} damage (HP: {m.hp}/{m.hp_max})")
                val = self.state.effects[(m.x, m.y)]
                ttl, src = val if isinstance(val, tuple) else (val, None)
                m.hp = max(0, m.hp - effect_damage)
                if self.debug:
                    print(f"DEBUG: Monster {m.id} HP after damage: {m.hp}")
                # Add floating damage number
                self.state.add_damage_number(m.x, m.y, effect_damage)
                if src is not None:
                    m.last_hit_by = src
                # Getting hit triggers aggro
                m.aggro = True
                if self.debug:
                    print(f"DEBUG: Monster {m.id} is now aggro: {m.aggro}")
        # Damage players standing in effects (PvP enabled via AoE)
        for p in players:
            if (p.x, p.y) in self.state.effects:
                if self.debug:
                    print(f"DEBUG: Player {p.id} at ({p.x}, {p.y}) taking {effect_damage} damage")
                _val = self.state.effects[(p.x, p.y)]
                p.hp = max(0, p.hp - effect_damage)
                # Add floating damage number for players too
                self.state.add_damage_number(p.x, p.y, effect_damage)
        # Remove dead monsters and grant XP (credit last hitter if available, else nearest)
        db = SessionLocal()
        try:
            for mid, m in list(self.state.monsters.items()):
                if m.hp <= 0:
                    target = None
                    if m.last_hit_by and m.last_hit_by in self.state.players:
                        target = self.state.players[m.last_hit_by]
                    else:
                        target = min(players, key=lambda p: abs(p.x - m.x) + abs(p.y - m.y))
                    # Progress 'help_sergeant' quest: require killing a slime and collecting some wood
                    if target and m.kind == "slime":
                        q = target.quests.get("help_sergeant")
                        if q and q.get("status") == "started":
                            data = q.setdefault("data", {})
                            # Keep a boolean that the client can easily read and display
                            data["slimeKilled"] = True
                            wood_ok = int(data.get("wood", 0)) >= 5
                            slime_ok = bool(data.get("slimeKilled"))
                            if wood_ok and slime_ok:
                                q["status"] = "completed"
                                self.state.add_notification(target.id, "Quest complete: Help the Sergeant. Talk to him for your reward.")
                    # Schedule slime respawn at its original spawn after a short delay
                    try:
                        import time as _t
                        due = _t.perf_counter() + 12.0  # 12s respawn delay
                        self._schedule_monster_respawn("slime", m.spawn_x, m.spawn_y, due)
                        if self.debug:
                            print(f"DEBUG: Scheduled slime respawn at ({m.spawn_x},{m.spawn_y}) for t={due:.2f}")
                    except Exception:
                        pass
                    del self.state.monsters[mid]
        finally:
            db.close()
        # Rebuild list after removals
        monsters = list(self.state.monsters.values())
        for m in monsters:
            if not m.aggro:
                # Peaceful roaming behavior: move randomly within spawn radius
                self._handle_monster_roaming(m)
                continue  # peaceful: do nothing else unless aggro
            # Find nearest player
            target = min(players, key=lambda p: abs(p.x - m.x) + abs(p.y - m.y))
            # Move toward target up to m.speed tiles
            steps = m.speed
            while steps > 0 and (m.x != target.x or m.y != target.y):
                dx = 1 if target.x > m.x else (-1 if target.x < m.x else 0)
                dy = 1 if target.y > m.y else (-1 if target.y < m.y else 0)
                # prefer horizontal then vertical to approach
                nx, ny = (m.x + dx, m.y) if dx != 0 else (m.x, m.y + dy)
                if self.state.is_free(nx, ny):  # avoid stepping onto occupied tiles
                    m.x, m.y = nx, ny
                steps -= 1
            # Attack if adjacent (manhattan 1) and cooldown has passed
            if abs(target.x - m.x) + abs(target.y - m.y) == 1:
                import time as _t
                current_time = _t.perf_counter()
                # Check attack cooldown (2 seconds between attacks)
                if current_time >= m.last_attack_time + 2.0:
                    target.hp = max(0, target.hp - m.dmg)
                    # Add floating damage number for monster attacks
                    self.state.add_damage_number(target.x, target.y, m.dmg)
                    # Update last attack time
                    m.last_attack_time = current_time
                    if self.debug:
                        print(f"DEBUG: Monster {m.id} attacked player {target.id} for {m.dmg} damage")
                elif self.debug:
                    print(f"DEBUG: Monster {m.id} attack on cooldown (last: {m.last_attack_time:.2f}, current: {current_time:.2f})")

    def _schedule_monster_respawn(self, kind: str, x: int, y: int, due_time: float):
        """Queue a monster respawn. Deduplicate identical pending entries."""
        for (due, k, sx, sy) in self._monster_respawns:
            if k == kind and sx == x and sy == y and abs(due - due_time) < 0.01:
                return
        self._monster_respawns.append((due_time, kind, x, y))

    def _process_monster_respawns(self, now: float):
        if not self._monster_respawns:
            return
        remaining: List[Tuple[float, str, int, int]] = []
        for (due, kind, x, y) in self._monster_respawns:
            if now >= due:
                try:
                    if kind == "slime":
                        self.state.spawn_slime(x, y)
                        if self.debug:
                            print(f"DEBUG: Respawned slime at ({x},{y})")
                    # Add other monster kinds here as needed
                except Exception:
                    # If spawn failed (e.g., invalid tile), retry shortly
                    import time as _t
                    remaining.append((_t.perf_counter() + 2.0, kind, x, y))
            else:
                remaining.append((due, kind, x, y))
        self._monster_respawns = remaining

    def _handle_monster_roaming(self, m: Monster):
        """Move a non-aggro monster randomly, staying within its roam radius and avoiding blocked tiles."""
        try:
            import random
            # 50% chance to stay idle this tick to avoid jittery movement
            if random.random() < 0.5:
                return
            # Try up to 4 directions in random order
            dirs = [(1,0),(-1,0),(0,1),(0,-1)]
            random.shuffle(dirs)
            for dx, dy in dirs:
                nx, ny = m.x + dx, m.y + dy
                # Stay within roam radius of spawn
                if abs(nx - m.spawn_x) + abs(ny - m.spawn_y) > max(0, int(getattr(m, 'roam_radius', 3))):
                    continue
                if self.state.is_free(nx, ny):
                    m.x, m.y = nx, ny
                    return
        except Exception:
            # Be robust if anything goes wrong
            return

    async def _broadcast(self, text: str):
        # Send to all connected clients; swallow individual errors
        for ws in list(self._connections.values()):
            try:
                await ws.send_text(text)
            except Exception:
                pass

    def _respawn_dead_players(self):
        """Respawn players at spawn (center). If spawn is occupied by a slime, the player dies immediately.
        Do not attempt multiple respawns within the same tick to avoid loops.
        """
        SPAWN_X, SPAWN_Y = WORLD_W // 2, WORLD_H // 2
        for p in self.state.players.values():
            if p.hp <= 0:
                # Respawn at spawn space
                p.x, p.y = SPAWN_X, SPAWN_Y
                p.hp = p.hp_max
                # Optional: restore some MP baseline
                p.mp = min(p.mp_max, p.mp)
                # Lethal if a monster is occupying spawn tile
                if self.state.is_occupied_by_monsters(p.x, p.y):
                    p.hp = 0

    def _advance_projectiles(self):
            """Move projectiles by their speed each tick; apply damage on first impact.
            Projectiles travel in straight lines and stop when hitting a monster/player or an unwalkable tile.
            """
            to_delete = []
            for pid, pr in list(self.state.projectiles.items()):
                # First, check immediate impact on the current tile (spawn tile)
                # This ensures a monster standing on the adjacent tile is hit immediately on spawn.
                hit_mon_curr = next((m for m in self.state.monsters.values() if m.x == pr.x and m.y == pr.y), None)
                if hit_mon_curr is not None:
                    hit_mon_curr.hp = max(0, hit_mon_curr.hp - pr.dmg)
                    hit_mon_curr.last_hit_by = pr.caster_id
                    self.state.add_damage_number(pr.x, pr.y, pr.dmg)
                    to_delete.append(pid)
                    continue
                hit_pl_curr = next((pl for pl in self.state.players.values() if pl.x == pr.x and pl.y == pr.y and pl.id != pr.caster_id), None)
                if hit_pl_curr is not None:
                    hit_pl_curr.hp = max(0, hit_pl_curr.hp - pr.dmg)
                    self.state.add_damage_number(pr.x, pr.y, pr.dmg)
                    to_delete.append(pid)
                    continue
                # On the spawn tick, don't move. This ensures clients render at least one frame
                # of the projectile at its start position before it advances next tick.
                if getattr(pr, 'just_spawned', False):
                    pr.just_spawned = False
                    continue
                steps = pr.speed
                while steps > 0 and pr.ttl > 0:
                    nx, ny = pr.x + pr.dx, pr.y + pr.dy
                    # Stop if out of bounds or not walkable
                    if not (0 <= nx < WORLD_W and 0 <= ny < WORLD_H) or not self.state.is_walkable(nx, ny):
                        to_delete.append(pid)
                        break
                    # Check monster hit first
                    hit_mon = next((m for m in self.state.monsters.values() if m.x == nx and m.y == ny), None)
                    if hit_mon is not None:
                        hit_mon.hp = max(0, hit_mon.hp - pr.dmg)
                        # credit last hitter
                        hit_mon.last_hit_by = pr.caster_id
                        # spawn floating damage
                        self.state.add_damage_number(nx, ny, pr.dmg)
                        to_delete.append(pid)
                        break
                    # Check player hit (PvP)
                    hit_pl = next((pl for pl in self.state.players.values() if pl.x == nx and pl.y == ny and pl.id != pr.caster_id), None)
                    if hit_pl is not None:
                        hit_pl.hp = max(0, hit_pl.hp - pr.dmg)
                        self.state.add_damage_number(nx, ny, pr.dmg)
                        to_delete.append(pid)
                        break
                    # Advance
                    pr.x, pr.y = nx, ny
                    pr.ttl -= 1
                    steps -= 1
                # expire when ttl runs out
                if pr.ttl <= 0 and pid not in to_delete:
                    to_delete.append(pid)
            for pid in to_delete:
                self.state.projectiles.pop(pid, None)

    def _decay_effects(self):
        """Decay effect TTL and remove expired effects."""
        expired = []
        for k in list(self.state.effects.keys()):
            ttl, src = self.state.effects[k] if isinstance(self.state.effects[k], tuple) else (self.state.effects[k], None)
            ttl -= 1
            if ttl <= 0:
                expired.append(k)
                if self.debug:
                    print(f"DEBUG: Effect at {k} expired")
            else:
                self.state.effects[k] = (ttl, src)
        for k in expired:
            self.state.effects.pop(k, None)
