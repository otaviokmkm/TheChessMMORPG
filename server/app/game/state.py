from __future__ import annotations
from dataclasses import dataclass, field
from typing import Dict, Tuple, Optional, Iterable, List
from sqlalchemy.orm import Session

WORLD_W = 60
WORLD_H = 40

@dataclass
class Player:
    id: int
    user_id: int
    x: int
    y: int
    # Experience per class (future-proof)
    xp: Dict[str, int] = field(default_factory=dict)
    clazz: Optional[str] = None  # deprecated
    # Known spells by id/name
    spells: Dict[str, dict] = field(default_factory=dict)
    # Inventory: item name -> count
    inventory: Dict[str, int] = field(default_factory=dict)
    # Simple quest tracking: quest_id -> {status: str, data: dict}
    quests: Dict[str, dict] = field(default_factory=dict)
    # Per-player notifications (text + ttl ticks)
    notifications: List[Tuple[str, int]] = field(default_factory=list)
    # Vital stats
    hp: int = 10
    hp_max: int = 10
    mp: int = 0
    mp_max: int = 0
    # Runtime-only fields (not persisted): cooldowns and casting state
    # cooldowns: Dict[str, float] -> monotonic "ready at" time
    # casting: Optional[dict] -> { spell, target(x,y), end: float, rng, rad, mana }
    cooldowns: Dict[str, float] = field(default_factory=dict)
    casting: Optional[dict] = None

@dataclass
class Monster:
    id: int
    kind: str
    x: int
    y: int
    hp: int
    hp_max: int
    dmg: int
    speed: int  # tiles per tick
    xp_reward: int = 5
    last_hit_by: Optional[int] = None  # player id
    aggro: bool = False  # peaceful until attacked
    spawn_x: int = 0  # original spawn location for roaming
    spawn_y: int = 0
    roam_radius: int = 3  # maximum distance from spawn when roaming
    last_attack_time: float = 0  # cooldown for attacks

@dataclass
class PendingSpell:
    """A spell that has been cast but hasn't resolved yet (for dodge mechanics)"""
    caster_id: int
    spell_name: str
    target_x: int
    target_y: int
    cast_range: int
    cast_radius: int
    ticks_remaining: int
    original_caster_pos: tuple  # (x, y) when cast was initiated

@dataclass
class Projectile:
    id: int
    caster_id: int
    x: int
    y: int
    dx: int
    dy: int
    speed: int  # tiles per tick
    ttl: int    # remaining tiles to travel
    dmg: int = 10
    # Prevent immediate movement on spawn tick so clients can see it travel
    just_spawned: bool = True

