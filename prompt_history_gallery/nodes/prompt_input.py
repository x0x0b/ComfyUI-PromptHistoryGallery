"""
Prompt input node that records text prompts into history storage.
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Tuple

from comfy_execution.utils import get_executing_context

from ..storage import get_prompt_history_storage, register_prompt_entry

_NODE_METADATA_KEY = "_prompt_history_node"


def _coerce_tags(raw: Any) -> List[str]:
    """
    Convert user-provided tags to a normalized list.
    """
    if raw is None:
        return []
    if isinstance(raw, (list, tuple, set)):
        candidates = list(raw)
    else:
        # Support comma or newline separated strings.
        text = str(raw)
        text = text.replace("\n", ",")
        candidates = text.split(",")
    tags = []
    for value in candidates:
        item = str(value).strip()
        if item:
            tags.append(item)
    return tags


def _ensure_metadata(raw: Any) -> Dict[str, Any]:
    """
    Metadata must be a dict for downstream nodes to consume.
    """
    if isinstance(raw, dict):
        return raw
    # Convert lists of pairs into dict, otherwise fallback to empty.
    if isinstance(raw, (list, tuple)):
        result: Dict[str, Any] = {}
        for item in raw:
            if (
                isinstance(item, (list, tuple))
                and len(item) == 2
                and isinstance(item[0], str)
            ):
                result[item[0]] = item[1]
        if result:
            return result
    return {}


def _resolve_node_identifier(context: Any) -> Optional[str]:
    """
    Attempt to derive a stable identifier for the executing node instance.
    """
    if context is None:
        return None

    for attribute in ("node_id", "node_index", "node_identifier", "node_ref"):
        value = getattr(context, attribute, None)
        if value is not None:
            return str(value)

    node = getattr(context, "node", None)
    if node is None:
        return None

    if isinstance(node, dict):
        for key in ("id", "name", "title"):
            value = node.get(key)
            if value is not None:
                return str(value)
        return None

    for attribute in ("id", "name", "title"):
        value = getattr(node, attribute, None)
        if value is not None:
            return str(value)

    return None


class PromptHistoryInput:
    """
    Custom node that captures text prompts and stores them in history.
    """

    def __init__(self) -> None:
        self._storage = get_prompt_history_storage()

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "prompt": (
                    "STRING",
                    {
                        "default": "",
                        "forceInput": False,
                        "multiline": True,
                    },
                ),
            },
            "optional": {
            },
        }

    RETURN_TYPES = ("CONDITIONING",)
    RETURN_NAMES = ("CONDITIONING",)
    FUNCTION = "record_prompt"
    CATEGORY = "Prompt History"

    def record_prompt(
        self,
        clip,
        prompt: str,
        tags: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Tuple[Any]:
        tags_list = _coerce_tags(tags)
        metadata_dict = _ensure_metadata(metadata)
        metadata_dict = metadata_dict.copy()
        context = get_executing_context()
        prompt_id = context.prompt_id if context else None
        node_identifier = _resolve_node_identifier(context)
        if node_identifier and _NODE_METADATA_KEY not in metadata_dict:
            metadata_dict[_NODE_METADATA_KEY] = node_identifier
        entry, created = self._storage.ensure_entry(
            prompt=prompt,
            tags=tags_list,
            metadata=metadata_dict,
        )
        if not created:
            self._storage.touch_entries([entry.id])
        if prompt_id:
            register_prompt_entry(prompt_id, entry.id)
        tokens = clip.tokenize(prompt)
        conditioning = clip.encode_from_tokens_scheduled(tokens)
        return (conditioning,)

    @classmethod
    def IS_CHANGED(
        cls,
        clip,
        prompt: str,
        tags: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ):
        """
        Force the node to execute on every graph run so that the prompt history
        captures repeated prompts (e.g. unchanged negative prompts).
        """
        return time.time()
