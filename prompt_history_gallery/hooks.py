"""Shared helpers for syncing ComfyUI prompt completions with stored history."""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from .normalizers import normalize_output_payload
from .registry import consume_prompt_entries
from .settings import is_capture_enabled
from .storage import get_prompt_history_storage

LOGGER = logging.getLogger(__name__)


def _extract_generated_files(history_result: Any) -> List[Dict[str, Any]]:
    if not isinstance(history_result, dict):
        return []

    outputs = history_result.get("outputs")
    if not isinstance(outputs, dict):
        return []

    collected: List[Dict[str, Any]] = []

    for node_outputs in outputs.values():
        if not isinstance(node_outputs, dict):
            continue
        for key in ("images", "files"):
            entries = node_outputs.get(key)
            if not isinstance(entries, list):
                continue
            for entry in entries:
                record = normalize_output_payload(entry)
                if record:
                    collected.append(record.to_dict())

    # Heuristic: If we have any "output" (saved) images, ignore "temp" (preview) images.
    # This prevents intermediate controlnet previews from cluttering the history
    # when a real save node is present.
    has_saved_output = any(item.get("type") == "output" for item in collected)
    if has_saved_output:
        collected = [item for item in collected if item.get("type") == "output"]

    return collected


def _extract_prompt_pairs(prompt_payload: Any) -> List[Tuple[str, str]]:
    if not isinstance(prompt_payload, dict):
        return []
    pairs: List[Tuple[str, str]] = []
    for node in prompt_payload.values():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type")
        if class_type not in ("PromptHistoryInput", "PromptHistoryDualInput"):
            continue
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            continue
        prompt_value = inputs.get("prompt")
        if not isinstance(prompt_value, str) or not prompt_value:
            continue
        negative_value = inputs.get("negative_prompt")
        pairs.append((prompt_value, negative_value if isinstance(negative_value, str) else ""))
    return pairs


def _resolve_entry_ids(
    prompt_id: Optional[str],
    prompt_payload: Any,
    storage,
) -> List[str]:
    """
    Derive history entry ids associated with a completed prompt.
    """
    entry_ids = consume_prompt_entries(prompt_id)
    if entry_ids:
        return entry_ids

    pairs = _extract_prompt_pairs(prompt_payload)
    if not pairs:
        return []

    return storage.find_entry_ids_for_prompt_pairs(pairs)


def _notify_clients(
    server: Optional[Any], entry_ids: List[str], files: List[Dict[str, Any]]
) -> None:
    if server is None or not entry_ids:
        return
    try:
        payload: Dict[str, Any] = {"entry_ids": list(entry_ids)}
        if files:
            payload["files"] = [dict(item) for item in files]
        server.send_sync("PromptHistoryGallery.updated", payload)
    except Exception:  # pragma: no cover
        LOGGER.exception("Failed to notify clients about history update")


def handle_prompt_completion(
    prompt_id: Optional[str],
    history_result: Any,
    prompt_payload: Any,
    server: Optional[Any],
) -> None:
    storage = get_prompt_history_storage()

    entry_ids = _resolve_entry_ids(prompt_id, prompt_payload, storage)
    if not entry_ids:
        return

    if not is_capture_enabled():
        return

    files = _extract_generated_files(history_result)
    if files:
        storage.add_outputs_for_entries(entry_ids, files)

    storage.touch_entries(entry_ids)
    _notify_clients(server, entry_ids, files)
