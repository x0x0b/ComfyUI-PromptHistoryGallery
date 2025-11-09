"""
Core package for the Prompt History Gallery extension.
"""

from .storage import get_prompt_history_storage  # re-export for convenience
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .history_watcher import start_history_watcher as _start_history_watcher

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "get_prompt_history_storage",
]

_start_history_watcher()
