# ComfyUI-PromptHistoryGallery

## Prompt History Input Node

- `CLIP`: Connect the CLIP text encoder that should be used to embed the prompt.
- `Prompt`: Provide any text prompt. The node saves it to history and returns a matching `CONDITIONING`.
- `Tags` (optional): Comma- or newline-separated tags. They are trimmed and stored as a list.
- `Metadata` (optional): Pass a `DICT` input; it is stored alongside the prompt for later use.

Output:

- `conditioning`: The `CONDITIONING` tensor produced by encoding the prompt with the supplied CLIP model.

Each execution appends an entry to a SQLite database (default: `prompt_history_gallery/data/prompt_history.db`). Set the `COMFYUI_PROMPT_HISTORY_DIR` environment variable to override the storage location.

## UI Extension (History tab)

- A `History` tab appears in the left ComfyUI sidebar, listing stored prompt entries.
- Each entry supports copying the prompt, deleting the entry, and previewing image thumbnails provided via metadata.
- Use the `Refresh` button to pull the latest entries and `Clear` to remove all history.
- To show thumbnails, include data such as `{"images": [{"filename": "...", "subfolder": "...", "type": "output"}]}` in the node's `Metadata` input.