class GameState:
    def __init__(self):
        # Players and identifiers
        self.players: Dict[int, Player] = {}
        self._next_player_id = 1
        # simple AoE effects map: {(x,y): (ttl, source_pid)}
        self.effects: Dict[Tuple[int, int], Tuple[int, Optional[int]]] = {}
        # Monsters
        self.monsters: Dict[int, Monster] = {}
        self._next_monster_id = 1
        # Floating damage numbers: {(x, y): [(damage, ttl), ...]}
        self.damage_numbers: Dict[Tuple[int, int], List[Tuple[int, int]]] = {}
        # Pending spells (for dodge mechanics)
        self.pending_spells: List[PendingSpell] = []
        # Moving projectiles
        self.projectiles: Dict[int, Projectile] = {}
        self._next_projectile_id = 1
        # Track damage dealt this tick to prevent duplicate numbers
        self._damage_this_tick: Dict[Tuple[int, int], int] = {}
        # Tile map and resources
        # tiles: list of chars: 'G' grass, 'W' water, 'R' cave wall (solid), 'C' cave entrance, 'M' mine entrance
        self.tiles: Optional[List[str]] = None
        # resources indexed by (x,y) -> {"type": "tree", "hp": int}
        self.resources: Dict[Tuple[int, int], dict] = {}
        # Cave entrance position (set during gen)
        self.cave_entrance: Tuple[int, int] = (WORLD_W - 8, WORLD_H // 2)
        # Mine entrance position (set during gen)
        self.mine_entrance: Tuple[int, int] = (WORLD_W - 10, WORLD_H // 2)
        # NPCs
        self.npcs: Dict[int, dict] = {}
        self._next_npc_id = 1
        # Spell requirements catalog (expandable)
        self.spell_requirements: Dict[str, dict] = {
            "fireball": {"type": "consume_item", "item": "Firestarter Orb"}
        }
        # Ephemeral per-tick chat buffer (list of {pid,name,text})
        self._chat_buffer = []

    # -------------------- World generation --------------------
    def ensure_map(self):
        """Ensure the world map exists. Generate it once and keep it stable.
        Regenerating every tick caused server-side obstacles to shift, which
        felt like invisible walls to clients between snapshots.
        """
        if self.tiles is None:
            self._generate_forest_map()
            # Place NPCs after initial map gen
            try:
                self.ensure_initial_npcs()
            except Exception:
                pass

    def _generate_forest_map(self):
        import random, math
        # Base grass everywhere
        grid = [['G' for _ in range(WORLD_W)] for _ in range(WORLD_H)]
        # Big pond: ellipse near center-left
        cx, cy = WORLD_W // 2 - 6, WORLD_H // 2
        rx, ry = WORLD_W // 4, WORLD_H // 3
        for y in range(WORLD_H):
            for x in range(WORLD_W):
                # ellipse equation (x-cx)^2/rx^2 + (y-cy)^2/ry^2 <= 1
                dx = (x - cx) / max(1, rx)
                dy = (y - cy) / max(1, ry)
                if dx * dx + dy * dy <= 1.0:
                    grid[y][x] = 'W'
        # Keep spawn area clear (center radius 2)
        sx, sy = WORLD_W // 2, WORLD_H // 2
        for y in range(max(0, sy - 2), min(WORLD_H, sy + 3)):
            for x in range(max(0, sx - 2), min(WORLD_W, sx + 3)):
                grid[y][x] = 'G'
        
        # Add a small bridge to connect the island to the mainland
        # Create a 2-tile wide horizontal bridge from the island eastward
        bridge_y = sy  # Bridge at spawn level
        bridge_start_x = sx + 3  # Start just outside spawn area
        bridge_end_x = min(WORLD_W - 1, sx + 8)  # Extend to mainland
        for x in range(bridge_start_x, bridge_end_x + 1):
            grid[bridge_y][x] = 'G'  # Main bridge path
            if bridge_y > 0:
                grid[bridge_y - 1][x] = 'G'  # Make bridge 2 tiles wide for easier navigation
        # Scatter trees (no rocks in forest), denser toward edges
        self.resources.clear()
        for y in range(WORLD_H):
            for x in range(WORLD_W):
                if grid[y][x] != 'G':
                    continue
                # Avoid very center area (radius 3) for initial breathing room
                if abs(x - sx) + abs(y - sy) <= 3:
                    continue
                # Higher chance near edges
                edge_factor = max(
                    x, y, WORLD_W - 1 - x, WORLD_H - 1 - y
                ) / max(WORLD_W, WORLD_H)
                # Lower overall density of trees; no rocks in forest
                base_p = 0.04 + 0.08 * edge_factor
                if random.random() < base_p:
                    # tree only in forest
                    self.resources[(x, y)] = {"type": "tree", "hp": 3}

        # Place a single cave entrance 'C' on a reachable grass tile near the east side.
        # Scan leftwards from the right edge along center row until we find grass.
        ey = WORLD_H // 2
        ex = None
        for x in range(WORLD_W - 4, 3, -1):
            if grid[ey][x] == 'G':
                ex = x
                break
        # Fallback to a reasonable location if scan fails
        if ex is None:
            ex = max(3, WORLD_W - 8)
        grid[ey][ex] = 'C'
        self.cave_entrance = (ex, ey)
        # Ensure the entrance tile has no blocking resource
        self.resources.pop((ex, ey), None)
        
        # Place a mine entrance 'M' near the cave entrance (to the left)
        mine_x = max(0, ex - 2)
        mine_y = ey
        # Make sure the mine entrance is on walkable ground
        if mine_x >= 0 and mine_y >= 0:
            grid[mine_y][mine_x] = 'M'
            self.mine_entrance = (mine_x, mine_y)
            # Ensure the mine entrance tile has no blocking resource
            self.resources.pop((mine_x, mine_y), None)

        # Guarantee a clear 3-tile-wide corridor from spawn to the cave entrance along the center row
        sx, sy = WORLD_W // 2, WORLD_H // 2
        x0, x1 = sorted([sx, ex])
        for x in range(x0, x1 + 1):
            for yy in range(max(0, ey - 1), min(WORLD_H, ey + 2)):
                grid[yy][x] = 'G'
                self.resources.pop((x, yy), None)
        # Save tiles as strings
        self.tiles = [''.join(row) for row in grid]

    def ensure_player(self, user_id: int) -> int:
        # Ensure the map is generated before placing the player
        self.ensure_map()
        # Return existing or create new at spawn
        for pid, p in self.players.items():
            if p.user_id == user_id:
                return pid
        pid = self._next_player_id
        self._next_player_id += 1
        # Find a free spawn near map center
        sx, sy = WORLD_W // 2, WORLD_H // 2
        x, y = self.find_free_near(sx, sy)
        player = Player(id=pid, user_id=user_id, x=x, y=y, xp={})
        self.players[pid] = player
        # Grant starter spell to new players
        self.grant_starter_spell(pid)
        return pid

    # -------------------- NPCs --------------------
    def ensure_initial_npcs(self):
        """Create static NPCs if not present."""
        if self.npcs:
            return
        # NPC 1: Sergeant on the mainland just east of the lake/bridge, outside the water
        sx, sy = WORLD_W // 2, WORLD_H // 2
        # Scan a small band to the east of spawn along the bridge rows (sy and sy-1)
        serg_pos = None
        for x in range(min(WORLD_W - 2, sx + 12), sx + 5, -1):
            for y in (sy, max(0, sy - 1)):
                if self.is_walkable(x, y) and not self.is_occupied_by_resources(x, y):
                    serg_pos = (x, y)
                    break
            if serg_pos:
                break
        if not serg_pos:
            # Fallback: first free near the end of the bridge area
            serg_pos = self.find_free_near(sx + 8, sy)
        nx1, ny1 = serg_pos
        nid1 = self._next_npc_id; self._next_npc_id += 1
        self.npcs[nid1] = {
            "id": nid1,
            "name": "Sergeant",
            "type": "quest_giver",
            "x": nx1, "y": ny1,
        }
        # NPC 2: Cave Girl near cave entrance (just inside)
        ex, ey = self.cave_entrance
        cand2 = [(ex + 2, ey), (ex + 1, ey - 1), (ex + 1, ey + 1)]
        nx2, ny2 = next(((x, y) for (x, y) in cand2 if self.is_walkable(x, y)), (ex + 2, ey))
        nid2 = self._next_npc_id; self._next_npc_id += 1
        self.npcs[nid2] = {
            "id": nid2,
            "name": "Cave Girl",
            "type": "quest_giver",
            "x": nx2, "y": ny2,
        }
        
        # NPC 3: Mine Girl near cave entrance (to the left of Cave Girl)
        # Position her next to the cave entrance but not blocking it
        cand3 = [(ex - 1, ey), (ex - 2, ey), (ex - 1, ey - 1), (ex - 1, ey + 1)]
        nx3, ny3 = next(((x, y) for (x, y) in cand3 if self.is_walkable(x, y)), (ex - 2, ey))
        nid3 = self._next_npc_id; self._next_npc_id += 1
        self.npcs[nid3] = {
            "id": nid3,
            "name": "Mine Girl",
            "type": "quest_giver",
            "x": nx3, "y": ny3,
        }

    def load_player_xp(self, player_id: int, db: Session):
        """Load player XP from database."""
        from ..models import User
        player = self.players.get(player_id)
        if not player:
            return
        
        user = db.query(User).filter(User.id == player.user_id).first()
        if user:
            player.xp = user.get_class_xp()

    def save_player_xp(self, player_id: int, db: Session):
        """Save player XP to database."""
        from ..models import User
        player = self.players.get(player_id)
        if not player:
            return
        
        user = db.query(User).filter(User.id == player.user_id).first()
        if user:
            user.set_class_xp(player.xp)
            db.commit()

    def save_all_player_xp(self, db: Session):
        """Save XP for all players to database."""
        for player_id in self.players:
            self.save_player_xp(player_id, db)

    def is_walkable(self, x: int, y: int) -> bool:
        if not (0 <= x < WORLD_W and 0 <= y < WORLD_H):
            return False
        t = self.tiles[y][x] if self.tiles else 'G'
        # Only water 'W' is unwalkable in the forest; treat any legacy 'R' as walkable
        if t == 'W':
            return False
        # 'C' is a cave entrance tile, walkable; 'M' is a mine entrance tile, walkable; 'G' is grass, walkable; treat everything else as walkable too
        return True

    def is_occupied_by_players(self, x: int, y: int) -> bool:
        return any(p.x == x and p.y == y for p in self.players.values())

    def is_occupied_by_monsters(self, x: int, y: int) -> bool:
        return any(m.x == x and m.y == y for m in self.monsters.values())

    def is_occupied_by_resources(self, x: int, y: int) -> bool:
        return (x, y) in self.resources

    def is_free(self, x: int, y: int) -> bool:
        """Tile is in bounds and not occupied by any unit or blocking resource."""
        return (
            self.is_walkable(x, y)
            and not self.is_occupied_by_resources(x, y)
            and not self.is_occupied_by_players(x, y)
            and not self.is_occupied_by_monsters(x, y)
        )

    def find_free_near(self, sx: int, sy: int, max_radius: int = 10) -> Tuple[int, int]:
        """Find the first free tile near the given position within a radius."""
        if self.is_free(sx, sy):
            return sx, sy
        for r in range(1, max_radius + 1):
            for dx in range(-r, r + 1):
                for dy in range(-r, r + 1):
                    x, y = sx + dx, sy + dy
                    if self.is_free(x, y):
                        return x, y
        # Fallback to clamped position
        sx = max(0, min(WORLD_W - 1, sx))
        sy = max(0, min(WORLD_H - 1, sy))
        return sx, sy

    def add_damage_number(self, x: int, y: int, damage: int, ttl: int = 60):
        """Add a floating damage number at the given position. Only adds if no damage was dealt this tick at this position."""
        pos = (x, y)
        
        # If we already dealt damage at this position this tick, accumulate it instead of creating duplicate
        if pos in self._damage_this_tick:
            self._damage_this_tick[pos] += damage
            # Update the existing damage number with the new total
            if pos in self.damage_numbers and self.damage_numbers[pos]:
                # Update the most recent damage number (highest ttl)
                most_recent_idx = 0
                highest_ttl = 0
                for i, (dmg, curr_ttl) in enumerate(self.damage_numbers[pos]):
                    if curr_ttl > highest_ttl:
                        highest_ttl = curr_ttl
                        most_recent_idx = i
                # Update the damage amount
                old_damage, old_ttl = self.damage_numbers[pos][most_recent_idx]
                self.damage_numbers[pos][most_recent_idx] = (self._damage_this_tick[pos], old_ttl)
            return
        
        # First damage at this position this tick
        self._damage_this_tick[pos] = damage
        if pos not in self.damage_numbers:
            self.damage_numbers[pos] = []
        self.damage_numbers[pos].append((damage, ttl))

    def clear_tick_damage_tracking(self):
        """Clear the damage tracking for this tick. Call this at the start of each tick."""
        self._damage_this_tick.clear()

    def update_damage_numbers(self):
        """Update damage number TTLs and remove expired ones."""
        expired_positions = []
        for pos, numbers in self.damage_numbers.items():
            # Decrement TTL for each number
            updated_numbers = []
            for damage, ttl in numbers:
                if ttl > 0:
                    updated_numbers.append((damage, ttl - 1))
            if updated_numbers:
                self.damage_numbers[pos] = updated_numbers
            else:
                expired_positions.append(pos)
        # Remove positions with no numbers left
        for pos in expired_positions:
            del self.damage_numbers[pos]

    def update_pending_spells(self):
        """Update pending spells and resolve any that are ready."""
        resolved_spells = []
        remaining_spells = []
        
        for spell in self.pending_spells:
            spell.ticks_remaining -= 1
            if spell.ticks_remaining <= 0:
                resolved_spells.append(spell)
            else:
                remaining_spells.append(spell)
        
        self.pending_spells = remaining_spells
        return resolved_spells

    def add_pending_spell(self, caster_id: int, spell_name: str, target_x: int, target_y: int, 
                         cast_range: int, cast_radius: int, delay_ticks: int = 1):
        """Add a spell to be resolved after a delay (for dodge mechanics)."""
        caster = self.players.get(caster_id)
        if not caster:
            return False
            
        spell = PendingSpell(
            caster_id=caster_id,
            spell_name=spell_name,
            target_x=target_x,
            target_y=target_y,
            cast_range=cast_range,
            cast_radius=cast_radius,
            ticks_remaining=delay_ticks,
            original_caster_pos=(caster.x, caster.y)
        )
        self.pending_spells.append(spell)
        return True

    def spawn_projectile(self, caster_id: int, x: int, y: int, dx: int, dy: int, speed: int, ttl: int, dmg: int = 10) -> int:
        pid = self._next_projectile_id
        self._next_projectile_id += 1
        self.projectiles[pid] = Projectile(
            id=pid, caster_id=caster_id, x=x, y=y, dx=dx, dy=dy,
            speed=speed, ttl=ttl, dmg=dmg, just_spawned=True
        )
        return pid

    def snapshot(self, now: Optional[float] = None):
        snap = {
            "world": {"w": WORLD_W, "h": WORLD_H},
            "tiles": self.tiles or [],
            "players": {
                pid: {
                    "x": p.x,
                    "y": p.y,
                    "class": None,
                    "hp": p.hp,
                    "hpMax": p.hp_max,
                    "mp": p.mp,
                    "mpMax": p.mp_max,
                    "xp": 0,
                    # lightweight lists for UI
                    "inventory": {k: v for k, v in (p.inventory or {}).items() if v > 0},
                    "spellsKnown": list((p.spells or {}).keys()),
                    # Include quest status and progress data for client UI
                    "quests": {
                        qid: {
                            "status": (q.get("status") if isinstance(q, dict) else q),
                            "data": (q.get("data", {}) if isinstance(q, dict) else {})
                        }
                        for qid, q in (p.quests or {}).items()
                    },
                    "notifications": [text for (text, ttl) in (p.notifications or []) if ttl > 0],
                    # Expose lightweight casting/cooldown info for client UX
                    "casting": (
                        {
                            "spell": p.casting.get("spell"),
                            "x": p.casting.get("target", (p.x, p.y))[0],
                            "y": p.casting.get("target", (p.x, p.y))[1],
                            "timeLeft": max(0.0, (p.casting.get("end", 0) - (now or 0)))
                        }
                        if getattr(p, 'casting', None) else None
                    ),
                    "cooldowns": (
                        {k: max(0.0, (v - (now or 0))) for k, v in (p.cooldowns or {}).items()}
                        if now is not None else {}
                    ),
                }
                for pid, p in self.players.items()
            },
            "npcs": [
                {"id": n["id"], "name": n.get("name"), "type": n.get("type"), "x": n.get("x"), "y": n.get("y")}
                for n in self.npcs.values()
            ],
            "monsters": [
                {"id": m.id, "type": m.kind, "name": m.kind.capitalize(), "x": m.x, "y": m.y, "hp": m.hp, "hpMax": m.hp_max, "aggro": m.aggro}
                for m in self.monsters.values()
            ],
            "resources": [
                {"x": x, "y": y, "type": r.get("type"), "hp": r.get("hp", 1)}
                for (x, y), r in self.resources.items()
            ],
            "effects": [ {"x": x, "y": y} for (x, y), _val in self.effects.items() ],
            "projectiles": [
                {"id": pr.id, "x": pr.x, "y": pr.y, "dx": pr.dx, "dy": pr.dy, "caster": pr.caster_id}
                for pr in self.projectiles.values()
            ],
            "pendingSpells": [
                {"caster": s.caster_id, "spell": s.spell_name, "x": s.target_x, "y": s.target_y, "radius": s.cast_radius, "ticksRemaining": s.ticks_remaining}
                for s in self.pending_spells
            ],
            "damageNumbers": [
                {"x": x, "y": y, "numbers": [{"damage": d, "ttl": t} for d, t in numbers]}
                for (x, y), numbers in self.damage_numbers.items()
            ],
            # Expose cave entrance marker so client can draw it differently
            "cave": {"hasCave": True, "entrance": {"x": self.cave_entrance[0], "y": self.cave_entrance[1]}}
        }
        # Include chat if any for this tick, then clear buffer
        if self._chat_buffer:
            snap["chat"] = list(self._chat_buffer)
            self._chat_buffer.clear()
        return snap

    def enforce_no_overlap(self):
        """Ensure no monster occupies the same tile as any player.
        If overlap is found (e.g., due to legacy state), relocate the monster to the nearest free tile.
        """
        player_tiles = {(p.x, p.y) for p in self.players.values()}
        if not player_tiles:
            return
        for m in list(self.monsters.values()):
            if (m.x, m.y) in player_tiles:
                nx, ny = self.find_free_near(m.x, m.y)
                m.x, m.y = nx, ny

    # Monster helpers
    def spawn_slime(self, x: int, y: int):
        mid = self._next_monster_id
        self._next_monster_id += 1
        hp = 9  # dies in 3 punch hits (3 dmg each)
        # Avoid spawning on occupied tiles when possible
        fx, fy = (x, y)
        if not self.is_free(x, y):
            fx, fy = self.find_free_near(x, y)
        self.monsters[mid] = Monster(
            id=mid, kind="slime", x=fx, y=fy, hp=hp, hp_max=hp,
            dmg=6, speed=2, spawn_x=x, spawn_y=y, roam_radius=3
        )
        return mid

    def spawn_bat(self, x: int, y: int):
        mid = self._next_monster_id
        self._next_monster_id += 1
        hp = 40  # twice slime
        fx, fy = (x, y)
        if not self.is_free(x, y):
            fx, fy = self.find_free_near(x, y)
        self.monsters[mid] = Monster(
            id=mid, kind="bat", x=fx, y=fy, hp=hp, hp_max=hp,
            dmg=12, speed=3, xp_reward=10, aggro=True, spawn_x=x, spawn_y=y, roam_radius=5
        )
        return mid

    def spawn_dummy(self, x: int, y: int):
        """Spawn a stationary training dummy that never moves or attacks.
        High HP so it can be used to test spells repeatedly.
        """
        mid = self._next_monster_id
        self._next_monster_id += 1
        fx, fy = (x, y)
        if not self.is_free(x, y):
            fx, fy = self.find_free_near(x, y)
        hp = 9999
        self.monsters[mid] = Monster(
            id=mid,
            kind="dummy",
            x=fx,
            y=fy,
            hp=hp,
            hp_max=hp,
            dmg=0,
            speed=0,
            xp_reward=0,
            aggro=False,
            spawn_x=fx,
            spawn_y=fy,
            roam_radius=0,
        )
        return mid

    def ensure_initial_monsters(self):
        if self.monsters:
            return
        # Always ensure a stationary training dummy exists near spawn for testing
        has_dummy = any(m.kind == "dummy" for m in self.monsters.values()) if self.monsters else False
        if not has_dummy:
            cx, cy = WORLD_W // 2, WORLD_H // 2
            # Prefer a tile to the right of spawn; fallback to any free nearby tile
            dx, dy = cx + 1, cy
            if not self.is_free(dx, dy):
                dx, dy = self.find_free_near(cx, cy)
            self.spawn_dummy(dx, dy)

        # Count non-dummy monsters; if any exist, avoid re-populating
        non_dummy_count = sum(1 for m in self.monsters.values() if m.kind != "dummy")
        if non_dummy_count > 0:
            return
        # First-run population (no non-dummy monsters yet): spawn slimes and bats
        cx, cy = WORLD_W // 2, WORLD_H // 2
        offsets = [(0, 0), (2, 0), (-2, 0), (0, 2), (0, -2)]
        for dx, dy in offsets:
            self.spawn_slime(cx + dx, cy + dy)
        # Spawn bats in the cave area near entrance
        ex, ey = self.cave_entrance
        bat_spawns = [(ex + 4, ey), (ex + 8, ey - 3), (ex + 8, ey + 3), (ex + 12, ey)]
        for bx, by in bat_spawns:
            if 0 <= bx < WORLD_W and 0 <= by < WORLD_H:
                self.spawn_bat(bx, by)

    # -------------------- Gathering --------------------
    def gather_adjacent(self, player_id: int) -> Optional[str]:
        """Attempt to gather from a resource on the player's tile or adjacent (N/E/S/W).
        Returns the resource type gathered (e.g., 'tree' or 'rock') if successful, else None."""
        p = self.players.get(player_id)
        if not p:
            return None
        positions = [(p.x, p.y), (p.x+1, p.y), (p.x-1, p.y), (p.x, p.y+1), (p.x, p.y-1)]
        for pos in positions:
            r = self.resources.get(pos)
            if not r:
                continue
            r_type = str(r.get("type", ""))
            # Damage resource
            r_hp = int(r.get("hp", 1))
            r_hp -= 1
            if r_hp <= 0:
                # Remove resource when depleted
                del self.resources[pos]
            else:
                r["hp"] = r_hp
            # Optional: floating number to indicate gather (small green could be client-implemented later)
            return r_type or None
        return None

    # -------------------- Notifications --------------------
    def add_notification(self, player_id: int, text: str, ttl: int = 20):
        p = self.players.get(player_id)
        if not p:
            return
        p.notifications.append((text, ttl))

    def update_notifications(self):
        for p in self.players.values():
            if not p.notifications:
                continue
            updated: List[Tuple[str, int]] = []
            for text, ttl in p.notifications:
                if ttl > 1:
                    updated.append((text, ttl - 1))
            p.notifications = updated

    # -------------------- Spells & Items --------------------
    def unlock_spell_if_requirement_met(self, player_id: int, spell_name: str):
        """Check if the player meets the requirement for the spell and unlock it."""
        p = self.players.get(player_id)
        if not p:
            return False
        if spell_name in p.spells:
            return True
        req = self.spell_requirements.get(spell_name)
        if not req:
            return False
        # Currently only supports consume_item, which is handled on use
        return False

    def consume_item(self, player_id: int, item_name: str, amount: int = 1) -> bool:
        p = self.players.get(player_id)
        if not p:
            return False
        have = p.inventory.get(item_name, 0)
        if have < amount:
            return False
        new_val = have - amount
        if new_val > 0:
            p.inventory[item_name] = new_val
        else:
            p.inventory.pop(item_name, None)
        return True

    def grant_item(self, player_id: int, item_name: str, amount: int = 1):
        p = self.players.get(player_id)
        if not p:
            return
        p.inventory[item_name] = p.inventory.get(item_name, 0) + amount

    def unlock_spell(self, player_id: int, spell_name: str):
        p = self.players.get(player_id)
        if not p:
            return False
        if spell_name in p.spells:
            return True
        # Define known spell specs here
        if spell_name == "fireball":
            p.spells["fireball"] = {"name": "Fireball", "range": 3, "radius": 0, "cooldown": 2.0, "castTime": 1.0}
            return True
        elif spell_name == "punch":
            p.spells["punch"] = {"name": "Punch", "range": 1, "radius": 0, "cooldown": 1.0, "castTime": 0.5}
            return True
        return False

    def grant_starter_spell(self, player_id: int):
        """Grant the punch spell to new players as a starter spell."""
        p = self.players.get(player_id)
        if not p:
            return
        # Always grant punch as starter spell
        if "punch" not in p.spells:
            self.unlock_spell(player_id, "punch")
