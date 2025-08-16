from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException
from fastapi.responses import RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from fastapi.middleware.cors import CORSMiddleware
from starlette.websockets import WebSocketState
from .auth import get_current_user, router as auth_router
from .game.engine import GameEngine
from .schemas import ActionMessage, ClientHello
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

engine = GameEngine(tick_seconds=2.0)

@app.on_event("startup")
async def on_startup():
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
