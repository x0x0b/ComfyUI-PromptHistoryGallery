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


class _HistoryWatcher:
    """
    Lightweight background thread that watches the ComfyUI prompt queue and
    links completed prompts to stored history entries.
    """

    def __init__(
        self,
        poll_interval: float = _POLL_INTERVAL_SECONDS,
        history_window: int = _HISTORY_WINDOW,
    ) -> None:
        self.poll_interval = poll_interval
        self.history_window = history_window
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self, poll_interval: Optional[float] = None) -> None:
        """
        Launch the watcher thread if it is not already running.
        """
        if poll_interval is not None:
            self.poll_interval = poll_interval

        with _WATCHER_LOCK:
            if self._thread and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._run,
                name="PromptHistoryWatcher",
                daemon=True,
            )
            self._thread.start()

    def stop(self) -> None:
        """
        Signal the watcher to stop. Primarily useful for tests.
        """
        with _WATCHER_LOCK:
            self._stop_event.set()
            self._thread = None

    def _run(self) -> None:
        processed_prompt_ids: set[str] = set()
        server: Optional[Any] = None
        queue: Optional[Any] = None

        while not self._stop_event.is_set():
            if queue is None:
                server, queue = _resolve_prompt_queue()
                if queue is None:
                    self._stop_event.wait(self.poll_interval)
                    continue

            try:
                history = queue.get_history(max_items=self.history_window)
                if not isinstance(history, dict):
                    self._stop_event.wait(self.poll_interval)
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

            self._stop_event.wait(self.poll_interval)


_WATCHER = _HistoryWatcher()


def start_history_watcher(poll_interval: float = _POLL_INTERVAL_SECONDS) -> None:
    """Ensure the background watcher thread is running."""
    _WATCHER.start(poll_interval)
