"""
Helpers for persisting prompt history entries using SQLite.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple


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
    last_used_at: str
    files: Tuple[Dict[str, Any], ...] = field(default_factory=tuple)

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
            "last_used_at": self.last_used_at,
            "files": [item.copy() for item in self.files],
        }


def _normalize_output_payload(file_info: Any) -> Optional[Dict[str, str]]:
    if isinstance(file_info, str):
        filename = file_info.strip()
        if not filename:
            return None
        return {"filename": filename, "subfolder": "", "type": ""}

    if isinstance(file_info, dict):
        filename_raw = file_info.get("filename")
        if not filename_raw:
            return None
        filename = str(filename_raw).strip()
        if not filename:
            return None
        subfolder = str(file_info.get("subfolder", "") or "").strip()
        output_type = str(
            file_info.get("type")
            or file_info.get("kind")
            or ""
        ).strip()
        return {
            "filename": filename,
            "subfolder": subfolder,
            "type": output_type,
        }

    return None


def _format_output_record(
    filename: str, subfolder: str, output_type: str
) -> Dict[str, Any]:
    record: Dict[str, Any] = {"filename": filename}
    if subfolder:
        record["subfolder"] = subfolder
    if output_type:
        record["type"] = output_type
    return record


class PromptHistoryStorage:
    """
    SQLite-backed storage with coarse locking to prevent corruption.
    """

    _FALLBACK_LOOKUP_LIMIT = 25

    def __init__(self, storage_file: Optional[Path] = None) -> None:
        if storage_file is None:
            storage_file = _default_storage_directory() / "prompt_history.db"
        self._file_path = storage_file
        _ensure_directory(self._file_path.parent)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(self._file_path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA foreign_keys = ON;")
        self._configure_database()

    def _row_to_entry(
        self,
        row: sqlite3.Row,
        files: Sequence[Dict[str, Any]] = (),
    ) -> PromptHistoryEntry:
        tags = json.loads(row["tags"]) if row["tags"] else []
        metadata = json.loads(row["metadata"]) if row["metadata"] else {}
        return PromptHistoryEntry(
            id=row["id"],
            created_at=row["created_at"],
            prompt=row["prompt"],
            tags=tags,
            metadata=metadata,
            last_used_at=row["last_used_at"],
            files=tuple(files),
        )

    def _create_entry_locked(
        self,
        prompt: str,
        tags: List[str],
        metadata: Dict[str, Any],
    ) -> PromptHistoryEntry:
        now_iso = datetime.now(timezone.utc).isoformat()
        entry = PromptHistoryEntry(
            id=str(uuid.uuid4()),
            created_at=now_iso,
            prompt=prompt,
            tags=list(tags),
            metadata=metadata.copy(),
            last_used_at=now_iso,
            files=tuple(),
        )
        cursor = self._connection.cursor()
        cursor.execute(
            """
            INSERT INTO prompt_history (id, created_at, last_used_at, prompt, tags, metadata)
            VALUES (:id, :created_at, :last_used_at, :prompt, :tags, :metadata)
            """,
            {
                "id": entry.id,
                "created_at": entry.created_at,
                "last_used_at": entry.last_used_at,
                "prompt": entry.prompt,
                "tags": json.dumps(entry.tags, ensure_ascii=False),
                "metadata": json.dumps(entry.metadata, ensure_ascii=False),
            },
        )
        return entry

    def _find_entry_locked(
        self,
        prompt: str,
        tags: List[str],
        metadata: Dict[str, Any],
    ) -> Optional[PromptHistoryEntry]:
        """
        Attempt to find an existing entry that matches the provided payload.
        """
        payload = {
            "prompt": prompt,
            "tags": json.dumps(tags, ensure_ascii=False),
            "metadata": json.dumps(metadata, ensure_ascii=False),
        }
        cursor = self._connection.cursor()
        row = cursor.execute(
            """
            SELECT id, created_at, last_used_at, prompt, tags, metadata
            FROM prompt_history
            WHERE prompt = :prompt AND tags = :tags AND metadata = :metadata
            ORDER BY last_used_at DESC
            LIMIT 1
            """,
            payload,
        ).fetchone()
        if row is not None:
            return self._row_to_entry(row)

        fallback_rows = cursor.execute(
            """
            SELECT id, created_at, last_used_at, prompt, tags, metadata
            FROM prompt_history
            WHERE prompt = ?
            ORDER BY last_used_at DESC, created_at DESC
            LIMIT ?
            """,
            (prompt, self._FALLBACK_LOOKUP_LIMIT),
        ).fetchall()
        for candidate in fallback_rows:
            entry = self._row_to_entry(candidate)
            if entry.tags == tags and entry.metadata == metadata:
                return entry
        return None

    def append(
        self,
        prompt: str,
        *,
        tags: List[str],
        metadata: Optional[Dict[str, Any]] = None,
    ) -> PromptHistoryEntry:
        """Persist a new entry for the provided prompt text."""
        incoming_tags = list(tags)
        incoming_metadata = metadata.copy() if metadata else {}
        with self._lock:
            entry = self._create_entry_locked(prompt, incoming_tags, incoming_metadata)
            self._connection.commit()
        return entry

    def ensure_entry(
        self,
        prompt: str,
        *,
        tags: List[str],
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Tuple[PromptHistoryEntry, bool]:
        """
        Retrieve an existing entry that matches the provided payload, or create one.
        Returns the entry and a flag indicating whether it was newly created.
        """
        incoming_tags = list(tags)
        incoming_metadata = metadata.copy() if metadata else {}
        with self._lock:
            existing = self._find_entry_locked(prompt, incoming_tags, incoming_metadata)
            if existing is not None:
                return existing, False
            entry = self._create_entry_locked(prompt, incoming_tags, incoming_metadata)
            self._connection.commit()
            return entry, True

    def list(self, limit: Optional[int] = None) -> List[PromptHistoryEntry]:
        """
        Return stored entries ordered by creation date descending.
        """
        sql = (
            "SELECT id, created_at, last_used_at, prompt, tags, metadata "
            "FROM prompt_history ORDER BY last_used_at DESC, created_at DESC"
        )
        if limit is not None:
            sql += " LIMIT ?"
            params = (limit,)
        else:
            params = ()
        with self._lock:
            rows = self._connection.execute(sql, params).fetchall()
        entry_ids = [row["id"] for row in rows]
        outputs_map = self._fetch_outputs(entry_ids) if entry_ids else {}
        entries: List[PromptHistoryEntry] = []
        for row in rows:
            files = tuple(outputs_map.get(row["id"], []))
            entries.append(self._row_to_entry(row, files))
        return entries

    def add_outputs_for_entries(
        self,
        entry_ids: Sequence[str],
        files: Sequence[Any],
    ) -> None:
        """Persist generated file metadata for related prompt entries."""

        normalized: List[Dict[str, str]] = []
        for file_info in files:
            payload = _normalize_output_payload(file_info)
            if payload:
                normalized.append(payload)

        if not normalized:
            return

        targets = [str(entry_id) for entry_id in entry_ids if entry_id]
        if not targets:
            return

        with self._lock:
            cursor = self._connection.cursor()
            for entry_id in targets:
                for item in normalized:
                    cursor.execute(
                        """
                        INSERT OR IGNORE INTO prompt_history_output
                            (entry_id, filename, subfolder, type)
                        VALUES
                            (:entry_id, :filename, :subfolder, :type)
                        """,
                        {
                            "entry_id": entry_id,
                            "filename": item["filename"],
                            "subfolder": item["subfolder"],
                            "type": item["type"],
                        },
                    )
            self._connection.commit()

    def touch_entries(self, entry_ids: Sequence[str]) -> None:
        targets = [str(entry_id) for entry_id in entry_ids if entry_id]
        if not targets:
            return
        timestamp = datetime.now(timezone.utc).isoformat()
        with self._lock:
            self._connection.executemany(
                "UPDATE prompt_history SET last_used_at = ? WHERE id = ?",
                [(timestamp, entry_id) for entry_id in targets],
            )
            self._connection.commit()

    def find_entry_ids_for_prompts(self, prompts: Sequence[str]) -> Dict[str, str]:
        candidates = [str(p) for p in prompts if isinstance(p, str) and p]
        if not candidates:
            return {}

        placeholders = ",".join(["?"] * len(candidates))
        sql = (
            "SELECT prompt, id FROM prompt_history WHERE prompt IN ("
            + placeholders
            + ") ORDER BY created_at DESC"
        )

        with self._lock:
            rows = self._connection.execute(sql, tuple(candidates)).fetchall()

        mapping: Dict[str, str] = {}
        for row in rows:
            prompt = row["prompt"]
            if prompt not in mapping:
                mapping[prompt] = row["id"]

        return mapping

    def _fetch_outputs(
        self, entry_ids: Sequence[str]
    ) -> Dict[str, List[Dict[str, Any]]]:
        if not entry_ids:
            return {}

        placeholders = ",".join(["?"] * len(entry_ids))
        sql = (
            "SELECT entry_id, filename, subfolder, type FROM prompt_history_output "
            f"WHERE entry_id IN ({placeholders}) ORDER BY id"
        )

        with self._lock:
            rows = self._connection.execute(sql, tuple(entry_ids)).fetchall()

        outputs: Dict[str, List[Dict[str, Any]]] = {}
        for entry_id in entry_ids:
            outputs.setdefault(entry_id, [])

        for row in rows:
            entry_id = row["entry_id"]
            record = _format_output_record(
                row["filename"],
                row["subfolder"],
                row["type"],
            )
            outputs.setdefault(entry_id, []).append(record)

        return outputs

    def delete(self, entry_id: str) -> bool:
        """
        Delete a single entry by id. Returns True if a row was removed.
        """
        with self._lock:
            self._connection.execute(
                "DELETE FROM prompt_history_output WHERE entry_id = ?",
                (entry_id,),
            )
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
            self._connection.execute("DELETE FROM prompt_history_output")
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
                    last_used_at TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    tags TEXT NOT NULL,
                    metadata TEXT NOT NULL
                )
                """
            )
            existing_columns = {
                row["name"]
                for row in cursor.execute("PRAGMA table_info(prompt_history)")
            }
            if "last_used_at" not in existing_columns:
                cursor.execute(
                    "ALTER TABLE prompt_history ADD COLUMN last_used_at TEXT"
                )
                cursor.execute(
                    """
                    UPDATE prompt_history
                    SET last_used_at = COALESCE(last_used_at, created_at)
                    """
                )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS prompt_history_output (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    entry_id TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    subfolder TEXT NOT NULL DEFAULT '',
                    type TEXT NOT NULL DEFAULT '',
                    UNIQUE(entry_id, filename, subfolder, type),
                    FOREIGN KEY(entry_id) REFERENCES prompt_history(id) ON DELETE CASCADE
                )
                """
            )
            cursor.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_prompt_history_output_entry
                ON prompt_history_output (entry_id)
                """
            )
            cursor.execute(
                "DROP INDEX IF EXISTS idx_prompt_history_prompt_unique"
            )
            self._connection.commit()


_STORAGE_INSTANCE: Optional[PromptHistoryStorage] = None
_INSTANCE_LOCK = threading.Lock()

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
