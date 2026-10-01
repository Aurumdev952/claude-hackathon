"""WebSocket push (SPEC §14.3): refresh after each publish, new HIGH alerts, simulator ticks."""
from __future__ import annotations

import asyncio
import json

from fastapi import WebSocket, WebSocketDisconnect


class Hub:
    def __init__(self):
        self.clients: set[WebSocket] = set()

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.clients.add(ws)

    def drop(self, ws: WebSocket):
        self.clients.discard(ws)

    async def broadcast(self, msg: dict):
        dead = []
        text = json.dumps(msg, default=str)
        for ws in list(self.clients):
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.drop(ws)


HUB = Hub()


async def endpoint(ws: WebSocket):
    await HUB.connect(ws)
    try:
        while True:
            await asyncio.wait_for(ws.receive_text(), timeout=3600)
    except (WebSocketDisconnect, asyncio.TimeoutError, RuntimeError):
        HUB.drop(ws)
