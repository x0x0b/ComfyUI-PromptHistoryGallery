"""
Expose node mappings required by ComfyUI.
"""

from .prompt_input import PromptHistoryInput

NODE_CLASS_MAPPINGS = {
    "PromptHistoryInput": PromptHistoryInput,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptHistoryInput": "Prompt History Input",
}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "PromptHistoryInput",
]
