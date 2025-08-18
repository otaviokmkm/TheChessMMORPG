from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, Header
from fastapi.responses import RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from fastapi.middleware.cors import CORSMiddleware
from starlette.websockets import WebSocketState
from .auth import get_current_user, router as auth_router, is_admin_user
from .game.engine import GameEngine
from .schemas import ActionMessage, ClientHello
from sqlalchemy.orm import Session
from .db import get_db
import asyncio
import json

app = FastAPI(title="Turn-Based RPG Prototype")
app.include_router(auth_router, prefix="/auth", tags=["auth"]) 

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Run a faster tick loop (0.25s) and keep debug logs for now
engine = GameEngine(tick_seconds=0.25, debug=True)

@app.on_event("startup")
async def on_startup():
    # Ensure map exists before engine loop
    engine.state.ensure_map()
    asyncio.create_task(engine.run())

@app.get("/")
async def root():
    return RedirectResponse(url="/client/index.html")

# Serve static client
app.mount("/client", StaticFiles(directory="client", html=True), name="client")

# Serve music file explicitly
@app.get("/media/music")
async def get_music():
    root = Path(__file__).resolve().parents[2]
    fname = "Gregor Quendel - Debussy - Arabesque No. 1 (Arr. for Music Box).mp3.mp3"
    fpath = root / fname
    if not fpath.exists():
        # fallback: in case file was renamed to single .mp3
        f2 = root / "Gregor Quendel - Debussy - Arabesque No. 1 (Arr. for Music Box).mp3"
        if f2.exists():
            return FileResponse(str(f2), media_type="audio/mpeg", filename=f2.name)
        raise HTTPException(status_code=404, detail="Music file not found")
    return FileResponse(str(fpath), media_type="audio/mpeg", filename=fpath.name)

@app.get("/media/sergeant")
async def get_sergeant_audio():
    root = Path(__file__).resolve().parents[2]
    fpath = root / "Sargent audio.mp3"
    if not fpath.exists():
        raise HTTPException(status_code=404, detail="Sergeant audio not found")
    return FileResponse(str(fpath), media_type="audio/mpeg", filename=fpath.name)

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    try:
        # Expect a hello with token and client info
        raw = await ws.receive_text()
        hello = ClientHello.model_validate_json(raw)
        user = await get_current_user(token=hello.token)
        player_id = engine.connect_player(user_id=user.id, ws=ws)
        await ws.send_text(json.dumps({"type": "connected", "playerId": player_id, "tick": engine.tick_index}))
        # Main receive loop
        while True:
            raw_msg = await ws.receive_text()
            msg = ActionMessage.model_validate_json(raw_msg)
            engine.queue_action(player_id, msg)
    except WebSocketDisconnect:
        engine.disconnect_ws(ws)
    except Exception as ex:
        if ws.application_state == WebSocketState.CONNECTED:
            await ws.send_text(json.dumps({"type": "error", "message": str(ex)}))
        engine.disconnect_ws(ws)

@app.get("/debug/state")
async def debug_state():
    """Debug endpoint to inspect cave entrance position"""
    state = engine.state
    return {
        "world_size": {"width": state.WORLD_W, "height": state.WORLD_H},
        "cave_entrance": {"x": state.cave_entrance[0], "y": state.cave_entrance[1]},
        "mine_entrance": {"x": state.mine_entrance[0], "y": state.mine_entrance[1]},
        "tile_at_cave": state.tiles[state.cave_entrance[1]][state.cave_entrance[0]],
        "tile_at_mine": state.tiles[state.mine_entrance[1]][state.mine_entrance[0]],
        "players": [{"id": p.id, "x": p.x, "y": p.y} for p in state.players.values()]
    }

@app.post("/admin/wipe")
async def admin_wipe(authorization: str | None = Header(default=None), db: Session = Depends(get_db)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    token = authorization.split(" ", 1)[1]
    user = await get_current_user(token=token)
    if not is_admin_user(db, user.id):
        raise HTTPException(status_code=403, detail="Forbidden")
    await engine.admin_wipe()
    return {"status": "wiped"}
