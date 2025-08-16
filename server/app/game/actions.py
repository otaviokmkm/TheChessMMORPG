from __future__ import annotations
from typing import Dict, Tuple
from .state import GameState, Player

# Simultaneous resolution: collect desired destinations and apply if walkable

def resolve_actions(state: GameState, actions: Dict[int, dict]):
    wants_move: Dict[int, Tuple[int,int]] = {}
    casts: Dict[int, dict] = {}
    class_select: Dict[int, str] = {}

    # First pass: collect intents (no move+cast same tick; casting wins if both queued)
    for pid, msg in actions.items():
        t = msg.get("type")
        payload = msg.get("payload") or {}
        p = state.players.get(pid)
        if not p:
            continue
        if t == "choose_class":
            clazz = payload.get("class")
            if clazz in ("mage",):
                class_select[pid] = clazz
        elif t == "cast":
            casts[pid] = payload
        elif t == "move":
            # only accept move if no cast queued for this pid
            if pid not in casts:
                dx = int(payload.get("dx", 0))
                dy = int(payload.get("dy", 0))
                nx = p.x + dx
                ny = p.y + dy
                if state.is_walkable(nx, ny):
                    wants_move[pid] = (nx, ny)
        elif t == "rest":
            pass
        elif t == "talk":
            pass

    # Apply class selections
    for pid, clazz in class_select.items():
        pl = state.players.get(pid)
        if pl:
            pl.clazz = clazz
            # grant starter kit
            if clazz == "mage":
                pl.spells.setdefault("fireball", {"name": "Fireball", "range": 4, "radius": 1})

    # Apply moves simultaneously
    for pid, dest in wants_move.items():
        pl = state.players.get(pid)
        if pl:
            pl.x, pl.y = dest

    # Resolve casts after movement (so range uses final positions)
    for pid, c in casts.items():
        pl = state.players.get(pid)
        if not pl:
            continue
        sname = c.get("spell")
        tx = int(c.get("tx", pl.x))
        ty = int(c.get("ty", pl.y))
        if sname == "fireball" and pl.spells.get("fireball"):
            spec = pl.spells["fireball"]
            rng = int(spec.get("range", 4))
            rad = int(spec.get("radius", 1))
            # in range check (manhattan)
            if abs(tx - pl.x) + abs(ty - pl.y) <= rng and state.is_walkable(tx, ty):
                # mark effect tiles for one tick (simple visual only)
                for dx in range(-rad, rad+1):
                    for dy in range(-rad, rad+1):
                        if abs(dx) + abs(dy) <= rad:
                            ex, ey = tx + dx, ty + dy
                            if state.is_walkable(ex, ey):
                                state.effects[(ex, ey)] = 1  # expire next tick

    # Decay effects
    expired = []
    for k in list(state.effects.keys()):
        state.effects[k] -= 1
        if state.effects[k] <= 0:
            expired.append(k)
    for k in expired:
        state.effects.pop(k, None)
