"""Distil stored workflow metadata into a compact generation-parameter summary.

The full ComfyUI workflow payload is large (tens to hundreds of kilobytes per
entry) and is only ever used by the front-end to render a short caption such as
``model | 1024x1024 | Steps: 20 | CFG: 7 | ...``.  Shipping it in the list
response dominated the payload, so instead we extract just the scalar fields the
caption needs and store them under :data:`PARAMS_KEY`.

The extraction mirrors ``web/lib/metadata.js`` (``extractFromPrompt`` /
``extractFromWorkflow`` / ``formatMetadata``) so captions stay identical.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

from .storage import ENTRY_METADATA_KEY

PROMPT_KEY = "comfyui_prompt"
WORKFLOW_KEY = "comfyui_workflow"
PARAMS_KEY = "comfyui_params"

_CHECKPOINT_TYPES = (
    "CheckpointLoader",
    "CheckpointLoaderSimple",
    "CheckpointLoader|pysssss",
)
_SAMPLER_TYPES = ("KSampler", "KSamplerAdvanced")

# JavaScript's Object.keys() ignores the array-index limit at 2**32 - 1.
_MAX_ARRAY_INDEX = 2**32 - 2


def _is_js_number(value: Any) -> bool:
    """Mirror ``typeof value === "number"`` (bools are not numbers in JS)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_js_string(value: Any) -> bool:
    """Mirror ``typeof value === "string"``."""
    return isinstance(value, str)


def _is_array_index(key: Any) -> bool:
    """Return True for canonical array-index keys, mirroring JS key ordering."""
    if not isinstance(key, str) or not key or not key.isascii() or not key.isdigit():
        return False
    value = int(key)
    return value <= _MAX_ARRAY_INDEX and str(value) == key


def _js_key_order(mapping: Dict[str, Any]) -> List[str]:
    """Order keys the way JavaScript's ``Object.keys()`` does.

    Integer-like keys come first in ascending numeric order, then the remaining
    keys in insertion order.  ComfyUI node ids are integer-like, so this matters
    when picking which ``CLIPTextEncode`` supplies the positive prompt.
    """
    indices: List[str] = []
    others: List[str] = []
    for key in mapping:
        if _is_array_index(key):
            indices.append(key)
        else:
            others.append(key)
    indices.sort(key=int)
    return indices + others


def _record_prompt_text(text: Any, params: Dict[str, Any]) -> None:
    """Assign the first text to ``prompt`` and a differing one to ``negative_prompt``."""
    if not _is_js_string(text) or not text:
        return
    if not params.get("prompt"):
        params["prompt"] = text
    elif text != params["prompt"]:
        params["negative_prompt"] = text


def _params_from_prompt(prompt: Any, params: Dict[str, Any]) -> None:
    """Port of ``extractFromPrompt`` in ``web/lib/metadata.js``."""
    if not isinstance(prompt, dict):
        return

    for key in _js_key_order(prompt):
        node = prompt.get(key)
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type")
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            inputs = {}

        if class_type in _CHECKPOINT_TYPES:
            model = inputs.get("ckpt_name") or inputs.get("model_name")
            if _is_js_string(model) and model:
                params["model"] = model
        elif class_type in _SAMPLER_TYPES:
            if _is_js_number(inputs.get("seed")) or _is_js_string(inputs.get("seed")):
                params["seed"] = inputs["seed"]
            if _is_js_number(inputs.get("steps")):
                params["steps"] = inputs["steps"]
            if _is_js_number(inputs.get("cfg")):
                params["cfg"] = inputs["cfg"]
            if _is_js_string(inputs.get("sampler_name")):
                params["sampler"] = inputs["sampler_name"]
            if _is_js_string(inputs.get("scheduler")):
                params["scheduler"] = inputs["scheduler"]
            if _is_js_number(inputs.get("denoise")) and inputs["denoise"] != 1.0:
                params["denoise"] = inputs["denoise"]
        elif class_type == "EmptyLatentImage":
            if _is_js_number(inputs.get("width")):
                params["width"] = inputs["width"]
            if _is_js_number(inputs.get("height")):
                params["height"] = inputs["height"]
            if _is_js_number(inputs.get("batch_size")):
                params["batch_size"] = inputs["batch_size"]
        elif class_type == "CLIPTextEncode":
            _record_prompt_text(inputs.get("text"), params)


