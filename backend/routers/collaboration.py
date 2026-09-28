"""
实时协作路由
- REST:      会话创建/加入/离开/列表/权限
- WebSocket: /ws/collaboration/{session_id}  实时消息广播
"""
import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, Depends, Query
from pydantic import BaseModel

from routers.auth import get_current_user

router = APIRouter(tags=["协作"])

# ══════════════════════════════════════════════════════════════
# 内存状态（单进程够用；多进程部署时换 Redis Pub/Sub）
# ══════════════════════════════════════════════════════════════

class CollabSession:
    def __init__(self, session_id: str, name: str, creator_id: str,
                 is_public: bool, max_participants: int):
        self.id              = session_id
        self.name            = name
        self.creator_id      = creator_id
        self.is_public       = is_public
        self.max_participants = max_participants
        self.created_at      = datetime.now(timezone.utc).isoformat()
        # user_id → {"name", "permissions", "joined_at", "is_active"}
        self.members: dict[str, dict] = {}
        # user_id → WebSocket
        self.connections: dict[str, WebSocket] = {}

    def to_dict(self) -> dict:
        return {
            "id":               self.id,
            "name":             self.name,
            "creator_id":       self.creator_id,
            "is_public":        self.is_public,
            "max_participants": self.max_participants,
            "created_at":       self.created_at,
            "collaborators":    list(self.members.values()),
        }

    async def broadcast(self, message: dict, exclude_user: Optional[str] = None):
        """向会话内所有（或除 exclude_user 外的）连接广播消息"""
        dead = []
        for uid, ws in self.connections.items():
            if uid == exclude_user:
                continue
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                dead.append(uid)
        for uid in dead:
            self.connections.pop(uid, None)
            self.members.pop(uid, None)

    async def send_to(self, user_id: str, message: dict):
        """向指定用户发送消息"""
        ws = self.connections.get(user_id)
        if ws:
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                pass


# 全局会话注册表
_sessions: dict[str, CollabSession] = {}


# ══════════════════════════════════════════════════════════════
# REST 接口
# ══════════════════════════════════════════════════════════════

class CreateSessionRequest(BaseModel):
    name: str = "协作会话"
    is_public: bool = False
    max_participants: int = 10


class PermissionRequest(BaseModel):
    userId: str
    permission: str  # read | write | admin


@router.post("/api/collaboration/sessions")
async def create_session(
    body: CreateSessionRequest,
    user: dict = Depends(get_current_user),
):
    session_id = str(uuid.uuid4())
    session = CollabSession(
        session_id=session_id,
        name=body.name,
        creator_id=user["id"],
        is_public=body.is_public,
        max_participants=body.max_participants,
    )
    # 创建者自动加入，权限为 admin
    session.members[user["id"]] = {
        "id":          user["id"],
        "name":        user.get("display_name") or user["email"].split("@")[0],
        "permissions": "admin",
        "joined_at":   datetime.now(timezone.utc).isoformat(),
        "is_active":   True,
    }
    _sessions[session_id] = session
    return session.to_dict()


@router.get("/api/collaboration/sessions")
async def list_sessions(user: dict = Depends(get_current_user)):
    """列出公开会话 + 当前用户参与的会话"""
    result = []
    for s in _sessions.values():
        if s.is_public or user["id"] in s.members:
            result.append(s.to_dict())
    return {"sessions": result}


@router.post("/api/collaboration/sessions/{session_id}/join")
async def join_session(
    session_id: str,
    user: dict = Depends(get_current_user),
):
    session = _sessions.get(session_id)
    if not session:
        raise HTTPException(404, "会话不存在")
    if len(session.members) >= session.max_participants:
        raise HTTPException(403, "会话人数已满")

    if user["id"] not in session.members:
        session.members[user["id"]] = {
            "id":          user["id"],
            "name":        user.get("display_name") or user["email"].split("@")[0],
            "permissions": "write",
            "joined_at":   datetime.now(timezone.utc).isoformat(),
            "is_active":   True,
        }
    return session.to_dict()


