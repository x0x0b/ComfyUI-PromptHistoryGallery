"""In-memory mapping between executing prompts and stored history entries."""

from __future__ import annotations

import threading
from typing import Dict, List, Optional

_PROMPT_ENTRY_REGISTRY: Dict[str, List[str]] = {}
_REGISTRY_LOCK = threading.Lock()


def register_prompt_entry(prompt_id: Optional[str], entry_id: str) -> None:
    """Track prompt executions so generated files can be linked later."""
    if not prompt_id:
        return
    with _REGISTRY_LOCK:
        bucket = _PROMPT_ENTRY_REGISTRY.setdefault(prompt_id, [])
        bucket.append(entry_id)


def consume_prompt_entries(prompt_id: Optional[str]) -> List[str]:
    """Retrieve and clear pending entries for the given prompt id."""
    if not prompt_id:
        return []
    with _REGISTRY_LOCK:
        return _PROMPT_ENTRY_REGISTRY.pop(prompt_id, [])

