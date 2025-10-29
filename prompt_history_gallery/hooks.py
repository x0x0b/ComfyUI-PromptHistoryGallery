"""Runtime hooks to connect prompt executions with stored history entries."""

from __future__ import annotations

import logging
import threading
from functools import wraps
from typing import Any, Dict, List, Optional

import execution

from .storage import (
    consume_prompt_entries,
    get_prompt_history_storage,
)

LOGGER = logging.getLogger(__name__)

_INSTALL_LOCK = threading.Lock()
_IS_INSTALLED = False


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
                if isinstance(entry, dict):
                    filename = entry.get("filename")
                    if not filename:
                        continue
                    payload: Dict[str, Any] = {"filename": str(filename)}
                    subfolder = entry.get("subfolder")
                    if subfolder:
                        payload["subfolder"] = str(subfolder)
                    output_type = entry.get("type") or entry.get("kind")
                    if output_type:
                        payload["type"] = str(output_type)
                    collected.append(payload)
                elif isinstance(entry, str):
                    collected.append({"filename": entry})

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


def _handle_prompt_completion(
    prompt_id: Optional[str],
    history_result: Any,
    prompt_payload: Any,
) -> None:
    storage = get_prompt_history_storage()

    entry_ids = consume_prompt_entries(prompt_id)
    if not entry_ids:
        prompt_texts = _extract_prompt_texts(prompt_payload)
        if prompt_texts:
            resolved = storage.find_entry_ids_for_prompts(prompt_texts)
            entry_ids = list(resolved.values())

    if not entry_ids:
        return

    files = _extract_generated_files(history_result)
    if files:
        storage.add_outputs_for_entries(entry_ids, files)

    storage.touch_entries(entry_ids)


def _wrap_task_done() -> None:
    original = execution.PromptQueue.task_done

    @wraps(original)
    def wrapper(self, item_id, history_result, status):  # type: ignore[override]
        prompt_id: Optional[str] = None
        prompt_payload: Any = None
        try:
            with self.mutex:  # type: ignore[attr-defined]
                prompt = self.currently_running.get(item_id)  # type: ignore[attr-defined]
                if prompt:
                    prompt_id = prompt[1]
                    if len(prompt) > 2:
                        prompt_payload = prompt[2]
        except Exception:
            LOGGER.debug("Failed to determine prompt id for history capture.", exc_info=True)

        try:
            return original(self, item_id, history_result, status)
        finally:
            try:
                _handle_prompt_completion(prompt_id, history_result, prompt_payload)
            except Exception:  # pragma: no cover - defensive logging.
                LOGGER.exception("Failed to store generated files for prompt %s", prompt_id)

    execution.PromptQueue.task_done = wrapper  # type: ignore[assignment]


def install_hooks() -> None:
    """Install runtime hooks once."""

    global _IS_INSTALLED
    with _INSTALL_LOCK:
        if _IS_INSTALLED:
            return
        _wrap_task_done()
        _IS_INSTALLED = True
