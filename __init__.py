"""
Entry point for ComfyUI to discover the Prompt History Gallery nodes.
"""

from aiohttp import web

from server import PromptServer

from .prompt_history_gallery import (
    NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS,
    get_prompt_history_storage,
)

WEB_DIRECTORY = "./web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]


def _serialize_entry(entry):
    payload = entry.to_dict()
    if not isinstance(payload.get("files"), list):
        payload["files"] = []
    return payload


def _get_limit(request, *, default=50, maximum=200):
    value = request.rel_url.query.get("limit")
    if value is None:
        return default
    try:
        limit = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, min(limit, maximum))


def _get_bool(request, key: str, *, default: bool = False) -> bool:
    raw = request.rel_url.query.get(key)
    if raw is None:
        return default
    if isinstance(raw, str):
        normalized = raw.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return default


@PromptServer.instance.routes.get("/prompt-history")
async def list_prompt_history(request):
    storage = get_prompt_history_storage()
    limit = _get_limit(request)
    favorite_only = _get_bool(request, "favorite", default=False) or _get_bool(
        request, "favorites", default=False
    )
    entries = [
        _serialize_entry(entry)
        for entry in storage.list(limit=limit, favorite_only=favorite_only)
    ]
    return web.json_response({"entries": entries})


@PromptServer.instance.routes.delete("/prompt-history/{entry_id}")
async def delete_prompt_history_entry(request):
    entry_id = request.match_info.get("entry_id")
    if not entry_id:
        raise web.HTTPBadRequest()
    storage = get_prompt_history_storage()
    deleted = storage.delete(entry_id)
    if not deleted:
        raise web.HTTPNotFound()
    return web.json_response({"ok": True})


@PromptServer.instance.routes.delete("/prompt-history")
async def clear_prompt_history(request):
    storage = get_prompt_history_storage()
    storage.clear()
    return web.json_response({"ok": True})


def _parse_favorite_flag(payload, default=None):
    if isinstance(payload, bool):
        return payload
    if isinstance(payload, (int, float)):
        return bool(payload)
    if isinstance(payload, str):
        normalized = payload.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return default


@PromptServer.instance.routes.post("/prompt-history/{entry_id}/favorite")
async def set_prompt_history_favorite(request):
    entry_id = request.match_info.get("entry_id")
    if not entry_id:
        raise web.HTTPBadRequest()

    body = None
    try:
        body = await request.json()
    except Exception:
        body = None

    favorite_flag = _parse_favorite_flag(body.get("favorite") if isinstance(body, dict) else None)
    if favorite_flag is None:
        favorite_flag = _parse_favorite_flag(request.rel_url.query.get("favorite"))

    if favorite_flag is None:
        raise web.HTTPBadRequest(text="Missing favorite flag.")

    storage = get_prompt_history_storage()
    updated = storage.set_favorite(entry_id, favorite_flag)
    if not updated:
        raise web.HTTPNotFound()
    return web.json_response({"ok": True, "favorite": bool(favorite_flag)})
