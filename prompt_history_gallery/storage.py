"""
Helpers for persisting prompt history entries using SQLite.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple

from .models import OutputRecord, PromptHistoryEntry
from .normalizers import (
    normalize_metadata,
    normalize_output_payload,
    normalize_tags,
    serialize_metadata,
    serialize_tags,
)


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


def _format_output_record(filename: str, subfolder: str, output_type: str) -> OutputRecord:
    return OutputRecord(filename=filename, subfolder=subfolder, type=output_type)


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

    @contextmanager
    def _locked_cursor(self, *, commit: bool = False) -> Iterator[sqlite3.Cursor]:
        """
        Provide a cursor guarded by the storage lock.
        Optionally commits the transaction on successful exit.
        """
        with self._lock:
            cursor = self._connection.cursor()
            try:
                yield cursor
                if commit:
                    self._connection.commit()
            except Exception:
                if commit:
                    self._connection.rollback()
                raise

    def _row_to_entry(
        self,
        row: sqlite3.Row,
        files: Sequence[Any] = (),
    ) -> PromptHistoryEntry:
        tags = json.loads(row["tags"]) if row["tags"] else []
        metadata = json.loads(row["metadata"]) if row["metadata"] else {}
        normalized_files: Tuple[Dict[str, Any], ...] = tuple(
            item.to_dict() if isinstance(item, OutputRecord) else dict(item) for item in files
        )
        return PromptHistoryEntry(
            id=row["id"],
            created_at=row["created_at"],
            prompt=row["prompt"],
            tags=tags,
            metadata=metadata,
            last_used_at=row["last_used_at"],
            files=normalized_files,
        )

    def _create_entry_locked(
        self,
        cursor: sqlite3.Cursor,
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
                "tags": serialize_tags(entry.tags),
                "metadata": serialize_metadata(entry.metadata),
            },
        )
        return entry

    def _find_entry_locked(
        self,
        cursor: sqlite3.Cursor,
        prompt: str,
        tags: List[str],
        metadata: Dict[str, Any],
    ) -> Optional[PromptHistoryEntry]:
        """
        Attempt to find an existing entry that matches the provided payload.
        """
        payload = {
            "prompt": prompt,
            "tags": serialize_tags(tags),
            "metadata": serialize_metadata(metadata),
        }
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
        incoming_tags = normalize_tags(tags)
        incoming_metadata = normalize_metadata(metadata)
        with self._locked_cursor(commit=True) as cursor:
            entry = self._create_entry_locked(
                cursor,
                prompt,
                incoming_tags,
                incoming_metadata,
            )
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
        incoming_tags = normalize_tags(tags)
        incoming_metadata = normalize_metadata(metadata)
        with self._locked_cursor(commit=True) as cursor:
            existing = self._find_entry_locked(cursor, prompt, incoming_tags, incoming_metadata)
            if existing is not None:
                return existing, False
            entry = self._create_entry_locked(cursor, prompt, incoming_tags, incoming_metadata)
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
        with self._locked_cursor() as cursor:
            rows = cursor.execute(sql, params).fetchall()
            entry_ids = [row["id"] for row in rows]
            outputs_map = self._fetch_outputs(cursor, entry_ids) if entry_ids else {}
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

        normalized: List[OutputRecord] = []
        for file_info in files:
            payload = normalize_output_payload(file_info)
            if payload:
                normalized.append(payload)

        if not normalized:
            return

        targets = [str(entry_id) for entry_id in entry_ids if entry_id]
        if not targets:
            return

        with self._locked_cursor(commit=True) as cursor:
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
                            "filename": item.filename,
                            "subfolder": item.subfolder,
                            "type": item.type,
                        },
                    )

    def touch_entries(self, entry_ids: Sequence[str]) -> None:
        targets = [str(entry_id) for entry_id in entry_ids if entry_id]
        if not targets:
            return
        timestamp = datetime.now(timezone.utc).isoformat()
        with self._locked_cursor(commit=True) as cursor:
            cursor.executemany(
                "UPDATE prompt_history SET last_used_at = ? WHERE id = ?",
                [(timestamp, entry_id) for entry_id in targets],
            )

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

        with self._locked_cursor() as cursor:
            rows = cursor.execute(sql, tuple(candidates)).fetchall()

        mapping: Dict[str, str] = {}
        for row in rows:
            prompt = row["prompt"]
            if prompt not in mapping:
                mapping[prompt] = row["id"]

        return mapping

    def _fetch_outputs(
        self, cursor: sqlite3.Cursor, entry_ids: Sequence[str]
    ) -> Dict[str, List[OutputRecord]]:
        if not entry_ids:
            return {}

        placeholders = ",".join(["?"] * len(entry_ids))
        sql = (
            "SELECT entry_id, filename, subfolder, type FROM prompt_history_output "
            f"WHERE entry_id IN ({placeholders}) ORDER BY id"
        )

        rows = cursor.execute(sql, tuple(entry_ids)).fetchall()

        outputs: Dict[str, List[OutputRecord]] = {}
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
        with self._locked_cursor(commit=True) as cursor:
            cursor.execute(
                "DELETE FROM prompt_history_output WHERE entry_id = ?",
                (entry_id,),
            )
            cursor.execute("DELETE FROM prompt_history WHERE id = ?", (entry_id,))
            return cursor.rowcount > 0

    def clear(self) -> None:
        """
        Remove all stored entries.
        """
        with self._locked_cursor(commit=True) as cursor:
            cursor.execute("DELETE FROM prompt_history_output")
            cursor.execute("DELETE FROM prompt_history")

    def _configure_database(self) -> None:
        """
        Initialize SQLite with the required schema.
        """
        with self._locked_cursor(commit=True) as cursor:
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
                row["name"] for row in cursor.execute("PRAGMA table_info(prompt_history)")
            }
            if "last_used_at" not in existing_columns:
                cursor.execute("ALTER TABLE prompt_history ADD COLUMN last_used_at TEXT")
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
            cursor.execute("DROP INDEX IF EXISTS idx_prompt_history_prompt_unique")


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
