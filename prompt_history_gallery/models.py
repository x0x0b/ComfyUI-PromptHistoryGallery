"""Data structures shared across the prompt history extension."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, Sequence, Tuple


@dataclass(frozen=True)
class PromptHistoryEntry:
    """Serializable prompt history item."""

    id: str
    created_at: str
    prompt: str
    metadata: Dict[str, Any]
    last_used_at: str
    files: Tuple[Dict[str, Any], ...] = field(default_factory=tuple)

    @classmethod
    def from_row(
        cls,
        row: Any,
        files: Sequence[Any] = (),
    ) -> "PromptHistoryEntry":
        metadata_raw = row["metadata"]

        if isinstance(metadata_raw, str):
            metadata = json.loads(metadata_raw) if metadata_raw else {}
        elif isinstance(metadata_raw, dict):
            metadata = dict(metadata_raw)
        else:
            metadata = {}
        normalized_files: Tuple[Dict[str, Any], ...] = tuple(
            item.to_dict() if hasattr(item, "to_dict") else dict(item) for item in files
        )
        return cls(
            id=row["id"],
            created_at=row["created_at"],
            prompt=row["prompt"],
            metadata=metadata,
            last_used_at=row["last_used_at"],
            files=normalized_files,
        )

    def to_dict(self) -> Dict[str, Any]:
        """Convert the dataclass into a JSON serialisable dictionary."""
        return {
            "id": self.id,
            "created_at": self.created_at,
            "prompt": self.prompt,
            "metadata": self.metadata.copy(),
            "last_used_at": self.last_used_at,
            "files": [item.copy() for item in self.files],
        }


@dataclass(frozen=True)
class OutputRecord:
    """Normalized representation of a generated file linked to a prompt entry."""

    filename: str
    subfolder: str = ""
    type: str = ""

    def to_dict(self) -> Dict[str, str]:
        payload: Dict[str, str] = {"filename": self.filename}
        if self.subfolder:
            payload["subfolder"] = self.subfolder
        if self.type:
            payload["type"] = self.type
        return payload
