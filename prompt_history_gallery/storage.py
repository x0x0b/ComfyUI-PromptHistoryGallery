"""
Helpers for persisting prompt history entries using SQLite.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple, TypeVar

from .models import OutputRecord, PromptHistoryEntry
from .normalizers import normalize_metadata, normalize_output_payload
from .serialization import deserialize_metadata, serialize_metadata

LOGGER = logging.getLogger(__name__)

ENTRY_METADATA_KEY = "_phg_entry_metadata"

LEGACY_METADATA_KEYS = ("comfyui_prompt", "comfyui_workflow", "comfyui_params")

_METADATA_COMPACTION_VERSION = 1

GroupKey = Tuple[str, str]


def _default_storage_directory() -> Path:
    """
    Resolve the directory used to store prompt history data.
    Environment variable allows overriding for testing.
    """
    base_dir = os.environ.get("COMFYUI_PROMPT_HISTORY_DIR")
    if base_dir:
        return Path(base_dir).expanduser()
    return Path(__file__).resolve().parent / "data"


def default_storage_directory() -> Path:
    """
    Public accessor for the resolved storage directory.
    """
    return _default_storage_directory()


def _ensure_directory(path: Path) -> None:
    """
    Make sure the directory exists before writing any data.
    """
    path.mkdir(parents=True, exist_ok=True)


T = TypeVar("T")


def _chunked(values: Sequence[T], chunk_size: int) -> Iterator[Sequence[T]]:
    for idx in range(0, len(values), chunk_size):
        yield values[idx : idx + chunk_size]


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

    def _create_entry_locked(
        self,
        cursor: sqlite3.Cursor,
        prompt: str,
        negative_prompt: str,
        metadata: Dict[str, Any],
    ) -> PromptHistoryEntry:
        now_iso = datetime.now(timezone.utc).isoformat()
        entry = PromptHistoryEntry(
            id=str(uuid.uuid4()),
            created_at=now_iso,
            prompt=prompt,
            negative_prompt=negative_prompt,
            metadata=metadata.copy(),
            last_used_at=now_iso,
            files=tuple(),
        )
        cursor.execute(
            """
            INSERT INTO prompt_history
                (id, created_at, last_used_at, prompt, negative_prompt, tags, metadata)
            VALUES
                (:id, :created_at, :last_used_at, :prompt, :negative_prompt, :tags, :metadata)
            """,
            {
                "id": entry.id,
                "created_at": entry.created_at,
                "last_used_at": entry.last_used_at,
                "prompt": entry.prompt,
                "negative_prompt": entry.negative_prompt,
                "tags": "[]",  # Legacy column
                "metadata": serialize_metadata(entry.metadata),
            },
        )
        return entry

    def _find_entry_locked(
        self,
        cursor: sqlite3.Cursor,
        prompt: str,
        negative_prompt: str,
        metadata: Dict[str, Any],
    ) -> Optional[PromptHistoryEntry]:
        """
        Attempt to find an existing entry that matches the provided payload.
        """

        # First try exact match (fast path, though less likely now with ignored keys)
        payload = {
            "prompt": prompt,
            "negative_prompt": negative_prompt,
            "metadata": serialize_metadata(metadata),
        }
        # Note: We ignore tags in search now
        row = cursor.execute(
            """
            SELECT id, created_at, last_used_at, prompt, negative_prompt, metadata
            FROM prompt_history
            WHERE prompt = :prompt
              AND negative_prompt = :negative_prompt
              AND metadata = :metadata
            ORDER BY last_used_at DESC
            LIMIT 1
            """,
            payload,
        ).fetchone()
        if row is not None:
            return PromptHistoryEntry.from_row(row)

        # Fallback: find by prompt and manually check metadata
        fallback_rows = cursor.execute(
            """
            SELECT id, created_at, last_used_at, prompt, negative_prompt, metadata
            FROM prompt_history
            WHERE prompt = ? AND negative_prompt = ?
            ORDER BY last_used_at DESC, created_at DESC
            LIMIT ?
            """,
            (prompt, negative_prompt, self._FALLBACK_LOOKUP_LIMIT),
        ).fetchall()

        for candidate_row in fallback_rows:
            candidate_entry = PromptHistoryEntry.from_row(candidate_row)
            if candidate_entry.metadata == metadata:
                return candidate_entry

        return None

    def append(
        self,
        prompt: str,
        *,
        negative_prompt: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> PromptHistoryEntry:
        """Persist a new entry for the provided prompt text."""
        incoming_metadata = normalize_metadata(metadata)
        with self._locked_cursor(commit=True) as cursor:
            entry = self._create_entry_locked(
                cursor,
                prompt,
                negative_prompt or "",
                incoming_metadata,
            )
        return entry

    def ensure_entry(
        self,
        prompt: str,
        *,
        negative_prompt: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Tuple[PromptHistoryEntry, bool]:
        """
        Retrieve an existing entry that matches the provided payload, or create one.
        Returns the entry and a flag indicating whether it was newly created.
        """
        incoming_metadata = normalize_metadata(metadata)
        normalized_negative = negative_prompt or ""
        with self._locked_cursor(commit=True) as cursor:
            existing = self._find_entry_locked(
                cursor, prompt, normalized_negative, incoming_metadata
            )
            if existing is not None:
                return existing, False
            entry = self._create_entry_locked(
                cursor, prompt, normalized_negative, incoming_metadata
            )
            return entry, True

    def update_metadata(self, entry_id: str, metadata_update: Dict[str, Any]) -> None:
        """
        Update the metadata of an existing entry.
        """
        if not entry_id or not metadata_update:
            return

        with self._locked_cursor(commit=True) as cursor:
            row = cursor.execute(
                "SELECT metadata FROM prompt_history WHERE id = ?", (entry_id,)
            ).fetchone()
            if not row:
                return

            current_metadata = deserialize_metadata(row["metadata"])
            # Only update if there are changes
            changed = False
            for k, v in metadata_update.items():
                if current_metadata.get(k) != v:
                    current_metadata[k] = v
                    changed = True

            if changed:
                cursor.execute(
                    "UPDATE prompt_history SET metadata = ? WHERE id = ?",
                    (serialize_metadata(current_metadata), entry_id),
                )

    def list(self, limit: Optional[int] = None) -> List[PromptHistoryEntry]:
        """
        Return stored entries grouped by prompt text, ordered by recent use.
        """
        sql = (
            "SELECT id, created_at, last_used_at, prompt, negative_prompt, metadata "
            "FROM ("
            "SELECT id, created_at, last_used_at, prompt, negative_prompt, metadata, "
            "ROW_NUMBER() OVER ("
            "PARTITION BY prompt, negative_prompt "
            "ORDER BY last_used_at DESC, created_at DESC, id DESC"
            ") AS row_rank "
            "FROM prompt_history"
            ") "
            "WHERE row_rank = 1 "
            "ORDER BY last_used_at DESC, created_at DESC"
        )
        if limit is not None:
            sql += " LIMIT ?"
            params = (limit,)
        else:
            params = ()
        with self._locked_cursor() as cursor:
            rows = cursor.execute(sql, params).fetchall()
            group_keys = [(row["prompt"], row["negative_prompt"]) for row in rows]
            outputs_map = self._fetch_outputs_by_prompt(cursor, group_keys) if group_keys else {}
            entry_ids = {
                record.get("entry_id")
                for records in outputs_map.values()
                for record in records
                if isinstance(record, dict) and record.get("entry_id")
            }
            metadata_map = (
                self._fetch_metadata_by_entry_ids(cursor, sorted(entry_ids)) if entry_ids else {}
            )
        entries: List[PromptHistoryEntry] = []
        for row in rows:
            files = tuple(outputs_map.get((row["prompt"], row["negative_prompt"]), []))
            entry = PromptHistoryEntry.from_row(row, files)
            if metadata_map and files:
                prompt_entry_ids = {
                    record.get("entry_id")
                    for record in files
                    if isinstance(record, dict) and record.get("entry_id")
                }
                if prompt_entry_ids:
                    entry.metadata[ENTRY_METADATA_KEY] = {
                        entry_id: metadata_map[entry_id]
                        for entry_id in prompt_entry_ids
                        if entry_id in metadata_map
                    }
            entries.append(entry)
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

    def find_entry_ids_for_prompt_pairs(self, pairs: Sequence[GroupKey]) -> List[str]:
        """
        Resolve prompt/negative pairs to the most recently used entry id of each.
        """
        wanted = {
            (prompt, negative or "")
            for prompt, negative in pairs
            if isinstance(prompt, str) and prompt
        }
        if not wanted:
            return []

        resolved: List[str] = []
        seen: set = set()
        prompts = sorted({prompt for prompt, _ in wanted})

        with self._locked_cursor() as cursor:
            for chunk in _chunked(prompts, 900):
                placeholders = ",".join(["?"] * len(chunk))
                sql = (
                    "SELECT prompt, negative_prompt, id FROM prompt_history "
                    f"WHERE prompt IN ({placeholders}) "
                    "ORDER BY last_used_at DESC, created_at DESC"
                )
                for row in cursor.execute(sql, tuple(chunk)):
                    key = (row["prompt"], row["negative_prompt"] or "")
                    if key in wanted and key not in seen:
                        seen.add(key)
                        resolved.append(row["id"])

        return resolved

    def _fetch_outputs_by_prompt(
        self, cursor: sqlite3.Cursor, group_keys: Sequence[GroupKey]
    ) -> Dict[GroupKey, List[Dict[str, Any]]]:
        if not group_keys:
            return {}

        outputs: Dict[GroupKey, List[OutputRecord]] = {key: [] for key in group_keys}
        wanted = set(group_keys)
        prompts = sorted({prompt for prompt, _ in wanted})
        chunk_size = 900

        for chunk in _chunked(prompts, chunk_size):
            placeholders = ",".join(["?"] * len(chunk))
            sql = (
                "SELECT p.prompt, p.negative_prompt, o.entry_id, o.filename, o.subfolder, o.type "
                "FROM prompt_history_output o "
                "JOIN prompt_history p ON p.id = o.entry_id "
                f"WHERE p.prompt IN ({placeholders}) ORDER BY o.id"
            )
            rows = cursor.execute(sql, tuple(chunk)).fetchall()
            for row in rows:
                key = (row["prompt"], row["negative_prompt"] or "")
                if key not in wanted:
                    continue
                record: Dict[str, Any] = {"filename": row["filename"]}
                if row["subfolder"]:
                    record["subfolder"] = row["subfolder"]
                if row["type"]:
                    record["type"] = row["type"]
                if row["entry_id"]:
                    record["entry_id"] = row["entry_id"]
                outputs.setdefault(key, []).append(record)

        return outputs

    def _fetch_metadata_by_entry_ids(
        self, cursor: sqlite3.Cursor, entry_ids: Sequence[str]
    ) -> Dict[str, Dict[str, Any]]:
        if not entry_ids:
            return {}

        metadata_map: Dict[str, Dict[str, Any]] = {}
        chunk_size = 900

        for chunk in _chunked(entry_ids, chunk_size):
            placeholders = ",".join(["?"] * len(chunk))
            sql = f"SELECT id, metadata FROM prompt_history WHERE id IN ({placeholders})"
            rows = cursor.execute(sql, tuple(chunk)).fetchall()
            for row in rows:
                metadata_map[row["id"]] = deserialize_metadata(row["metadata"])

        return metadata_map

    def delete(self, entry_id: str) -> bool:
        """
        Delete all entries matching the prompt pair of the supplied entry id.
        Returns True if any rows were removed.
        """
        with self._locked_cursor(commit=True) as cursor:
            row = cursor.execute(
                "SELECT prompt, negative_prompt FROM prompt_history WHERE id = ?", (entry_id,)
            ).fetchone()
            if not row:
                return False
            cursor.execute(
                "DELETE FROM prompt_history WHERE prompt = ? AND negative_prompt = ?",
                (row["prompt"], row["negative_prompt"]),
            )
            return cursor.rowcount > 0

    def clear(self) -> None:
        """
        Remove all stored entries.

        Deliberately leaves ``prompt_history_settings`` alone: clearing history
        must not reset the user's preferences.
        """
        with self._locked_cursor(commit=True) as cursor:
            cursor.execute("DELETE FROM prompt_history_output")
            cursor.execute("DELETE FROM prompt_history")

    def get_setting(self, key: str) -> Optional[str]:
        """
        Read a runtime setting. Returns None when it was never written, which
        lets callers fall back to their own default.
        """
        with self._locked_cursor() as cursor:
            row = cursor.execute(
                "SELECT value FROM prompt_history_settings WHERE key = ?", (key,)
            ).fetchone()
        return row["value"] if row is not None else None

    def set_setting(self, key: str, value: str) -> None:
        """
        Persist a runtime setting.
        """
        with self._locked_cursor(commit=True) as cursor:
            cursor.execute(
                """
                INSERT INTO prompt_history_settings (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (key, value),
            )

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
                    negative_prompt TEXT NOT NULL DEFAULT '',
                    tags TEXT NOT NULL,
                    metadata TEXT NOT NULL
                )
                """
            )
            existing_columns = {
                row["name"] for row in cursor.execute("PRAGMA table_info(prompt_history)")
            }
            if "negative_prompt" not in existing_columns:
                cursor.execute(
                    "ALTER TABLE prompt_history ADD COLUMN negative_prompt TEXT NOT NULL DEFAULT ''"
                )
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
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS prompt_history_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
            cursor.execute("DROP INDEX IF EXISTS idx_prompt_history_prompt_unique")
            # Speeds up the ROW_NUMBER() window used by list() and the prompt
            # join in _fetch_outputs_by_prompt.
            cursor.execute("DROP INDEX IF EXISTS idx_prompt_history_prompt_recent")
            cursor.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_prompt_history_group_recent
                ON prompt_history (prompt, negative_prompt, last_used_at DESC, created_at DESC)
                """
            )
            compacted = self._compact_legacy_metadata(cursor)

        if compacted:
            try:
                with self._locked_cursor(commit=True) as cursor:
                    cursor.execute("VACUUM")
                    cursor.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except sqlite3.Error:
                LOGGER.warning(
                    "Could not reclaim space after compacting prompt history metadata",
                    exc_info=True,
                )

    def _compact_legacy_metadata(self, cursor: sqlite3.Cursor) -> bool:
        """
        Drop workflow payloads that older releases wrote into metadata.

        Guarded by ``PRAGMA user_version`` so upgrading rewrites the table only
        once. Rows are rewritten through the regular serializer, so anything
        that is not a known legacy key (the node identifier, or keys added by
        future versions) survives untouched.

        Returns True when at least one row was rewritten.
        """
        if cursor.execute("PRAGMA user_version").fetchone()[0] >= _METADATA_COMPACTION_VERSION:
            return False

        rows = cursor.execute("SELECT id, metadata FROM prompt_history").fetchall()
        freed = 0
        compacted = 0

        for row in rows:
            metadata = deserialize_metadata(row["metadata"])
            if not any(key in metadata for key in LEGACY_METADATA_KEYS):
                continue

            before = len(row["metadata"] or "")
            for key in LEGACY_METADATA_KEYS:
                metadata.pop(key, None)
            stripped = serialize_metadata(metadata)
            cursor.execute(
                "UPDATE prompt_history SET metadata = ? WHERE id = ?",
                (stripped, row["id"]),
            )
            freed += max(0, before - len(stripped))
            compacted += 1

        cursor.execute(f"PRAGMA user_version = {_METADATA_COMPACTION_VERSION}")

        if compacted:
            LOGGER.info(
                "Compacted %s prompt history entries, releasing %s bytes of workflow metadata",
                compacted,
                freed,
            )
        return compacted > 0


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
