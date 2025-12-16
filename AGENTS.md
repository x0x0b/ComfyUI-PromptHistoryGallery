# Repository Guidelines

This repository is a ComfyUI extension that registers prompt history nodes and a sidebar UI when placed under `custom_nodes/`.

## Project Structure & Module Organization
- Core package: `prompt_history_gallery/` (nodes, storage, watcher, hooks). `nodes/prompt_input.py` implements the ComfyUI node; `storage.py` manages SQLite; `history_watcher.py` links runtime history to stored prompts.
- Front-end: `web/` (sidebar JS, CSS, icons) served via `WEB_DIRECTORY` in `__init__.py`.
- Release bundle: `node.zip` mirrors shipped contents—refresh it when publishing.
- Data: `prompt_history_gallery/data/` holds the SQLite DB, ignored by Git; override with `COMFYUI_PROMPT_HISTORY_DIR` while testing.

## Build, Run, and Local Development
- No build step; ComfyUI loads directly from `custom_nodes/`.
- Run ComfyUI from its repo root to exercise changes: `cd ../.. && python main.py --listen 0.0.0.0:8188` (this extension auto-registers on boot).
- Rebuild the distributable: `zip -r node.zip prompt_history_gallery web LICENSE README.md pyproject.toml`.
- Quick syntax check: `python -m compileall prompt_history_gallery`.

## Formatting
- Python: `ruff format --check .` for layout and `ruff check --select I .` for import ordering (add `--fix` locally if you want auto-fixes).
- Web assets: `npx prettier@3.7.4 --check "web/**/*.{js,jsx,ts,tsx,css,scss,html,json}"` (respects `.prettierignore`; `web/vendor/` excluded).
- Install tools via `pip install -e .[dev]` (adds Ruff) or `pip install ruff`. Prettier comes via `npx`; Node.js is needed only if you run `npx`.
- CI: `.github/workflows/ci.yml` runs `ruff format --check .`, `ruff check --select I .`, and `npx prettier@3.7.4 --check "web/**/*.{js,jsx,ts,tsx,css,scss,html,json}"` on push/PR to `main`.
- One-shot fixer: run `scripts/format.sh` (requires `pipx`, Node). It executes `pipx run --spec ruff==0.14.9 ruff format .`, `pipx run --spec ruff==0.14.9 ruff check --select I --fix .`, and `npx prettier@3.7.4 -w "web/**/*.{js,jsx,ts,tsx,css,scss,html,json}"`.

## Coding Style & Naming Conventions
- Target Python 3.10+. Follow PEP 8, 4-space indents, and type hints (dataclasses in `storage.py` are the pattern).
- Naming: constants `UPPER_SNAKE_CASE`, helpers `_prefixed`, functions `snake_case`, classes `PascalCase`.
- Keep docstrings on public surfaces and use `logging` (see `history_watcher.py`). Favor small, testable functions.

## Testing Guidelines
- No automated suite yet; add `pytest` cases under `tests/` and run `pytest` locally when you introduce them.
- Manual flow: start ComfyUI, drop a **Prompt History Input** node, run a graph, then `curl http://localhost:8188/prompt-history?limit=5` to confirm entries; delete one and watch the sidebar refresh.
- For schema or storage changes, point the DB at a scratch location: `COMFYUI_PROMPT_HISTORY_DIR=/tmp/prompt_history`.

## Commit & Pull Request Guidelines
- Match the repo history: concise, imperative subjects with prefixes such as `fix:`, `feat:`, or `chore:` (e.g., `fix: adjust viewer list item width`).
- For UI changes, include before/after screenshots of the Prompt History tab plus test notes (curl checks, ComfyUI version).
- When releasing, bump `version` in `pyproject.toml` and rebuild `node.zip`. Reference related issues/PR IDs where relevant.

## Maintenance
- When behavior, schema, or release steps change, update this document to keep commands, paths, and expectations in sync.

## Configuration & Data Safety
- Default DB: `prompt_history_gallery/data/prompt_history.db` with WAL enabled; keep it out of commits. Use the env var override for isolated testing.
- Avoid logging full prompts in debug output; prefer IDs or tags when triaging issues.
