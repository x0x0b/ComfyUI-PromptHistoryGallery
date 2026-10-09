"""
Core package for the Prompt History Gallery extension.
"""

from .history_watcher import start_history_watcher as _start_history_watcher
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .settings import set_capture_enabled
from .storage import get_prompt_history_storage

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "get_prompt_history_storage",
    "set_capture_enabled",
]

_start_history_watcher()
