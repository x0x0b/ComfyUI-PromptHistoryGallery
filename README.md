# ComfyUI-PromptHistoryGallery

## Prompt History Input Node

<img width="350" alt="Screenshot of prompt history node" src="https://github.com/user-attachments/assets/00837c62-24f9-472f-a29a-b72e28ffcce6" /><br>

- `CLIP`: Connect the CLIP text encoder that should be used to embed the prompt.
- `Prompt`: Provide any text prompt. The node saves it to history and returns a matching `CONDITIONING`.

Output:

- `conditioning`: The `CONDITIONING` tensor produced by encoding the prompt with the supplied CLIP model.

Each execution appends an entry to a SQLite database (default: `prompt_history_gallery/data/prompt_history.db`). Set the `COMFYUI_PROMPT_HISTORY_DIR` environment variable to override the storage location.

## UI Extension (History button on the node)

<img width="500" alt="Screenshot of prompt history window" src="https://github.com/user-attachments/assets/9d3e3633-ed31-48b6-8cf8-7c40a4b73c34" /><br>
<img width="500" alt="Screenshot of image preview" src="https://github.com/user-attachments/assets/2e1a971f-dfa1-4b3b-84fa-a7beceadcdaf" />

- Each `Prompt History Input` node now includes a `History` button. Clicking it opens a popup with recent entries.
- Every entry shows the latest generated image and the total number of captured images for that prompt.
- Actions: send the prompt back to the node (or copy if no node is active), open the full gallery, copy, and delete.
- The popup refreshes whenever new prompts finish; quick image previews still appear when generations complete.

## Development

### Formatting

- Install dev tools: `pip install -e .[dev]` (provides Ruff).
- Python: run `ruff format .` to format and `ruff check --select I --fix .` to sort imports.
- Web/JS/CSS: run `npx prettier@3.2.5 -w web` (honors `.prettierignore`; `web/vendor/` is excluded).
- CI: `.github/workflows/ci.yml` runs `ruff format --check .`, `ruff check --select I .`, and `npx prettier@3.2.5 --check "web/**/*.{js,jsx,ts,tsx,css,scss,html,json,svg}"` on pushes/PRs to `main`.
