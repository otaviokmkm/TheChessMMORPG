from __future__ import annotations
from typing import Dict, Optional
from fastapi import WebSocket
import asyncio
import json
from .state import GameState, Monster
from .actions import resolve_actions, resolve_pending_spells
from ..db import SessionLocal

class GameEngine:
    def __init__(self, tick_seconds: float = 3.0):
        self.tick_seconds = tick_seconds
        self.state = GameState()
        self.tick_index = 0
        self._connections: Dict[int, WebSocket] = {}
        self._ws_to_player: Dict[WebSocket, int] = {}
        self._action_queue: Dict[int, dict] = {}
        self._lock = asyncio.Lock()

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
        self._action_queue[player_id] = msg

    async def run(self):
        while True:
            await asyncio.sleep(self.tick_seconds)
            await self._tick()

    async def _tick(self):
        async with self._lock:
            # Clear damage tracking from previous tick
            self.state.clear_tick_damage_tracking()
            
            actions = self._action_queue
            self._action_queue = {}
            # Resolve simultaneously
            resolve_actions(self.state, actions)
            # Resolve any pending spells (for dodge mechanics)
            resolve_pending_spells(self.state)
            # Ensure initial monsters exist
            self.state.ensure_initial_monsters()
            # Safety: remove any accidental overlaps between players and monsters
            self.state.enforce_no_overlap()
            # Simple monster AI and combat
            self._monsters_act()
            # Decay effects AFTER damage application
            self._decay_effects()
            # Update damage numbers (decay TTL)
            self.state.update_damage_numbers()
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
            # Regeneration per tick (simple): differs by class; skip dead players
            for p in self.state.players.values():
                if p.hp <= 0:
                    continue
                if p.clazz == 'mage':
                    # Light HP, faster MP regen
                    p.hp = min(p.hp_max, p.hp + 1)
                    p.mp = min(p.mp_max, p.mp + 4)
                else:
                    # Default baseline
                    p.hp = min(p.hp_max, p.hp + 2)
                    p.mp = min(p.mp_max, p.mp + 1)
            self.tick_index += 1
            # Broadcast new state snapshot
            snapshot = self.state.snapshot()
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
            # Reset players (keep same ids and user ids)
            for p in self.state.players.values():
                p.x, p.y = self.state.find_free_near(1, 1)
                p.xp.clear()
                p.clazz = None
                p.spells.clear()
                p.hp_max = 10
                p.hp = 10
                p.mp_max = 0
                p.mp = 0
            # Reset tick index
            self.tick_index = 0
            # Immediately ensure initial monsters and broadcast a fresh snapshot
            self.state.ensure_initial_monsters()
            self.state.enforce_no_overlap()
            snapshot = self.state.snapshot()
            message = json.dumps({"type": "state", "tick": self.tick_index, "state": snapshot})
            await self._broadcast(message)

    def _monsters_act(self):
        # Peaceful until attacked: monsters only aggro once damaged.
        players = list(self.state.players.values())
        if not players:
            return
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
                print(f"DEBUG: Monster {m.id} at ({m.x}, {m.y}) taking {effect_damage} damage (HP: {m.hp}/{m.hp_max})")
                val = self.state.effects[(m.x, m.y)]
                ttl, src = val if isinstance(val, tuple) else (val, None)
                m.hp = max(0, m.hp - effect_damage)
                print(f"DEBUG: Monster {m.id} HP after damage: {m.hp}")
                # Add floating damage number
                self.state.add_damage_number(m.x, m.y, effect_damage)
                if src is not None:
                    m.last_hit_by = src
                # Getting hit triggers aggro
                m.aggro = True
                print(f"DEBUG: Monster {m.id} is now aggro: {m.aggro}")
        # Damage players standing in effects (PvP enabled via AoE)
        for p in players:
            if (p.x, p.y) in self.state.effects:
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
                    if target.clazz:
                        old_xp = target.xp.get(target.clazz, 0)
                        target.xp[target.clazz] = old_xp + m.xp_reward
                        # TODO: Save XP to database (temporarily disabled due to schema issue)
                        # self.state.save_player_xp(target.id, db)
                        print(f"DEBUG: Player {target.id} gained {m.xp_reward} XP in {target.clazz} class (was {old_xp}, now {target.xp[target.clazz]})")
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
            # Attack if adjacent (manhattan 1)
            if abs(target.x - m.x) + abs(target.y - m.y) == 1:
                target.hp = max(0, target.hp - m.dmg)
                # Add floating damage number for monster attacks
                self.state.add_damage_number(target.x, target.y, m.dmg)

    def _handle_monster_roaming(self, monster: Monster):
        """Handle peaceful monster roaming within spawn radius."""
        import random
        
        # Only roam occasionally (30% chance per tick to prevent constant movement)
        if random.random() > 0.3:
            return
            
        # Calculate distance from spawn
        dist_from_spawn = abs(monster.x - monster.spawn_x) + abs(monster.y - monster.spawn_y)
        
        print(f"DEBUG: Monster {monster.id} roaming: at ({monster.x},{monster.y}), spawn ({monster.spawn_x},{monster.spawn_y}), dist {dist_from_spawn}, radius {monster.roam_radius}")
        
        # If at the edge of roam radius, prefer moving back toward spawn
        if dist_from_spawn >= monster.roam_radius:
            # Move toward spawn
            dx = 1 if monster.spawn_x > monster.x else (-1 if monster.spawn_x < monster.x else 0)
            dy = 1 if monster.spawn_y > monster.y else (-1 if monster.spawn_y < monster.y else 0)
            # Try horizontal first, then vertical
            if dx != 0:
                nx, ny = monster.x + dx, monster.y
                if self.state.is_free(nx, ny):
                    monster.x, monster.y = nx, ny
                    print(f"DEBUG: Monster {monster.id} moved toward spawn: ({nx}, {ny})")
                    return
            if dy != 0:
                nx, ny = monster.x, monster.y + dy
                if self.state.is_free(nx, ny):
                    monster.x, monster.y = nx, ny
                    print(f"DEBUG: Monster {monster.id} moved toward spawn: ({nx}, {ny})")
                    return
        else:
            # Random movement within allowed area
            directions = [(0, 1), (0, -1), (1, 0), (-1, 0)]
            random.shuffle(directions)
            
            for dx, dy in directions:
                nx, ny = monster.x + dx, monster.y + dy
                # Check if new position would be within roam radius
                new_dist = abs(nx - monster.spawn_x) + abs(ny - monster.spawn_y)
                if new_dist <= monster.roam_radius and self.state.is_free(nx, ny):
                    monster.x, monster.y = nx, ny
                    print(f"DEBUG: Monster {monster.id} roamed randomly: ({nx}, {ny})")
                    break

    async def _broadcast(self, text: str):
        # Send to all connected clients; swallow individual errors
        for ws in list(self._connections.values()):
            try:
                await ws.send_text(text)
            except Exception:
                pass

    def _respawn_dead_players(self):
        """Respawn players at spawn (1,1). If spawn is occupied by a slime, the player dies immediately.
        Do not attempt multiple respawns within the same tick to avoid loops.
        """
        SPAWN_X, SPAWN_Y = 1, 1
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

    def _decay_effects(self):
        """Decay effect TTL and remove expired effects."""
        expired = []
        for k in list(self.state.effects.keys()):
            ttl, src = self.state.effects[k] if isinstance(self.state.effects[k], tuple) else (self.state.effects[k], None)
            ttl -= 1
            if ttl <= 0:
                expired.append(k)
                print(f"DEBUG: Effect at {k} expired")
            else:
                self.state.effects[k] = (ttl, src)
        for k in expired:
            self.state.effects.pop(k, None)
