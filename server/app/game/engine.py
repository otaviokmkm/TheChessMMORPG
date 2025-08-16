from __future__ import annotations
from typing import Dict, Optional
from fastapi import WebSocket
import asyncio
import json
from .state import GameState
from .actions import resolve_actions

class GameEngine:
    def __init__(self, tick_seconds: float = 2.0):
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
        self._connections[player_id] = ws
        self._ws_to_player[ws] = player_id
        return player_id

    def disconnect_ws(self, ws: WebSocket):
        pid = self._ws_to_player.pop(ws, None)
        if pid is not None:
            self._connections.pop(pid, None)

    def queue_action(self, player_id: int, action_msg):
        # Replace queued action before the tick resolves
        self._action_queue[player_id] = action_msg.model_dump()

    async def run(self):
        while True:
            await asyncio.sleep(self.tick_seconds)
            await self._tick()

    async def _tick(self):
        async with self._lock:
            actions = self._action_queue
            self._action_queue = {}
            # Resolve simultaneously
            resolve_actions(self.state, actions)
            self.tick_index += 1
            # Broadcast new state snapshot
            snapshot = self.state.snapshot()
            message = json.dumps({"type": "state", "tick": self.tick_index, "state": snapshot})
            await self._broadcast(message)

    async def _broadcast(self, text: str):
        # Send to all connected clients; swallow individual errors
        for ws in list(self._connections.values()):
            try:
                await ws.send_text(text)
            except Exception:
                pass
