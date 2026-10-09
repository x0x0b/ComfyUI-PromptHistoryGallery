"""Runtime toggles the sidebar can flip without restarting ComfyUI.

Values live in the storage database rather than in memory so an upgraded
restart keeps honouring the user's last choice.
"""

from __future__ import annotations

from .storage import get_prompt_history_storage

CAPTURE_HISTORY_KEY = "capture_history"

DEFAULT_CAPTURE_HISTORY = True

_ENABLED = "1"
_DISABLED = "0"


def is_capture_enabled() -> bool:
    """
    Report whether finished runs should be written to history.

    Read from the database on every call instead of being cached: the lookup is
    a primary-key hit, and a module-level cache would go stale for a process
    that never handles the write itself.
    """
    raw = get_prompt_history_storage().get_setting(CAPTURE_HISTORY_KEY)
    if raw is None:
        return DEFAULT_CAPTURE_HISTORY
    return raw == _ENABLED


def set_capture_enabled(enabled: bool) -> None:
    """
    Persist the recording toggle.
    """
    get_prompt_history_storage().set_setting(
        CAPTURE_HISTORY_KEY, _ENABLED if enabled else _DISABLED
    )


__all__ = [
    "CAPTURE_HISTORY_KEY",
    "DEFAULT_CAPTURE_HISTORY",
    "is_capture_enabled",
    "set_capture_enabled",
]
