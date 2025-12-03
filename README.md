# ComfyUI-PromptHistoryGallery

<img height="400" alt="screenshot of Prompt History tab" src="https://github.com/user-attachments/assets/d4c63cc9-5701-4295-a23b-c45abe4171ad" />
<img height="400" alt="screenshot of image preview" src="https://github.com/user-attachments/assets/4fafe7cf-89ec-46ac-b33a-2c612ba76079" />

*Screenshots show the previous sidebar tab; the history UI now opens from the node itself to avoid sidebar breakage in ComfyUI 0.3.76+.*

## Prompt History Input Node

- `CLIP`: Connect the CLIP text encoder that should be used to embed the prompt.
- `Prompt`: Provide any text prompt. The node saves it to history and returns a matching `CONDITIONING`.

Output:

- `conditioning`: The `CONDITIONING` tensor produced by encoding the prompt with the supplied CLIP model.

Each execution appends an entry to a SQLite database (default: `prompt_history_gallery/data/prompt_history.db`). Set the `COMFYUI_PROMPT_HISTORY_DIR` environment variable to override the storage location.

## UI Extension (History button on the node)

- Each `Prompt History Input` node now includes a `History` button. Clicking it opens a popup with recent entries.
- Every entry shows the latest generated image and the total number of captured images for that prompt.
- Actions: send the prompt back to the node (or copy if no node is active), open the full gallery, copy, and delete.
- The popup refreshes whenever new prompts finish; quick image previews still appear when generations complete.
