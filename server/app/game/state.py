from __future__ import annotations
from dataclasses import dataclass, field
from typing import Dict, Tuple, Optional

WORLD_W = 20
WORLD_H = 20

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

class GameState:
    def __init__(self):
        self.players: Dict[int, Player] = {}
        self._next_player_id = 1
        # simple AoE effects map: {(x,y): expire_tick}
        self.effects: Dict[Tuple[int,int], int] = {}

    def ensure_player(self, user_id: int) -> int:
        # Return existing or create new at spawn
        for pid, p in self.players.items():
            if p.user_id == user_id:
                return pid
        pid = self._next_player_id
        self._next_player_id += 1
        self.players[pid] = Player(id=pid, user_id=user_id, x=1, y=1, xp={})
        return pid

    def is_walkable(self, x: int, y: int) -> bool:
        return 0 <= x < WORLD_W and 0 <= y < WORLD_H

    def snapshot(self):
        return {
            "world": {"w": WORLD_W, "h": WORLD_H},
            "players": {pid: {"x": p.x, "y": p.y, "class": p.clazz} for pid, p in self.players.items()},
            "effects": [ {"x": x, "y": y} for (x,y), _tick in self.effects.items() ],
        }
