"""
Helper to extract metadata (prompt, workflow) from generated images.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional

from PIL import Image

try:
    import folder_paths
except ImportError:
    folder_paths = None


def get_image_path(filename: str, subfolder: str, folder_type: str) -> Optional[str]:
    """Resolve absolute path for a ComfyUI image file."""
    if folder_paths is None:
        return None

    if folder_type == "output":
        base_dir = folder_paths.get_output_directory()
    elif folder_type == "temp":
        base_dir = folder_paths.get_temp_directory()
    elif folder_type == "input":
        base_dir = folder_paths.get_input_directory()
    else:
        return None

    if subfolder:
        return os.path.join(base_dir, subfolder, filename)
    return os.path.join(base_dir, filename)


def _coerce_text(value: Any) -> Any:
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except Exception:
            return value.decode("latin-1", errors="replace")
    return value


def parse_image_metadata(image_path: str) -> Dict[str, Any]:
    """
    Read ComfyUI metadata (prompt, workflow) from a PNG file.
    """
    if not image_path or not os.path.exists(image_path):
        return {}

    metadata: Dict[str, Any] = {}
    try:
        with Image.open(image_path) as img:
            info: Dict[str, Any] = {}
            if img.info:
                info.update(img.info)
            if hasattr(img, "text") and isinstance(img.text, dict):
                info.update(img.text)

            info = {k: _coerce_text(v) for k, v in info.items()}

            # ComfyUI saves the API prompt in "prompt"
            if "prompt" in info:
                try:
                    metadata["comfyui_prompt"] = json.loads(info["prompt"])
                except Exception:
                    pass

            # ComfyUI saves the UI workflow in "workflow"
            if "workflow" in info:
                try:
                    metadata["comfyui_workflow"] = json.loads(info["workflow"])
                except Exception:
                    pass
    except Exception:
        pass

    return metadata
