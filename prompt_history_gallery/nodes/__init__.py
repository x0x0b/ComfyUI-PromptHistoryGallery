"""
Expose node mappings required by ComfyUI.
"""

from .prompt_dual_input import PromptHistoryDualInput
from .prompt_input import PromptHistoryInput

NODE_CLASS_MAPPINGS = {
    "PromptHistoryInput": PromptHistoryInput,
    "PromptHistoryDualInput": PromptHistoryDualInput,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptHistoryInput": "Prompt History Input",
    "PromptHistoryDualInput": "Prompt History Dual Input",
}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "PromptHistoryInput",
    "PromptHistoryDualInput",
]
