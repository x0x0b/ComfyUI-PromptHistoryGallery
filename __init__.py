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


@PromptServer.instance.routes.get("/prompt-history")
async def list_prompt_history(request):
    storage = get_prompt_history_storage()
    limit = _get_limit(request)
    entries = [_serialize_entry(entry) for entry in storage.list(limit=limit)]
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
