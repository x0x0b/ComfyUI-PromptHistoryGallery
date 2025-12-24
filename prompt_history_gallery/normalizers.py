"""Utility helpers for coercing user input and file payloads."""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

from .models import OutputRecord


def normalize_metadata(raw: Any) -> Dict[str, Any]:
    """
    Ensure metadata is a dictionary; supports list of pairs input.
    """
    if isinstance(raw, dict):
        return dict(raw)

    if isinstance(raw, (list, tuple)):
        result: Dict[str, Any] = {}
        for item in raw:
            if isinstance(item, (list, tuple)) and len(item) == 2 and isinstance(item[0], str):
                result[item[0]] = item[1]
        if result:
            return result
    return {}


def normalize_output_payload(file_info: Any) -> Optional[OutputRecord]:
    """
    Accept loose file payloads from ComfyUI and convert to OutputRecord.
    """
    if isinstance(file_info, str):
        filename = file_info.strip()
        if not filename:
            return None
        return OutputRecord(filename=filename)

    if isinstance(file_info, dict):
        filename_raw = file_info.get("filename")
        if not filename_raw:
            return None
        filename = str(filename_raw).strip()
        if not filename:
            return None
        subfolder = str(file_info.get("subfolder", "") or "").strip()
        output_type = str(file_info.get("type") or file_info.get("kind") or "").strip()
        return OutputRecord(filename=filename, subfolder=subfolder, type=output_type)

    return None


def serialize_metadata(metadata: Dict[str, Any]) -> str:
    return json.dumps(metadata, ensure_ascii=False)
