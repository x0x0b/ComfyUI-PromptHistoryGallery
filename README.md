# ComfyUI-PromptHistoryGallery

Capture ComfyUI prompts and generated images with a history dialog, popup previews, and a full gallery viewer.

## Features

- Save prompts to history while still returning the `CONDITIONING` output for your workflow.
- Capture a positive and a negative prompt together as a single entry with **Prompt History Dual Input**.
- View the latest thumbnail and total image count per prompt, and jump straight into the gallery.
- Search history by prompt text or tags, then send to node, copy, or delete with quick actions.
- See popup previews when generations finish; click a preview to open the gallery.
- Tune history limit, frequent-prompt highlighting, dialog colours, and popup preview size/duration/position in the Settings tab.
- Turn history capture on or off from the Settings tab — every run is recorded while it is on, and nothing is written while it is off.

## Prompt History Input Node

<img width="350" alt="Screenshot of prompt history node" src="https://github.com/user-attachments/assets/00837c62-24f9-472f-a29a-b72e28ffcce6" /><br>

- `CLIP`: Connect the CLIP text encoder that should be used to embed the prompt.
- `Prompt`: Provide any text prompt. The node saves it to history and returns a matching `CONDITIONING`.

Output:

- `conditioning`: The `CONDITIONING` tensor produced by encoding the prompt with the supplied CLIP model.

The node executes on every graph run so repeated prompts are captured. Each execution appends or touches an entry in a SQLite database (default: `prompt_history_gallery/data/prompt_history.db`). Only the prompt text and the node identifier are persisted — the API-format graph is discarded, because it outweighed the prompt it accompanied by more than 3×. Set the `COMFYUI_PROMPT_HISTORY_DIR` environment variable to override the storage location.

Cached card thumbnails live in a `thumbs/` directory beside the database (so `COMFYUI_PROMPT_HISTORY_DIR/thumbs/` when the override is set). The directory is evicted automatically once it grows past a few thousand files, and it is safe to delete at any time.

## Prompt History Dual Input Node

Drop-in replacement for the node above when you want the negative prompt saved alongside the positive one.

- `CLIP`: Connect the CLIP text encoder used for both prompts.
- `Prompt`: The positive prompt. Widget name is deliberately `prompt`, which is what the History button and the "send to node" action look for.
- `Negative prompt`: The negative prompt. May be left empty, in which case it behaves exactly like a single-prompt entry.

Outputs:

- `POSITIVE`: `CONDITIONING` for the positive prompt.
- `NEGATIVE`: `CONDITIONING` for the negative prompt.

One execution writes **one** entry holding both texts, so the pair is browsed, searched, copied and deleted as a unit. Entries are grouped by the positive/negative pair, so reusing the same positive prompt with a different negative produces a separate card instead of silently replacing the previous one. Databases written before this node existed gain a `negative_prompt` column on startup and keep reading as empty-negative entries.

In the dialog, the negative prompt sits under the positive one behind a `NEGATIVE` tag, is included in search, and is written back to the node's `negative_prompt` widget when you use the entry. The text area is capped in height (matched to the thumbnail) and scrolls internally, so a long pair never makes the card grow without bound.

On the node itself the two prompt boxes start out the same height. Drag the boundary between them — grab the top strip of the negative box or the bottom strip of the positive one, and the cursor turns into a resize arrow — to give one prompt more room. What is stored per node in the workflow is that **split as a proportion**, not a fixed pixel height, so dragging the node's own resize handle afterwards grows or shrinks **both** boxes together and keeps the ratio you chose. Resizing the node works at any size; it is never refused for being shorter than a prompt box. Both boxes hold a minimum, and when a box would be squeezed below it the split gives way to that floor — the proportion you set comes back as soon as the node is tall enough again.

## History Dialog + Popup Preview (History button on the node)

<img width="500" alt="Screenshot of prompt history window" src="https://github.com/user-attachments/assets/9d3e3633-ed31-48b6-8cf8-7c40a4b73c34" /><br>
<img width="500" alt="Screenshot of image preview" src="https://github.com/user-attachments/assets/2e1a971f-dfa1-4b3b-84fa-a7beceadcdaf" />

