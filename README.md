# ComfyUI-PromptHistoryGallery

## Prompt History Input Node

- `CLIP`: Connect the CLIP text encoder that should be used to embed the prompt.
- `Prompt`: Provide any text prompt. The node saves it to history and returns a matching `CONDITIONING`.

Output:

- `conditioning`: The `CONDITIONING` tensor produced by encoding the prompt with the supplied CLIP model.

Each execution appends an entry to a SQLite database (default: `prompt_history_gallery/data/prompt_history.db`). Set the `COMFYUI_PROMPT_HISTORY_DIR` environment variable to override the storage location.

## UI Extension (History tab)

- A `History` tab appears in the left ComfyUI sidebar, listing stored prompt entries.
- Each entry supports copying the prompt, deleting the entry, and previewing image thumbnails captured from previous executions.