@router.post("/api/collaboration/sessions/{session_id}/leave")
async def leave_session(
    session_id: str,
    user: dict = Depends(get_current_user),
):
    session = _sessions.get(session_id)
    if not session:
        return {"ok": True}

    session.members.pop(user["id"], None)
    session.connections.pop(user["id"], None)

    # 广播离开事件
    await session.broadcast({"type": "user-left", "user_id": user["id"]})

    # 会话无人时销毁
    if not session.members:
        _sessions.pop(session_id, None)

    return {"ok": True}


@router.put("/api/collaboration/sessions/{session_id}/permissions")
async def set_permission(
    session_id: str,
    body: PermissionRequest,
    user: dict = Depends(get_current_user),
):
    session = _sessions.get(session_id)
    if not session:
        raise HTTPException(404, "会话不存在")
    if session.creator_id != user["id"]:
        raise HTTPException(403, "仅创建者可修改权限")
    if body.permission not in ("read", "write", "admin"):
        raise HTTPException(400, "无效权限值")

    member = session.members.get(body.userId)
    if not member:
        raise HTTPException(404, "用户不在会话中")

    member["permissions"] = body.permission
    await session.broadcast({
        "type":       "permission-changed",
        "user_id":    body.userId,
        "permission": body.permission,
    })
    return {"ok": True}


# ══════════════════════════════════════════════════════════════
# WebSocket 端点
# ══════════════════════════════════════════════════════════════

@router.websocket("/ws/collaboration/{session_id}")
async def ws_collaboration(
    websocket: WebSocket,
    session_id: str,
    token: str = Query(...),   # ?token=<access_token>
):
    """
    客户端连接：ws://host/ws/collaboration/{session_id}?token=<jwt>
    """
    from core.security import decode_token
    import repositories.user_repo as user_repo

    # ── 鉴权 ──────────────────────────────────────────────────
    payload = decode_token(token)
    if not payload or payload.get("type") != "access":
        await websocket.close(code=4001, reason="token 无效")
        return

    user = await user_repo.get_by_id(payload["sub"])
    if not user:
        await websocket.close(code=4001, reason="用户不存在")
        return
    try:
        from routers.auth import _require_current_legal_acceptance
        await _require_current_legal_acceptance(user, payload)
    except HTTPException:
        await websocket.close(code=4003, reason="请先确认最新协议")
        return

    session = _sessions.get(session_id)
    if not session:
        await websocket.close(code=4004, reason="会话不存在")
        return

    if user["id"] not in session.members:
        await websocket.close(code=4003, reason="未加入该会话")
        return

    # ── 建立连接 ──────────────────────────────────────────────
    await websocket.accept()
    session.connections[user["id"]] = websocket
    session.members[user["id"]]["is_active"] = True

    user_name = user.get("display_name") or user["email"].split("@")[0]

    # 通知其他人有新用户加入
    await session.broadcast(
        {
            "type": "user-joined",
            "user": {
                "id":          user["id"],
                "name":        user_name,
                "permissions": session.members[user["id"]]["permissions"],
                "joined_at":   session.members[user["id"]]["joined_at"],
                "is_active":   True,
            },
        },
        exclude_user=user["id"],
    )

    # 向新用户发送当前会话状态
    await session.send_to(user["id"], {
        "type":         "session-update",
        "collaborators": list(session.members.values()),
    })

    # ── 消息循环 ──────────────────────────────────────────────
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type")

            if msg_type == "action":
                # 转发给其他所有人
                await session.broadcast(msg, exclude_user=user["id"])

            elif msg_type == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))

    except WebSocketDisconnect:
        pass
    finally:
        # 清理连接
        session.connections.pop(user["id"], None)
        if user["id"] in session.members:
            session.members[user["id"]]["is_active"] = False

        await session.broadcast({
            "type":    "user-left",
            "user_id": user["id"],
        })
