from __future__ import annotations
from typing import Dict, Tuple
from .state import GameState, Player

# Simultaneous resolution: collect desired destinations and apply if walkable

def resolve_actions(state: GameState, actions: Dict[int, dict]):
    wants_move: Dict[int, Tuple[int,int]] = {}
    casts: Dict[int, dict] = {}
    class_select: Dict[int, str] = {}
    gathers: Dict[int, bool] = {}

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
                # enforce tile is free (no players or monsters)
                if state.is_free(nx, ny):
                    wants_move[pid] = (nx, ny)
        elif t == "gather":
            # queue gather if not casting (casting overrides)
            if pid not in casts:
                gathers[pid] = True
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
                # Mage base stats
                pl.hp_max = 12
                pl.hp = min(pl.hp, pl.hp_max) if pl.hp else pl.hp_max
                pl.mp_max = 30
                pl.mp = pl.mp_max

    # Apply moves simultaneously (players who cast this tick do not move)
    # Resolve collisions so no two players end up on the same tile.
    # Build dest -> [pids] for those not casting.
    dest_to_pids: Dict[Tuple[int, int], list] = {}
    for pid, dest in wants_move.items():
        if pid in casts:
            continue
        dest_to_pids.setdefault(dest, []).append(pid)

    # For each destination, pick a winner deterministically (lowest pid) and move only if tile still free.
    for dest, pids in dest_to_pids.items():
        winner = min(pids)
        x, y = dest
        # Ensure destination is still free at the moment of applying moves (prevents moving onto monsters)
        if not state.is_free(x, y):
            continue
        pl = state.players.get(winner)
        if pl:
            pl.x, pl.y = x, y

    # Resolve gather before casts (instant, local)
    for pid in gathers.keys():
        if pid in casts:
            continue
        state.gather_adjacent(pid)

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
            mana_cost = 5
            # in range check (manhattan)
            if abs(tx - pl.x) + abs(ty - pl.y) <= rng and state.is_walkable(tx, ty) and pl.mp >= mana_cost:
                print(f"DEBUG: Player {pid} casting fireball at ({tx}, {ty}) with radius {rad}")
                
                # Add spell to pending queue for next tick resolution (allows dodging)
                if state.add_pending_spell(pid, "fireball", tx, ty, rng, rad, delay_ticks=1):
                    # Charge mana immediately upon successful cast (but no XP until monster dies)
                    pl.mp = max(0, pl.mp - mana_cost)
                    print(f"DEBUG: Fireball queued for next tick, mana charged")
                else:
                    print(f"DEBUG: Failed to queue fireball")
            else:
                print(f"DEBUG: Fireball cast failed - range check or mana. Range: {abs(tx - pl.x) + abs(ty - pl.y)} vs {rng}, MP: {pl.mp} vs {mana_cost}")

def resolve_pending_spells(state: GameState):
    """Resolve pending spells with dodge mechanics - targets can avoid damage by moving out of original cast range."""
    resolved_spells = state.update_pending_spells()
    
    for spell in resolved_spells:
        caster = state.players.get(spell.caster_id)
        if not caster:
            continue  # Caster disconnected
            
        if spell.spell_name == "fireball":
            print(f"DEBUG: Resolving fireball from player {spell.caster_id} at ({spell.target_x}, {spell.target_y})")
            
            # Create effect tiles
            effect_count = 0
            for dx in range(-spell.cast_radius, spell.cast_radius + 1):
                for dy in range(-spell.cast_radius, spell.cast_radius + 1):
                    if abs(dx) + abs(dy) <= spell.cast_radius:
                        ex, ey = spell.target_x + dx, spell.target_y + dy
                        if state.is_walkable(ex, ey):
                            state.effects[(ex, ey)] = (1, spell.caster_id)  # (ttl, source_pid)
                            effect_count += 1
                            print(f"DEBUG: Added delayed effect at ({ex}, {ey})")
            print(f"DEBUG: Created {effect_count} delayed effect tiles")
            
            # Check if any targets have moved out of the ORIGINAL cast range
            # (This is the dodge mechanic - if they moved far enough from the original caster position, they avoid damage)
            original_caster_x, original_caster_y = spell.original_caster_pos
            
            # Check all units in the effect area and see if they've dodged
            for dx in range(-spell.cast_radius, spell.cast_radius + 1):
                for dy in range(-spell.cast_radius, spell.cast_radius + 1):
                    if abs(dx) + abs(dy) <= spell.cast_radius:
                        check_x, check_y = spell.target_x + dx, spell.target_y + dy
                        
                        # Check players in this tile
                        for player in state.players.values():
                            if player.x == check_x and player.y == check_y:
                                # Calculate if this player would have been in range when spell was originally cast
                                original_range_to_target = abs(check_x - original_caster_x) + abs(check_y - original_caster_y)
                                if original_range_to_target > spell.cast_range:
                                    # Player moved out of original cast range - they dodged!
                                    print(f"DEBUG: Player {player.id} at ({check_x}, {check_y}) dodged fireball by moving out of range!")
                                    # Remove the effect for this tile to prevent damage
                                    if (check_x, check_y) in state.effects:
                                        del state.effects[(check_x, check_y)]
                        
                        # Check monsters in this tile (they can dodge too!)
                        for monster in state.monsters.values():
                            if monster.x == check_x and monster.y == check_y:
                                original_range_to_target = abs(check_x - original_caster_x) + abs(check_y - original_caster_y)
                                if original_range_to_target > spell.cast_range:
                                    print(f"DEBUG: Monster {monster.id} at ({check_x}, {check_y}) dodged fireball by moving out of range!")
                                    if (check_x, check_y) in state.effects:
                                        del state.effects[(check_x, check_y)]

    # NOTE: Effect decay moved to engine._tick() after damage application
