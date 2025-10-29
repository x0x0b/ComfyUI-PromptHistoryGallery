"""
Helpers for persisting prompt history entries using SQLite.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def _default_storage_directory() -> Path:
    """
    Resolve the directory used to store prompt history data.
    Environment variable allows overriding for testing.
    """
    base_dir = os.environ.get("COMFYUI_PROMPT_HISTORY_DIR")
    if base_dir:
        return Path(base_dir).expanduser()
    return Path(__file__).resolve().parent / "data"


def _ensure_directory(path: Path) -> None:
    """
    Make sure the directory exists before writing any data.
    """
    path.mkdir(parents=True, exist_ok=True)


@dataclass(frozen=True)
class PromptHistoryEntry:
    """
    Serializable prompt history item.
    """

    id: str
    created_at: str
    prompt: str
    tags: List[str]
    metadata: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        """
        Convert the dataclass into a JSON serialisable dictionary.
        """
        return {
            "id": self.id,
            "created_at": self.created_at,
            "prompt": self.prompt,
            "tags": list(self.tags),
            "metadata": self.metadata.copy(),
        }


class PromptHistoryStorage:
    """
    SQLite-backed storage with coarse locking to prevent corruption.
    """

    def __init__(self, storage_file: Optional[Path] = None) -> None:
        if storage_file is None:
            storage_file = _default_storage_directory() / "prompt_history.db"
        self._file_path = storage_file
        _ensure_directory(self._file_path.parent)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(self._file_path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._configure_database()

    def append(
        self,
        prompt: str,
        *,
        tags: List[str],
        metadata: Optional[Dict[str, Any]] = None,
    ) -> PromptHistoryEntry:
        """
        Persist a new entry and return it for optional downstream use.
        """
        entry = PromptHistoryEntry(
            id=str(uuid.uuid4()),
            created_at=datetime.now(timezone.utc).isoformat(),
            prompt=prompt,
            tags=list(tags),
            metadata=metadata.copy() if metadata else {},
        )
        encoded_tags = json.dumps(entry.tags, ensure_ascii=False)
        encoded_metadata = json.dumps(entry.metadata, ensure_ascii=False)
        with self._lock:
            cursor = self._connection.cursor()
            cursor.execute(
                """
                INSERT INTO prompt_history (id, created_at, prompt, tags, metadata)
                VALUES (:id, :created_at, :prompt, :tags, :metadata)
                """,
                {
                    "id": entry.id,
                    "created_at": entry.created_at,
                    "prompt": entry.prompt,
                    "tags": encoded_tags,
                    "metadata": encoded_metadata,
                },
            )
            self._connection.commit()
        return entry

    def list(self, limit: Optional[int] = None) -> List[PromptHistoryEntry]:
        """
        Return stored entries ordered by creation date descending.
        """
        sql = "SELECT id, created_at, prompt, tags, metadata FROM prompt_history ORDER BY created_at DESC"
        if limit is not None:
            sql += " LIMIT ?"
            params = (limit,)
        else:
            params = ()
        with self._lock:
            rows = self._connection.execute(sql, params).fetchall()
        entries: List[PromptHistoryEntry] = []
        for row in rows:
            tags = json.loads(row["tags"]) if row["tags"] else []
            metadata = json.loads(row["metadata"]) if row["metadata"] else {}
            entries.append(
                PromptHistoryEntry(
                    id=row["id"],
                    created_at=row["created_at"],
                    prompt=row["prompt"],
                    tags=tags,
                    metadata=metadata,
                )
            )
        return entries

    def delete(self, entry_id: str) -> bool:
        """
        Delete a single entry by id. Returns True if a row was removed.
        """
        with self._lock:
            cursor = self._connection.execute(
                "DELETE FROM prompt_history WHERE id = ?", (entry_id,)
            )
            self._connection.commit()
            return cursor.rowcount > 0

    def clear(self) -> None:
        """
        Remove all stored entries.
        """
        with self._lock:
            self._connection.execute("DELETE FROM prompt_history")
            self._connection.commit()

    def _configure_database(self) -> None:
        """
        Initialize SQLite with the required schema.
        """
        with self._lock:
            cursor = self._connection.cursor()
            cursor.execute("PRAGMA journal_mode=WAL;")
            cursor.execute("PRAGMA synchronous=NORMAL;")
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS prompt_history (
                    id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    tags TEXT NOT NULL,
                    metadata TEXT NOT NULL
                )
                """
            )
            self._connection.commit()


_STORAGE_INSTANCE: Optional[PromptHistoryStorage] = None
_INSTANCE_LOCK = threading.Lock()


def get_prompt_history_storage() -> PromptHistoryStorage:
    """
    Retrieve a module-level singleton storage.
    """
    global _STORAGE_INSTANCE
    if _STORAGE_INSTANCE is None:
        with _INSTANCE_LOCK:
            if _STORAGE_INSTANCE is None:
                _STORAGE_INSTANCE = PromptHistoryStorage()
    return _STORAGE_INSTANCE
