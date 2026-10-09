"""
Prompt input node that records a positive and a negative prompt as one entry.
"""

from __future__ import annotations

import time
from typing import Any, Dict, Optional, Tuple

from comfy_execution.utils import get_executing_context

from ..normalizers import normalize_metadata
from ..registry import register_prompt_entry
from ..settings import is_capture_enabled
from ..storage import get_prompt_history_storage
from .prompt_input import _NODE_METADATA_KEY, _resolve_node_identifier


def _encode(clip, text: str):
    tokens = clip.tokenize(text)
    return clip.encode_from_tokens_scheduled(tokens)


class PromptHistoryDualInput:
    """
    Custom node that captures a positive/negative prompt pair in one history entry.
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
                "negative_prompt": (
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

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("POSITIVE", "NEGATIVE")
    FUNCTION = "record_prompt"
    CATEGORY = "Prompt History"

    def record_prompt(
        self,
        clip,
        prompt: str,
        negative_prompt: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Tuple[Any, Any]:
        context = get_executing_context()
        prompt_id = context.prompt_id if context else None

        if is_capture_enabled():
            metadata_dict = normalize_metadata(metadata)
            node_identifier = _resolve_node_identifier(context)
            if node_identifier and _NODE_METADATA_KEY not in metadata_dict:
                metadata_dict[_NODE_METADATA_KEY] = node_identifier
            entry, created = self._storage.ensure_entry(
                prompt=prompt,
                negative_prompt=negative_prompt,
                metadata=metadata_dict,
            )
            if not created:
                self._storage.touch_entries([entry.id])
            if prompt_id:
                register_prompt_entry(prompt_id, entry.id)

        return (_encode(clip, prompt), _encode(clip, negative_prompt))

    @classmethod
    def IS_CHANGED(
        cls,
        clip,
        prompt: str,
        negative_prompt: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ):
        """
        Force the node to execute on every graph run so that the prompt history
        captures repeated prompts (e.g. unchanged negative prompts).
        """
        return time.time()
