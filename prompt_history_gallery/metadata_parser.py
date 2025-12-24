"""
Helper to extract metadata (prompt, workflow) from generated images.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional

try:
    from PIL import Image
except ImportError:
    Image = None

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


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _set_number(params: Dict[str, Any], key: str, value: Any) -> None:
    if _is_number(value):
        params[key] = value


def _set_string(params: Dict[str, Any], key: str, value: Any) -> None:
    if isinstance(value, str) and value:
        params[key] = value


def _extract_params_from_workflow(
    workflow: Any, params: Dict[str, Any], include_prompts: bool
) -> None:
    if not isinstance(workflow, dict):
        return

    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        return

    for node in nodes:
        if not isinstance(node, dict):
            continue

        node_type = node.get("type")
        widgets = node.get("widgets_values")
        if not isinstance(widgets, list):
            continue

        if node_type in ("KSampler", "KSamplerAdvanced"):
            if len(widgets) >= 4:
                _set_number(params, "seed", widgets[0])
                _set_number(params, "steps", widgets[1])
                _set_number(params, "cfg", widgets[2])
                _set_string(params, "sampler", widgets[3])
                if len(widgets) > 4:
                    _set_string(params, "scheduler", widgets[4])
        elif node_type == "CheckpointLoaderSimple" or node_type == "Checkpoint Loader":
            if widgets:
                _set_string(params, "model", widgets[0])
        elif node_type == "CheckpointLoader":
            if len(widgets) > 1:
                _set_string(params, "model", widgets[1])
        elif node_type == "EmptyLatentImage":
            if len(widgets) >= 2:
                _set_number(params, "width", widgets[0])
                _set_number(params, "height", widgets[1])
        elif node_type == "CLIPTextEncode" and include_prompts:
            if widgets:
                text = widgets[0]
                if isinstance(text, str) and text:
                    if not params.get("prompt"):
                        params["prompt"] = text
                    elif text != params.get("prompt"):
                        params["negative_prompt"] = text


def _extract_params_from_prompt(
    prompt_data: Any, params: Dict[str, Any], include_prompts: bool
) -> None:
    if not isinstance(prompt_data, dict):
        return

    for node in prompt_data.values():
        if not isinstance(node, dict):
            continue

        class_type = node.get("class_type")
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            inputs = {}

        if class_type in ("CheckpointLoader", "CheckpointLoaderSimple", "Checkpoint Loader"):
            _set_string(params, "model", inputs.get("ckpt_name"))
        elif class_type in ("KSampler", "KSamplerAdvanced"):
            seed = inputs.get("seed")
            if _is_number(seed) or (isinstance(seed, str) and seed):
                params["seed"] = seed
            _set_number(params, "steps", inputs.get("steps"))
            _set_number(params, "cfg", inputs.get("cfg"))
            _set_string(params, "sampler", inputs.get("sampler_name"))
            _set_string(params, "scheduler", inputs.get("scheduler"))
            denoise = inputs.get("denoise")
            if _is_number(denoise) and float(denoise) != 1.0:
                params["denoise"] = denoise
        elif class_type == "EmptyLatentImage":
            _set_number(params, "width", inputs.get("width"))
            _set_number(params, "height", inputs.get("height"))
            _set_number(params, "batch_size", inputs.get("batch_size"))
        elif class_type == "CLIPTextEncode" and include_prompts:
            text = inputs.get("text")
            if isinstance(text, str) and text:
                if not params.get("prompt"):
                    params["prompt"] = text
                elif text != params.get("prompt"):
                    params["negative_prompt"] = text


def extract_comfyui_parameters(
    prompt_data: Optional[Any] = None,
    workflow_data: Optional[Any] = None,
    include_prompts: bool = False,
) -> Dict[str, Any]:
    """Extract common generation parameters from ComfyUI prompt/workflow data."""
    params: Dict[str, Any] = {}
    if workflow_data is not None:
        _extract_params_from_workflow(workflow_data, params, include_prompts)
    if prompt_data is not None:
        _extract_params_from_prompt(prompt_data, params, include_prompts)
    return {key: value for key, value in params.items() if value is not None}


def parse_image_metadata(image_path: str) -> Dict[str, Any]:
    """
    Read ComfyUI metadata (prompt, workflow) from a PNG file.
    """
    if Image is None:
        return {}

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

    extracted = extract_comfyui_parameters(
        prompt_data=metadata.get("comfyui_prompt"),
        workflow_data=metadata.get("comfyui_workflow"),
    )
    if extracted:
        metadata.update(extracted)

    return metadata
