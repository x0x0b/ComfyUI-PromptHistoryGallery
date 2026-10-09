"""
Entry point for ComfyUI to discover the Prompt History Gallery nodes.
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List

from aiohttp import web
from server import PromptServer

from .prompt_history_gallery import (
    NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS,
    get_prompt_history_storage,
    set_capture_enabled,
)
from .prompt_history_gallery.prompt_params import summarize_entry_metadata
from .prompt_history_gallery.thumbnails import (
    cache_headers,
    etag_for,
    generate_thumbnail,
    is_thumbnailable,
    maybe_prune_thumbnails,
    resolve_image_path,
    thumbnail_cache_path,
)

WEB_DIRECTORY = "./web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]


def _serialize_entry(entry) -> Dict[str, Any]:
    payload = entry.to_dict()
    # Drop the bulky workflow payloads; the front-end only needs the caption
    # fields, which summarize_entry_metadata() pre-extracts.
    payload["metadata"] = summarize_entry_metadata(payload.get("metadata"))
    if not isinstance(payload.get("files"), list):
        payload["files"] = []
    return payload


def _load_serialized_entries(limit: int) -> List[Dict[str, Any]]:
    """Read and serialise entries; runs off the event loop."""
    storage = get_prompt_history_storage()
    return [_serialize_entry(entry) for entry in storage.list(limit=limit)]


def _get_limit(request, *, default=50, minimum=20, maximum=1000):
    value = request.rel_url.query.get("limit")
    if value is None:
        return max(minimum, min(default, maximum))
    try:
        limit = int(value)
    except (TypeError, ValueError):
        return max(minimum, min(default, maximum))
    return max(minimum, min(limit, maximum))


@PromptServer.instance.routes.get("/prompt-history")
async def list_prompt_history(request):
    limit = _get_limit(request)
    # storage.list() is synchronous SQLite work plus a large serialisation pass;
    # running it inline stalls the whole ComfyUI event loop.
    entries = await asyncio.to_thread(_load_serialized_entries, limit)
    return web.json_response({"entries": entries})


@PromptServer.instance.routes.delete("/prompt-history/{entry_id}")
async def delete_prompt_history_entry(request):
    entry_id = request.match_info.get("entry_id")
    if not entry_id:
        raise web.HTTPBadRequest()
    storage = get_prompt_history_storage()
    deleted = await asyncio.to_thread(storage.delete, entry_id)
    if not deleted:
        raise web.HTTPNotFound()
    return web.json_response({"ok": True})


@PromptServer.instance.routes.delete("/prompt-history")
async def clear_prompt_history(request):
    storage = get_prompt_history_storage()
    await asyncio.to_thread(storage.clear)
    return web.json_response({"ok": True})


@PromptServer.instance.routes.post("/prompt-history/settings")
async def update_prompt_history_settings(request):
    try:
        payload = await request.json()
    except Exception:  # malformed body or unexpected content type
        raise web.HTTPBadRequest(text="Expected a JSON object.") from None
    if not isinstance(payload, dict):
        raise web.HTTPBadRequest(text="Expected a JSON object.")

    if "capture_history" not in payload:
        raise web.HTTPBadRequest(text="Missing capture_history.")

    enabled = payload["capture_history"]
    if not isinstance(enabled, bool):
        raise web.HTTPBadRequest(text="capture_history must be a boolean.")

    await asyncio.to_thread(set_capture_enabled, enabled)
    return web.json_response({"ok": True})


@PromptServer.instance.routes.get("/prompt-history/thumb")
async def prompt_history_thumbnail(request):
    source = resolve_image_path(
        request.rel_url.query.get("filename", ""),
        request.rel_url.query.get("subfolder", ""),
        request.rel_url.query.get("type", "output"),
    )
    # Any failure is a 404 so the front-end has a single recovery path: fall
    # back to the full-size /view URL.
    if not source or not is_thumbnailable(source):
        return web.Response(status=404)

    try:
        cache_path = await asyncio.to_thread(thumbnail_cache_path, source)
    except OSError:
        return web.Response(status=404)

    etag = etag_for(cache_path)
    if request.headers.get("If-None-Match") == etag:
        return web.Response(status=304, headers=cache_headers(etag))

    if not cache_path.exists():
        # Decoding and resizing is CPU-bound; keep it off the event loop.
        generated = await asyncio.to_thread(generate_thumbnail, source, cache_path)
        if not generated:
            return web.Response(status=404)
        await asyncio.to_thread(maybe_prune_thumbnails, cache_path.parent)

    try:
        body = await asyncio.to_thread(cache_path.read_bytes)
    except OSError:
        return web.Response(status=404)

    return web.Response(body=body, content_type="image/webp", headers=cache_headers(etag))