def _params_from_workflow(workflow: Any, params: Dict[str, Any]) -> None:
    """Port of ``extractFromWorkflow`` in ``web/lib/metadata.js``."""
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
        if not isinstance(widgets, list) or not widgets:
            continue

        if node_type in _SAMPLER_TYPES:
            if len(widgets) >= 4:
                if _is_js_number(widgets[0]):
                    params["seed"] = widgets[0]
                if _is_js_number(widgets[1]):
                    params["steps"] = widgets[1]
                if _is_js_number(widgets[2]):
                    params["cfg"] = widgets[2]
                if _is_js_string(widgets[3]):
                    params["sampler"] = widgets[3]
                if len(widgets) > 4 and _is_js_string(widgets[4]):
                    params["scheduler"] = widgets[4]
        elif node_type in _CHECKPOINT_TYPES:
            if _is_js_string(widgets[0]) and widgets[0]:
                params["model"] = widgets[0]
        elif node_type == "EmptyLatentImage":
            if len(widgets) >= 2:
                if _is_js_number(widgets[0]):
                    params["width"] = widgets[0]
                if _is_js_number(widgets[1]):
                    params["height"] = widgets[1]
        elif node_type == "CLIPTextEncode":
            _record_prompt_text(widgets[0], params)


def _parse_json_object(value: Any) -> Any:
    """Accept a mapping or a JSON string holding one; return None otherwise."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def extract_params(prompt: Any, workflow: Any = None) -> Dict[str, Any]:
    """Return the caption fields present in a workflow/prompt payload."""
    params: Dict[str, Any] = {}
    parsed_workflow = _parse_json_object(workflow)
    if parsed_workflow:
        _params_from_workflow(parsed_workflow, params)
    parsed_prompt = _parse_json_object(prompt)
    if parsed_prompt:
        _params_from_prompt(parsed_prompt, params)
    return params


def summarize_metadata(metadata: Any) -> Any:
    """Replace ``comfyui_prompt``/``comfyui_workflow`` with :data:`PARAMS_KEY`.

    Returns the input untouched when there is nothing to slim, so callers can
    apply this on every read without paying for a copy.  Existing rows are
    handled transparently -- the extraction happens at read time, so no
    migration is required.
    """
    if not isinstance(metadata, dict):
        return metadata
    if PROMPT_KEY not in metadata and WORKFLOW_KEY not in metadata:
        return metadata

    compact = dict(metadata)
    existing = compact.get(PARAMS_KEY)
    workflow = compact.pop(WORKFLOW_KEY, None)
    prompt = compact.pop(PROMPT_KEY, None)

    if not isinstance(existing, dict):
        params = extract_params(prompt, workflow)
        if params:
            compact[PARAMS_KEY] = params

    return compact


def summarize_entry_metadata(metadata: Any) -> Any:
    """Slim an entry's metadata for transport.

    The nested :data:`ENTRY_METADATA_KEY` map holds one metadata copy per
    generated image, so it has to be slimmed as well -- otherwise a second full
    copy of every workflow leaks into the list response.
    """
    if not isinstance(metadata, dict):
        return metadata

    nested = metadata.get(ENTRY_METADATA_KEY)
    if isinstance(nested, dict):
        metadata[ENTRY_METADATA_KEY] = {
            key: summarize_metadata(value) for key, value in nested.items()
        }

    return summarize_metadata(metadata)


__all__ = [
    "PARAMS_KEY",
    "PROMPT_KEY",
    "WORKFLOW_KEY",
    "extract_params",
    "summarize_entry_metadata",
    "summarize_metadata",
]
