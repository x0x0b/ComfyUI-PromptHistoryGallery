"""Background polling loop for linking ComfyUI history with stored prompts."""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Dict, Optional, Tuple

from .hooks import handle_prompt_completion

LOGGER = logging.getLogger(__name__)

_POLL_INTERVAL_SECONDS = 0.5
_HISTORY_WINDOW = 512
_WATCHER_LOCK = threading.Lock()
_WATCHER_STARTED = False


def start_history_watcher(poll_interval: float = _POLL_INTERVAL_SECONDS) -> None:
    """Ensure the background watcher thread is running."""
    global _WATCHER_STARTED
    with _WATCHER_LOCK:
        if _WATCHER_STARTED:
            return
        thread = threading.Thread(
            target=_watch_history_loop,
            args=(poll_interval,),
            name="PromptHistoryWatcher",
            daemon=True,
        )
        thread.start()
        _WATCHER_STARTED = True


def _resolve_prompt_queue() -> Tuple[Optional[Any], Optional[Any]]:
    try:
        from server import PromptServer  # type: ignore import-not-found
    except Exception:
        LOGGER.debug("PromptServer is not ready yet.", exc_info=True)
        return None, None

    server = getattr(PromptServer, "instance", None)
    queue = getattr(server, "prompt_queue", None) if server else None
    return server, queue


def _extract_prompt_payload(history_entry: Dict[str, Any]) -> Any:
    prompt_data = history_entry.get("prompt")
    if isinstance(prompt_data, (list, tuple)) and len(prompt_data) > 2:
        return prompt_data[2]
    return None


def _watch_history_loop(poll_interval: float) -> None:
    processed_prompt_ids: set[str] = set()
    server: Optional[Any] = None
    queue: Optional[Any] = None

    while True:
        if queue is None:
            server, queue = _resolve_prompt_queue()
            if queue is None:
                time.sleep(poll_interval)
                continue

        try:
            history = queue.get_history(max_items=_HISTORY_WINDOW)
            if not isinstance(history, dict):
                time.sleep(poll_interval)
                continue

            window_ids = set()
            for prompt_id_raw, payload in history.items():
                prompt_id = str(prompt_id_raw)
                window_ids.add(prompt_id)
                if prompt_id in processed_prompt_ids:
                    continue

                prompt_payload = _extract_prompt_payload(payload)
                try:
                    handle_prompt_completion(
                        prompt_id,
                        payload,
                        prompt_payload,
                        server,
                    )
                except Exception:
                    LOGGER.exception(
                        "Failed to process prompt history entry %s", prompt_id
                    )
                processed_prompt_ids.add(prompt_id)

            processed_prompt_ids.intersection_update(window_ids)
        except Exception:
            LOGGER.exception(
                "Prompt history watcher encountered an error; retrying shortly."
            )
            queue = None

        time.sleep(poll_interval)
