from __future__ import annotations
from typing import Dict, Tuple
from .state import GameState, Player

# Simultaneous resolution: collect desired destinations and apply if walkable

def resolve_actions(state: GameState, actions: Dict[int, dict], now: float):
    wants_move: Dict[int, Tuple[int,int]] = {}
    casts: Dict[int, dict] = {}
    class_select: Dict[int, str] = {}
    gathers: Dict[int, bool] = {}
    talks: Dict[int, dict] = {}
    chats: Dict[int, str] = {}

    # First pass: collect intents (no move+cast same tick; casting wins if both queued)
    for pid, msg in actions.items():
        t = msg.get("type")
        payload = msg.get("payload") or {}
        p = state.players.get(pid)
        if not p:
            continue
        if t == "choose_class":
            # Class system removed; ignore
            continue
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
            talks[pid] = payload
        elif t == "chat":
            txt = str(payload.get("text", "")).strip()
            if txt:
                chats[pid] = txt[:200]

    # Class system removed: no selections to apply

    # Apply moves simultaneously (players who cast this tick do not move)
    # Resolve collisions so no two players end up on the same tile.
    # Build dest -> [pids] for those not casting.
    dest_to_pids: Dict[Tuple[int, int], list] = {}
    for pid, dest in wants_move.items():
        if pid in casts:
            continue
        # Prevent movement if player is channeling/casting
        pl = state.players.get(pid)
        if pl and getattr(pl, 'casting', None):
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
            # Entrance transitions: if stepping onto entrance tiles, teleport to cave map
            try:
                if state.tiles and state.tiles[y][x] in ('C', 'M'):
                    # For both cave entrance and mine entrance, teleport to cave area
                    # Find a suitable location in the cave (for now, use same logic)
                    dx = 0 if x == pl.x else (1 if x > pl.x else -1)
                    dy = 0 if y == pl.y else (1 if y > pl.y else -1)
                    tx, ty = x + dx, y + dy
                    if state.is_free(tx, ty):
                        x, y = tx, ty
            except Exception:
                pass
            pl.x, pl.y = x, y

    # Resolve gather before casts (instant, local)
    for pid in gathers.keys():
        if pid in casts:
            continue
        pl = state.players.get(pid)
        if pl and getattr(pl, 'casting', None):
            continue
        gtype = state.gather_adjacent(pid)
        # Quest: help_sergeant requires some wood and a slime kill; count tree gathers as wood
        if gtype == 'tree':
            q = pl.quests.get("help_sergeant") if pl else None
            if q and q.get("status") == "started":
                data = q.setdefault("data", {})
                data["wood"] = int(data.get("wood", 0)) + 1
                if data.get("wood", 0) >= 5 and not data.get("hinted", False):
                    state.add_notification(pid, "Sergeant: Good. Now defeat a slime to prove yourself.")
                    data["hinted"] = True
                # If the slime was already killed earlier, completing wood now should finish the quest
                if int(data.get("wood", 0)) >= 5 and bool(data.get("slimeKilled")) and q.get("status") != "completed":
                    q["status"] = "completed"
                    state.add_notification(pid, "Quest complete: Help the Sergeant. Talk to him for your reward.")

    # Resolve talks (NPC interactions)
    for pid, payload in talks.items():
        if pid in casts:
            continue
        pl = state.players.get(pid)
        if not pl or getattr(pl, 'casting', None):
            continue
        # Talk requires adjacency or same tile with an NPC
        tx = int(payload.get("x", pl.x))
        ty = int(payload.get("y", pl.y))
        near = abs(pl.x - tx) + abs(pl.y - ty) <= 1
        npc = next((n for n in state.npcs.values() if n.get("x") == tx and n.get("y") == ty), None)
        if npc and near:
            name = (npc.get("name") or "NPC").lower()
            # Tutorial NPC explains spell families and fireball requirement
            if "sergeant" in name:
                # Start or progress quest 'help_sergeant'
                q = pl.quests.get("help_sergeant")
                if not q:
                    pl.quests["help_sergeant"] = {"status": "started", "data": {}}
                    state.add_notification(pid, "Sergeant: Classes are spell families. Any class can learn any spell if you meet its requirement.")
                    state.add_notification(pid, "Sergeant: To learn Fireball, you must consume a Firestarter Orb.")
                else:
                    # If quest complete, grant the orb once
                    if q.get("status") == "completed" and q.get("data", {}).get("orbGranted") != True:
                        state.grant_item(pid, "Firestarter Orb", 1)
                        q.setdefault("data", {})["orbGranted"] = True
                        state.add_notification(pid, "Sergeant gave you a Firestarter Orb! Consume it to learn Fireball.")
            else:
                # Generic talk
                state.add_notification(pid, "You talk with {}.".format(npc.get("name", "someone")))

    # Resolve casts after movement (so range uses final positions)
    for pid, c in casts.items():
        pl = state.players.get(pid)
        if not pl:
            continue
        # Time-based cooldowns and casting gates
        if getattr(pl, 'casting', None):
            # Already casting something: ignore new cast
            continue
        cd_map = getattr(pl, 'cooldowns', None) or {}
        setattr(pl, 'cooldowns', cd_map)
        sname = c.get("spell")
        tx = int(c.get("tx", pl.x))
        ty = int(c.get("ty", pl.y))
        if sname == "punch" and pl.spells.get("punch"):
            spec = pl.spells["punch"]
            rng = int(spec.get("range", 1))  # punch is melee range
            rad = int(spec.get("radius", 0))
            mana_cost = 0  # punch costs no mana
            cast_time = float(spec.get("castTime", 0.5))
            cooldown = float(spec.get("cooldown", 1.0))
            # check cooldown
            next_ok = float(cd_map.get("punch", 0))
            if now < next_ok:
                continue
            # Determine direction for punch (adjacent tile only)
            dir_name = (c.get("dir") or "").lower()
            dirmap = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}
            if dir_name in dirmap:
                pdx, pdy = dirmap[dir_name]
            else:
                ddx = tx - pl.x
                ddy = ty - pl.y
                if abs(ddx) >= abs(ddy):
                    pdx, pdy = (1 if ddx > 0 else -1 if ddx < 0 else 0, 0)
                else:
                    pdx, pdy = (0, 1 if ddy > 0 else -1 if ddy < 0 else 0)
            
            if pdx != 0 or pdy != 0:
                # Enter casting state
                pl.casting = {
                    "spell": "punch",
                    "target": (pdx, pdy),
                    "end": now + cast_time,
                    "rng": rng,
                    "rad": rad,
                    "mana": mana_cost,
                }
                print(f"DEBUG: Player {pid} begins casting Punch ({cast_time}s)")
        elif sname == "fireball" and pl.spells.get("fireball"):
            spec = pl.spells["fireball"]
            rng = int(spec.get("range", 3))
            rad = int(spec.get("radius", 0))
            mana_cost = 5
            cast_time = float(spec.get("castTime", 1.0))
            cooldown = float(spec.get("cooldown", 2.0))
            # check cooldown
            next_ok = float(cd_map.get("fireball", 0))
            if now < next_ok:
                # still on cooldown
                continue
            # We now launch a projectile in a straight line; determine direction either from payload.dir or target
            # Accept dir in {up,down,left,right}; fallback to derive from tx,ty (dominant axis)
            dir_name = (c.get("dir") or "").lower()
            dirmap = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}
            if dir_name in dirmap:
                pdx, pdy = dirmap[dir_name]
            else:
                ddx = tx - pl.x
                ddy = ty - pl.y
                if abs(ddx) >= abs(ddy):
                    pdx, pdy = (1 if ddx > 0 else -1 if ddx < 0 else 0, 0)
                else:
                    pdx, pdy = (0, 1 if ddy > 0 else -1 if ddy < 0 else 0)
            # mana and valid direction check
            if (pdx != 0 or pdy != 0) and pl.mp >= mana_cost:
                # Enter casting state; movement and other actions blocked until finish
                pl.casting = {
                    "spell": "fireball",
                    "target": (pdx, pdy),
                    "end": now + cast_time,
                    "rng": rng,  # reuse as max travel distance in tiles
                    "rad": rad,
                    "mana": mana_cost,
                }
                # Optional: we could broadcast casting via state.snapshot metadata
                print(f"DEBUG: Player {pid} begins casting Fireball ({cast_time}s)")
            else:
                print(f"DEBUG: Fireball cast failed - direction/mana. dir=({pdx},{pdy}), MP: {pl.mp} vs {mana_cost}")
        elif sname == "use_item":
            item = str(c.get("item") or "").strip()
            if not item:
                continue
            # Using Firestarter Orb unlocks Fireball
            if item == "Firestarter Orb":
                # Check requirement: consume item
                if state.consume_item(pid, item, 1):
                    if state.unlock_spell(pid, "fireball"):
                        # If no class selected, don't force class, spells are universal; provide baseline MP if needed
                        if pl.mp_max <= 0:
                            pl.mp_max = 10
                            pl.mp = max(pl.mp, 10)
                        state.add_notification(pid, "You feel a surge of warmth. Fireball learned!")
                    else:
                        # Refund in unlikely case
                        state.grant_item(pid, item, 1)
                else:
                    state.add_notification(pid, "You don't have a Firestarter Orb.")

    # Complete casting for players whose cast time has ended
    for pid, pl in list(state.players.items()):
        cast = getattr(pl, 'casting', None)
        if not cast:
            continue
        if now >= float(cast.get("end", 0)):
            sname = cast.get("spell")
            # For projectile, target stored as direction
            pdx, pdy = cast.get("target", (0, 0))
            rng = int(cast.get("rng", 6))
            mana_cost = int(cast.get("mana", 5))
            # finalize fireball: spawn a straight-line projectile
            if sname == "fireball":
                # Prefer to hit an immediately-adjacent enemy, regardless of chosen direction
                # Check N/E/S/W for a monster first, then other players
                adj_dirs = [(0, -1), (0, 1), (-1, 0), (1, 0)]
                aimed_at_adjacent = False
                try:
                    # Monsters take priority as enemies
                    for ddx, ddy in adj_dirs:
                        ax, ay = pl.x + ddx, pl.y + ddy
                        if any(m.x == ax and m.y == ay for m in state.monsters.values()):
                            pdx, pdy = ddx, ddy
                            aimed_at_adjacent = True
                            break
                    # If no adjacent monster, check for adjacent opposing players (PvP)
                    if not aimed_at_adjacent:
                        for ddx, ddy in adj_dirs:
                            ax, ay = pl.x + ddx, pl.y + ddy
                            if any(pp.id != pid and pp.x == ax and pp.y == ay for pp in state.players.values()):
                                pdx, pdy = ddx, ddy
                                aimed_at_adjacent = True
                                break
                except Exception:
                    pass

                if pdx != 0 or pdy != 0:
                    # Start just in front of the caster (onto the adjacent tile if present)
                    sx, sy = pl.x + pdx, pl.y + pdy
                    # If starting tile is not walkable, cancel
                    if state.is_walkable(sx, sy):
                        # If the start tile already has a monster/player, apply damage immediately (no projectile needed)
                        target_mon = next((m for m in state.monsters.values() if m.x == sx and m.y == sy), None)
                        target_pl = None if target_mon else next((pp for pp in state.players.values() if pp.id != pid and pp.x == sx and pp.y == sy), None)
                        if target_mon or target_pl:
                            dmg = 10
                            if target_mon:
                                target_mon.hp = max(0, target_mon.hp - dmg)
                                target_mon.last_hit_by = pid
                                state.add_damage_number(sx, sy, dmg)
                                print(f"DEBUG: Fireball immediate hit monster {target_mon.id} at ({sx},{sy}) for {dmg}")
                            else:
                                target_pl.hp = max(0, target_pl.hp - dmg)
                                state.add_damage_number(sx, sy, dmg)
                                print(f"DEBUG: Fireball immediate hit player {target_pl.id} at ({sx},{sy}) for {dmg}")
                            # Spend mana and set cooldown
                            pl.mp = max(0, pl.mp - mana_cost)
                            cd_map = getattr(pl, 'cooldowns', None) or {}
                            setattr(pl, 'cooldowns', cd_map)
                            spec = pl.spells.get("fireball", {})
                            cooldown = float(spec.get("cooldown", 2.0))
                            cd_map["fireball"] = now + cooldown
                        else:
                            # Slow the projectile so clients can see it travel across multiple ticks
                            speed = 1  # tiles per tick (was 2)
                            ttl = rng  # max tiles to travel
                            state.spawn_projectile(pid, sx, sy, pdx, pdy, speed, ttl, dmg=10)
                            pl.mp = max(0, pl.mp - mana_cost)
                            cd_map = getattr(pl, 'cooldowns', None) or {}
                            setattr(pl, 'cooldowns', cd_map)
                            spec = pl.spells.get("fireball", {})
                            cooldown = float(spec.get("cooldown", 2.0))
                            cd_map["fireball"] = now + cooldown
                            print(f"DEBUG: Player {pid} launched Fireball projectile; MP now {pl.mp}; CD until {cd_map['fireball']:.2f}")
                    else:
                        print("DEBUG: Fireball start tile blocked; projectile not spawned")
            elif sname == "punch":
                # Punch: Melee attack, hits immediately adjacent target only
                # Check all 8 adjacent tiles for a target
                adj_dirs = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
                target_hit = False
                
                for ddx, ddy in adj_dirs:
                    ax, ay = pl.x + ddx, pl.y + ddy
                    # Try to hit monsters first (priority targets)
                    target_mon = next((m for m in state.monsters.values() if m.x == ax and m.y == ay), None)
                    if target_mon:
                        dmg = 3  # Weak damage - takes 3 hits to kill slime (9 HP)
                        target_mon.hp = max(0, target_mon.hp - dmg)
                        target_mon.last_hit_by = pid
                        state.add_damage_number(ax, ay, dmg)
                        # Use Monster.kind (field name) for message
                        try:
                            mon_name = getattr(target_mon, 'kind', 'enemy')
                        except Exception:
                            mon_name = 'enemy'
                        state.add_notification(pid, f"You punch the {mon_name} for {dmg} damage!")
                        target_hit = True
                        print(f"DEBUG: Player {pid} punched monster {target_mon.id} for {dmg} damage")
                        break
                
                if not target_hit:
                    # Check for other players (PvP)
                    for ddx, ddy in adj_dirs:
                        ax, ay = pl.x + ddx, pl.y + ddy
                        target_pl = next((pp for pp in state.players.values() if pp.id != pid and pp.x == ax and pp.y == ay), None)
                        if target_pl:
                            dmg = 3
                            target_pl.hp = max(0, target_pl.hp - dmg)
                            state.add_damage_number(ax, ay, dmg)
                            state.add_notification(pid, f"You punch {target_pl.name} for {dmg} damage!")
                            state.add_notification(target_pl.id, f"{pl.name} punches you for {dmg} damage!")
                            target_hit = True
                            print(f"DEBUG: Player {pid} punched player {target_pl.id} for {dmg} damage")
                            break
                
                if not target_hit:
                    state.add_notification(pid, "Your punch hits nothing but air!")
                
                # Set punch cooldown (punch has no mana cost)
                cd_map = getattr(pl, 'cooldowns', None) or {}
                setattr(pl, 'cooldowns', cd_map)
                spec = pl.spells.get("punch", {})
                cooldown = float(spec.get("cooldown", 1.0))
                cd_map["punch"] = now + cooldown
                print(f"DEBUG: Player {pid} completed punch; CD until {cd_map['punch']:.2f}")
                        
            # clear casting state regardless
            pl.casting = None

    # Append chat messages for broadcast this tick
    if chats:
        for pid, text in chats.items():
            pl = state.players.get(pid)
            if not pl:
                continue
            # queue in state ephemeral chat buffer
            try:
                state._chat_buffer.append({"pid": pid, "name": getattr(pl, 'name', f"P{pid}"), "text": text})
            except Exception:
                try:
                    state._chat_buffer.append({"pid": pid, "name": f"P{pid}", "text": text})
                except Exception:
                    pass

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