- Each `Prompt History Input` node includes a `History` button. Clicking it opens a dialog with recent prompts grouped by text and sorted by recent use.
- Entries are paginated 10 per page. Search and frequent-prompt highlighting still run over every loaded entry, so a match on another page is always found — paging only limits how many cards are rendered at once.
- Card images are served as cached downscaled thumbnails rather than full-size originals; a missing or unreadable image falls back to the original file.
- Search by prompt text, negative prompt, or tags. Entries show the latest preview, image count, and tags when available.
- Actions: send the prompt back to the selected node (falls back to copy if no node is active), copy, delete, and open the full gallery. Entries that carry a negative prompt fill that node widget too.
- The dialog refreshes when new prompts finish so it stays in sync with the latest generations.
- Popup previews appear when images complete; click a preview to open the gallery.
- Use the Settings tab to toggle popup previews, adjust preview duration/size, change the history limit, tune frequent-prompt highlighting, and pick the dialog's colour preset.
- Pick a colour preset under **Dialog Appearance** to recolour the history dialog's panel, backdrop and accent colour. Six presets are bundled (Blue, Violet, Teal, Amber, Rose, Neutral); Blue is the default and matches the dialog as it shipped. The choice is saved in the browser and restored on reload, and Reset returns to Blue. Popup preview cards on the canvas and the node splitter keep their own styling.
- The Settings tab also has a **Save Prompts to History** switch. With it off, the node still returns `CONDITIONING` and generations still run — only the recording stops. Existing entries stay browsable, searchable, and deletable, and the switch state is stored server-side so it survives a ComfyUI restart.

## HTTP endpoints

| Route | Description |
| --- | --- |
| `GET /prompt-history?limit=N` | Entries grouped by prompt, most recently used first (`limit` is clamped to 20–1000, default 50). |
| `DELETE /prompt-history/{entry_id}` | Delete every entry sharing that entry's prompt. |
| `DELETE /prompt-history` | Clear the whole history. Leaves the capture toggle untouched. |
| `POST /prompt-history/settings` | Set the capture toggle. Body: `{"capture_history": true\|false}`; a non-boolean value is rejected with 400. |
| `GET /prompt-history/thumb?filename=..&subfolder=..&type=..` | Cached 360 px WebP preview of a generated image. |

> **Breaking change for external consumers:** `GET /prompt-history` no longer carries the workflow in any form — neither the raw `comfyui_prompt` / `comfyui_workflow` payloads nor the derived `comfyui_params` summary. Entries store only the prompt text plus the node identifier. Older databases are compacted once on startup, which releases roughly 99% of the metadata bytes; the read-time slimming is retained as a guard so an uncompacted database can never leak a payload to a client.

The thumbnail route accepts only `output`, `temp`, and `input` directories and rejects paths that escape them. Any failure — unknown file, unsupported format, unreadable image — returns `404`, which makes the front-end fall back to the full-size original. Responses carry an `ETag` and are revalidated on every request, so a regenerated image is never served from a stale thumbnail.

## Development

### Formatting

- One-shot fixer: `scripts/format.sh` (needs `pipx` and Node) runs Ruff via `pipx run --spec ruff==0.14.10` plus Prettier `-w` to apply fixes.
- Install dev tools: `pip install -e .[dev]` (provides Ruff).
- Python: run `ruff format --check .` and `ruff check --select I .` (add `--fix` locally if you want auto-fixes).
- Web/JS/CSS: run `npx prettier@3.7.4 --check "web/**/*.{js,jsx,ts,tsx,css,scss,html,json}"` (honors `.prettierignore`; `web/vendor/` is excluded).
- CI: `.github/workflows/ci.yml` runs `ruff format --check .`, `ruff check --select I .`, and `npx prettier@3.7.4 --check "web/**/*.{js,jsx,ts,tsx,css,scss,html,json}"` on pushes/PRs to `main`.

### Release

- Release bundles are published by GitHub Actions; no manual `node.zip` rebuild is required.
