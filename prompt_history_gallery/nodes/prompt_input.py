"""
Prompt input node that records text prompts into history storage.
"""

from __future__ import annotations

import time
from typing import Any, Dict, Optional, Tuple

from comfy_execution.utils import get_executing_context

from ..normalizers import normalize_metadata
from ..registry import register_prompt_entry
from ..storage import get_prompt_history_storage

_NODE_METADATA_KEY = "_prompt_history_node"


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
            "optional": {},
        }

    RETURN_TYPES = ("CONDITIONING",)
    RETURN_NAMES = ("CONDITIONING",)
    FUNCTION = "record_prompt"
    CATEGORY = "Prompt History"

    def record_prompt(
        self,
        clip,
        prompt: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Tuple[Any]:
        metadata_dict = normalize_metadata(metadata)
        context = get_executing_context()
        prompt_id = context.prompt_id if context else None
        node_identifier = _resolve_node_identifier(context)
        if node_identifier and _NODE_METADATA_KEY not in metadata_dict:
            metadata_dict[_NODE_METADATA_KEY] = node_identifier
        entry, created = self._storage.ensure_entry(
            prompt=prompt,
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
        metadata: Optional[Dict[str, Any]] = None,
    ):
        """
        Force the node to execute on every graph run so that the prompt history
        captures repeated prompts (e.g. unchanged negative prompts).
        """
        return time.time()
