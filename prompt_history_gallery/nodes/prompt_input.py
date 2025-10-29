"""
Prompt input node that records text prompts into history storage.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from comfy_execution.utils import get_executing_context

from ..storage import get_prompt_history_storage, register_prompt_entry


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
                "tags": (
                    "STRING",
                    {
                        "default": "",
                        "placeholder": "tag1, tag2",
                    },
                ),
                "metadata": (
                    "DICT",
                    {},
                ),
            },
        }

    RETURN_TYPES = ("CONDITIONING",)
    RETURN_NAMES = ("conditioning",)
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
        if prompt_id and "prompt_id" not in metadata_dict:
            metadata_dict["prompt_id"] = prompt_id
        entry = self._storage.append(
            prompt=prompt,
            tags=tags_list,
            metadata=metadata_dict,
        )
        if prompt_id:
            register_prompt_entry(prompt_id, entry.id)
        tokens = clip.tokenize(prompt)
        conditioning = clip.encode_from_tokens_scheduled(tokens)
        return (conditioning,)
