"""Shared helpers for serializing prompt history metadata."""

from __future__ import annotations

import json
from typing import Any, Dict


def serialize_metadata(metadata: Dict[str, Any]) -> str:
    """Serialize metadata dict to JSON for storage."""
    return json.dumps(metadata, ensure_ascii=False, sort_keys=True)


def deserialize_metadata(raw: Any) -> Dict[str, Any]:
    """Coerce stored metadata into a dictionary."""
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, str):
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            return {}
        return dict(parsed) if isinstance(parsed, dict) else {}
    return {}
