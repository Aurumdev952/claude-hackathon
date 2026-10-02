"""WebSocket push (SPEC §14.3, v3 contract §4.3): refresh after each publish, new HIGH alerts, simulator ticks, plus
targeted care events.

After connecting, a client may send {"subscribe": {"role": "doctor", "facility_id": 123}} or
{"subscribe": {"role": "patient", "patient_id": 456}}. Unsubscribed clients only get broadcast events (as before).
Targeted events: `care_update` -> doctors subscribed to that facility; `notification` -> that patient. `sim_job` and
all existing event types are broadcast.
"""
from __future__ import annotations

import asyncio
import json

from fastapi import WebSocket, WebSocketDisconnect

TARGETED = {"care_update", "notification"}


class Hub:
    def __init__(self):
        self.clients: set[WebSocket] = set()
        self.subs: dict[WebSocket, dict] = {}

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.clients.add(ws)

    def drop(self, ws: WebSocket):
        self.clients.discard(ws)
        self.subs.pop(ws, None)

    def subscribe(self, ws: WebSocket, sub: dict) -> dict:
        """Validate and store a subscription. Raises ValueError on a bad request."""
        if not isinstance(sub, dict):
            raise ValueError("subscribe must be an object")
        role = str(sub.get("role", "")).lower()
        if role == "doctor":
            s = {"role": "doctor", "facility_id": int(sub["facility_id"])}
        elif role == "patient":
            s = {"role": "patient", "patient_id": int(sub["patient_id"])}
        elif role == "ministry":
            s = {"role": "ministry"}
        else:
            raise ValueError("role must be doctor, patient or ministry")
        self.subs[ws] = s
        return s

    def targets(self, msg: dict) -> list[WebSocket]:
        """Clients that should receive `msg` (broadcast events go to everyone)."""
        t = msg.get("type")
        if t not in TARGETED:
            return list(self.clients)
        out = []
        for ws in list(self.clients):
            s = self.subs.get(ws)
            if not s:
                continue
            if t == "care_update" and s["role"] == "doctor" and msg.get("facility_id") is not None \
                    and int(msg["facility_id"]) == s["facility_id"]:
                out.append(ws)
            elif t == "notification" and s["role"] == "patient" and msg.get("patient_id") is not None \
                    and int(msg["patient_id"]) == s["patient_id"]:
                out.append(ws)
        return out

    async def _send(self, clients: list[WebSocket], msg: dict):
        dead = []
        text = json.dumps(msg, default=str)
        for ws in clients:
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.drop(ws)

    async def broadcast(self, msg: dict):
        """Send to every client (backward compatible: refresh, alert_new, sim_tick, sim_job)."""
        await self._send(list(self.clients), msg)

    async def dispatch(self, msg: dict):
        """Route an event: targeted care events by subscription, everything else broadcast."""
        await self._send(self.targets(msg), msg)


HUB = Hub()


async def endpoint(ws: WebSocket):
    await HUB.connect(ws)
    try:
        while True:
            text = await asyncio.wait_for(ws.receive_text(), timeout=3600)
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(msg, dict) and "subscribe" in msg:
                try:
                    s = HUB.subscribe(ws, msg["subscribe"])
                    await ws.send_text(json.dumps({"type": "subscribed", **s}))
                except (ValueError, KeyError, TypeError) as e:
                    await ws.send_text(json.dumps({"type": "error", "code": "INVALID_SUBSCRIPTION", "message": str(e)}))
            elif isinstance(msg, dict) and msg.get("type") == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except (WebSocketDisconnect, asyncio.TimeoutError, RuntimeError):
        HUB.drop(ws)
