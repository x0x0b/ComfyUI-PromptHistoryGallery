"""Shared helpers for syncing ComfyUI prompt completions with stored history."""

from __future__ import annotations

import logging
from typing import Any, Dict, Iterable, List, Optional

from .metadata_parser import get_image_path, parse_image_metadata
from .normalizers import normalize_output_payload
from .registry import consume_prompt_entries
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


def _extract_prompt_texts(prompt_payload: Any) -> List[str]:
    if not isinstance(prompt_payload, dict):
        return []
    prompts: List[str] = []
    for node in prompt_payload.values():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") != "PromptHistoryInput":
            continue
        inputs = node.get("inputs", {})
        if isinstance(inputs, dict):
            prompt_value = inputs.get("prompt")
            if isinstance(prompt_value, str) and prompt_value:
                prompts.append(prompt_value)
    return prompts


def _extract_metadata_from_files(files: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    for file_info in files:
        if not isinstance(file_info, dict):
            continue

        filename = file_info.get("filename")
        if not filename or not isinstance(filename, str):
            continue

        subfolder = str(file_info.get("subfolder") or "")
        folder_type = str(file_info.get("type") or "")

        candidate_types = []
        if folder_type:
            candidate_types.append(folder_type)
        for fallback in ("output", "temp", "input"):
            if fallback not in candidate_types:
                candidate_types.append(fallback)

        for candidate in candidate_types:
            image_path = get_image_path(filename, subfolder, candidate)
            if not image_path:
                continue
            metadata = parse_image_metadata(image_path)
            if metadata:
                return metadata

    return {}


def _build_metadata_update(
    prompt_payload: Any, files: Iterable[Dict[str, Any]]
) -> Dict[str, Any]:
    metadata_update: Dict[str, Any] = {}
    image_metadata = _extract_metadata_from_files(files)
    if image_metadata:
        metadata_update.update(image_metadata)

    if prompt_payload and "comfyui_prompt" not in metadata_update:
        metadata_update["comfyui_prompt"] = prompt_payload

    return metadata_update


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

    prompt_texts = _extract_prompt_texts(prompt_payload)
    if not prompt_texts:
        return []

    resolved = storage.find_entry_ids_for_prompts(prompt_texts)
    return list(resolved.values())


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

    files = _extract_generated_files(history_result)
    if files:
        storage.add_outputs_for_entries(entry_ids, files)

    metadata_update = _build_metadata_update(prompt_payload, files)
    if metadata_update:
        for entry_id in entry_ids:
            storage.update_metadata(entry_id, metadata_update)

    storage.touch_entries(entry_ids)
    _notify_clients(server, entry_ids, files)
