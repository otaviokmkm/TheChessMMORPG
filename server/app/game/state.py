from __future__ import annotations
from dataclasses import dataclass, field
from typing import Dict, Tuple, Optional, Iterable, List
from sqlalchemy.orm import Session

WORLD_W = 40
WORLD_H = 30

@dataclass
class Player:
    id: int
    user_id: int
    x: int
    y: int
    # Experience per class (future-proof)
    xp: Dict[str, int] = field(default_factory=dict)
    clazz: Optional[str] = None
    # Known spells by id/name
    spells: Dict[str, dict] = field(default_factory=dict)
    # Vital stats
    hp: int = 10
    hp_max: int = 10
    mp: int = 0
    mp_max: int = 0

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

class GameState:
    def __init__(self):
        # Players and identifiers
        self.players: Dict[int, Player] = {}
        self._next_player_id: int = 1
        # simple AoE effects map: {(x,y): (ttl, source_pid)}
        self.effects: Dict[Tuple[int, int], tuple] = {}
        # Monsters
        self.monsters: Dict[int, Monster] = {}
        self._next_monster_id: int = 1
        # Floating damage numbers: {(x, y): [(damage, ttl), ...]}
        self.damage_numbers: Dict[Tuple[int, int], list] = {}
        # Pending spells (for dodge mechanics)
        self.pending_spells: list[PendingSpell] = []
        # Track damage dealt this tick to prevent duplicate numbers
        self._damage_this_tick: Dict[Tuple[int, int], int] = {}
        # Tile map and resources
        # tiles: list of strings with characters: 'G' (grass), 'W' (water)
        self.tiles: Optional[List[str]] = None
        # resources indexed by (x,y) -> {"type": "tree"|"rock", "hp": int}
        self.resources: Dict[Tuple[int, int], Dict[str, int | str]] = {}

    # -------------------- World generation --------------------
    def ensure_map(self):
        if self.tiles is None:
            self._generate_forest_map()

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
        # Scatter trees and rocks over grass tiles, denser toward edges
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
                base_p = 0.08 + 0.12 * edge_factor
                if random.random() < base_p:
                    if random.random() < 0.7:
                        # tree
                        self.resources[(x, y)] = {"type": "tree", "hp": 3}
                    else:
                        # rock
                        self.resources[(x, y)] = {"type": "rock", "hp": 4}
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
        self.players[pid] = Player(id=pid, user_id=user_id, x=x, y=y, xp={})
        return pid

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
        # Water is not walkable
        if self.tiles is not None and self.tiles[y][x] == 'W':
            return False
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

    def snapshot(self):
        return {
            "world": {"w": WORLD_W, "h": WORLD_H},
            "tiles": self.tiles or [],
            "players": {
                pid: {
                    "x": p.x,
                    "y": p.y,
                    "class": p.clazz,
                    "hp": p.hp,
                    "hpMax": p.hp_max,
                    "mp": p.mp,
                    "mpMax": p.mp_max,
                    "xp": (p.xp.get(p.clazz, 0) if p.clazz else 0),
                }
                for pid, p in self.players.items()
            },
            "monsters": [
                {"id": m.id, "type": m.kind, "name": m.kind.capitalize(), "x": m.x, "y": m.y, "hp": m.hp, "hpMax": m.hp_max, "aggro": m.aggro}
                for m in self.monsters.values()
            ],
            "resources": [
                {"x": x, "y": y, "type": r.get("type"), "hp": r.get("hp", 1)}
                for (x, y), r in self.resources.items()
            ],
            "effects": [ {"x": x, "y": y} for (x, y), _val in self.effects.items() ],
            "pendingSpells": [
                {"caster": s.caster_id, "spell": s.spell_name, "x": s.target_x, "y": s.target_y, "radius": s.cast_radius, "ticksRemaining": s.ticks_remaining}
                for s in self.pending_spells
            ],
            "damageNumbers": [
                {"x": x, "y": y, "numbers": [{"damage": d, "ttl": t} for d, t in numbers]}
                for (x, y), numbers in self.damage_numbers.items()
            ],
        }

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
        hp = 20  # ~2 fireballs at 10 dmg each
        # Avoid spawning on occupied tiles when possible
        fx, fy = (x, y)
        if not self.is_free(x, y):
            fx, fy = self.find_free_near(x, y)
        self.monsters[mid] = Monster(
            id=mid, kind="slime", x=fx, y=fy, hp=hp, hp_max=hp, 
            dmg=6, speed=2, spawn_x=x, spawn_y=y, roam_radius=3
        )
        return mid

    def ensure_initial_monsters(self):
        if self.monsters:
            return
        # Spawn slimes around the map center
        cx, cy = WORLD_W // 2, WORLD_H // 2
        offsets = [(0, 0), (2, 0), (-2, 0), (0, 2), (0, -2)]
        for dx, dy in offsets:
            self.spawn_slime(cx + dx, cy + dy)

    # -------------------- Gathering --------------------
    def gather_adjacent(self, player_id: int) -> bool:
        """Attempt to gather from a resource on the player's tile or adjacent (N/E/S/W).
        Returns True if any resource was gathered (damaged or removed)."""
        p = self.players.get(player_id)
        if not p:
            return False
        positions = [(p.x, p.y), (p.x+1, p.y), (p.x-1, p.y), (p.x, p.y+1), (p.x, p.y-1)]
        for pos in positions:
            r = self.resources.get(pos)
            if not r:
                continue
            # Damage resource
            r_hp = int(r.get("hp", 1))
            r_hp -= 1
            if r_hp <= 0:
                # Remove resource when depleted
                del self.resources[pos]
            else:
                r["hp"] = r_hp
            # Optional: floating number to indicate gather (small green could be client-implemented later)
            return True
        return False
