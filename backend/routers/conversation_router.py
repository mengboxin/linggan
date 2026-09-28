"""
对话历史记录路由
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List, Literal

from core import cache as ui_cache
from core import history_artifacts
from core.user_context import get_current_storage_workspace
from routers.auth import get_current_user
from repositories import conversation_repo
from services import asset_storage

router = APIRouter(prefix="/api/conversations", tags=["conversations"])
CONVERSATION_LIST_CACHE_TTL_SECONDS = 20
CONVERSATION_MESSAGES_CACHE_TTL_SECONDS = 30
IMAGE_HISTORY_CACHE_TTL_SECONDS = 20


class ConversationResponse(BaseModel):
    """对话响应"""
    id: str
    user_id: str
    type: str
    title: str
    is_archived: bool
    message_count: int
    created_at: str
    updated_at: str


class MessageResponse(BaseModel):
    """消息响应"""
    id: str
    conversation_id: str
    role: str
    content: str
    meta: dict
    created_at: str


class UpdateTitleRequest(BaseModel):
    """更新标题请求"""
    title: str


class CreateConversationRequest(BaseModel):
    type: Literal["ppt", "image", "layer-edit", "sci-fig", "poster", "paper", "image-prompt"] = "image"
    title: str = "未命名对话"
    creation_key: Optional[str] = None


class AddMessageRequest(BaseModel):
    role: Literal["user", "assistant"]
    content: str
    meta: Optional[dict] = None


@router.post("", response_model=ConversationResponse)
async def create_conversation(
    req: CreateConversationRequest,
    user: dict = Depends(get_current_user),
):
    conv_type = "image" if req.type == "layer-edit" else req.type
    title = req.title.strip() or "未命名对话"
    conversation = await conversation_repo.create_conversation(
        user_id=user["id"],
        conv_type=conv_type,
        title=title[:80],
        creation_key=req.creation_key,
    )
    conversation["message_count"] = 0
    return conversation


@router.get("", response_model=List[ConversationResponse])
async def list_conversations(
    type: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    user: dict = Depends(get_current_user),
):
    """
    获取对话列表

    - type: 可选，筛选对话类型 (ppt/image)
    - limit: 每页数量
    - offset: 偏移量
    """
    requested_limit = max(1, min(limit, 200))
    requested_offset = max(0, offset)
    storage_workspace = get_current_storage_workspace()
    version = await ui_cache.get_user_cache_version(user["id"], "history")
    cache_key = ui_cache.user_cache_key(
        user["id"],
        "conversations",
        storage_workspace,
        version,
        type or "all",
        requested_limit,
        requested_offset,
    )
    cached = await ui_cache.get_json(cache_key)
    if isinstance(cached, list):
        return cached
    conversations = await conversation_repo.list_conversations(
        user["id"], type, requested_limit, requested_offset
    )
    await ui_cache.set_json(cache_key, conversations, CONVERSATION_LIST_CACHE_TTL_SECONDS)
    return conversations


@router.get("/counts")
async def get_conversation_counts(
    user: dict = Depends(get_current_user),
):
    storage_workspace = get_current_storage_workspace()
    version = await ui_cache.get_user_cache_version(user["id"], "history")
    cache_key = ui_cache.user_cache_key(user["id"], "conversation-counts", storage_workspace, version)
    cached = await ui_cache.get_json(cache_key)
    if isinstance(cached, dict):
        return cached

    counts = await conversation_repo.count_conversations_by_type(user["id"])
    payload = {
        "ppt": int(counts.get("ppt", 0)),
        "sci-fig": int(counts.get("sci-fig", 0)),
        "poster": int(counts.get("poster", 0)),
        "paper": int(counts.get("paper", 0)),
        "image-prompt": int(counts.get("image-prompt", 0)),
        "image": int(counts.get("image", 0)),
        "total": int(sum(counts.values())),
    }
    await ui_cache.set_json(cache_key, payload, CONVERSATION_LIST_CACHE_TTL_SECONDS)
    return payload


@router.get("/images/batch")
async def list_image_messages(
    limit: int = 50,
    user: dict = Depends(get_current_user),
):
    """
    批量获取最近对话中的图片消息（用于历史加载优化）

    返回最近 limit 个对话中包含图片的 assistant 消息，
    避免前端 N+1 请求问题。
    """
    requested_limit = max(1, min(limit, 200))
    storage_workspace = get_current_storage_workspace()
    version = await ui_cache.get_user_cache_version(user["id"], "history")
    cache_key = ui_cache.user_cache_key(user["id"], "image-history", storage_workspace, version, requested_limit)
    cached = await ui_cache.get_json(cache_key)
    if isinstance(cached, list):
        return await asset_storage.prepare_image_asset_payload(cached, user["id"])

    results = []
    summaries = await conversation_repo.list_image_message_summaries(user["id"], limit=requested_limit * 4)
    prepared_summaries = await asset_storage.prepare_image_asset_payload(summaries, user["id"])
    for msg in prepared_summaries:
        try:
            item = history_artifacts.image_history_item(msg)
            if item:
                results.append(item)
        except Exception:
            continue

    results.sort(key=lambda item: item.get("created_at", ""), reverse=True)
    payload = results[:requested_limit]
    await ui_cache.set_json(cache_key, payload, IMAGE_HISTORY_CACHE_TTL_SECONDS)
    return payload


@router.get("/{conversation_id}/messages", response_model=List[MessageResponse])
async def get_conversation_messages(
    conversation_id: str,
    light: bool = Query(default=False),
    user: dict = Depends(get_current_user),
):
    """获取对话的所有消息"""
    try:
        if light:
            version = await ui_cache.get_user_cache_version(user["id"], "history")
            cache_key = ui_cache.user_cache_key(
                user["id"],
                "conversation-messages-light",
                version,
                conversation_id,
            )
            cached = await ui_cache.get_json(cache_key)
            if isinstance(cached, list):
                return await asset_storage.prepare_image_asset_payload(cached, user["id"])
        messages = await conversation_repo.get_conversation_messages(
            conversation_id, user["id"], light=light
        )
        messages = await asset_storage.prepare_image_asset_payload(messages, user["id"])
        if light:
            await ui_cache.set_json(cache_key, messages, CONVERSATION_MESSAGES_CACHE_TTL_SECONDS)
        return messages
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/{conversation_id}/messages", response_model=MessageResponse)
async def add_conversation_message(
    conversation_id: str,
    req: AddMessageRequest,
    user: dict = Depends(get_current_user),
):
    meta = req.meta if isinstance(req.meta, dict) else {}
    meta_type = str(meta.get("type") or "").strip().casefold()
    meta_keys = {str(key).strip().casefold() for key in meta}
    if (
        meta_type.startswith("image_prompt_")
        or "server_provenance" in meta_keys
        or "history_key" in meta_keys
        or "idempotency_key" in meta_keys
    ):
        raise HTTPException(status_code=400, detail="该消息类型为服务器保留类型")
    if not await conversation_repo.conversation_belongs_to_user(
        conversation_id, user["id"]
    ):
        raise HTTPException(status_code=404, detail="对话不存在或无权访问")
    content = req.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="消息内容不能为空")
    return await conversation_repo.add_message(
        conversation_id=conversation_id,
        role=req.role,
        content=content,
        meta=meta,
    )


@router.patch("/{conversation_id}/title")
async def update_conversation_title(
    conversation_id: str,
    req: UpdateTitleRequest,
    user: dict = Depends(get_current_user),
):
    """更新对话标题"""
    success = await conversation_repo.update_conversation_title(
        conversation_id, user["id"], req.title
    )
    if not success:
        raise HTTPException(status_code=404, detail="对话不存在")
    return {"success": True}


@router.delete("/{conversation_id}/messages/{message_id}")
async def delete_conversation_message(
    conversation_id: str,
    message_id: str,
    user: dict = Depends(get_current_user),
):
    """删除单条对话消息"""
    result = await conversation_repo.delete_message(
        conversation_id, message_id, user["id"]
    )
    if not result.get("success"):
        raise HTTPException(status_code=404, detail="消息不存在或无权删除")
    return {"success": True, "cleanup": result.get("cleanup", {})}


@router.delete("/{conversation_id}")
async def delete_conversation(
    conversation_id: str,
    user: dict = Depends(get_current_user),
):
    """删除对话"""
    result = await conversation_repo.delete_conversation(
        conversation_id, user["id"]
    )
    if not result.get("success"):
        raise HTTPException(status_code=404, detail="对话不存在")
    return {"success": True, "cleanup": result.get("cleanup", {})}
