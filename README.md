# ComfyUI-PromptHistoryGallery

<img height="400" alt="screenshot of Prompt History tab" src="https://github.com/user-attachments/assets/d4c63cc9-5701-4295-a23b-c45abe4171ad" />
<img height="400" alt="screenshot of image preview" src="https://github.com/user-attachments/assets/4fafe7cf-89ec-46ac-b33a-2c612ba76079" />

## Prompt History Input Node

- `CLIP`: Connect the CLIP text encoder that should be used to embed the prompt.
- `Prompt`: Provide any text prompt. The node saves it to history and returns a matching `CONDITIONING`.

Output:

- `conditioning`: The `CONDITIONING` tensor produced by encoding the prompt with the supplied CLIP model.

Each execution appends an entry to a SQLite database (default: `prompt_history_gallery/data/prompt_history.db`). Set the `COMFYUI_PROMPT_HISTORY_DIR` environment variable to override the storage location.

## UI Extension (Prompt History tab)

- A `Prompt History` tab appears in the left ComfyUI sidebar, listing stored prompt entries.
- Each entry supports copying the prompt, deleting the entry, and previewing image thumbnails captured from previous executions.
