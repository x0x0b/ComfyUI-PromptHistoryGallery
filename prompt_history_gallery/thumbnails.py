"""Downscaled previews for generated images.

The front-end used to point card thumbnails straight at ComfyUI's ``/view``
route, which serves the original file -- several megabytes per SDXL/FLUX PNG.
These helpers build and cache small WebP previews instead.

Pillow is not declared as a dependency because ComfyUI already ships it; every
entry point degrades to a miss (and the caller falls back to ``/view``) when it
is unavailable.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Dict, Optional

from .storage import default_storage_directory

LOGGER = logging.getLogger(__name__)

THUMBNAIL_SIZE = 360
THUMBNAIL_QUALITY = 80
THUMBNAIL_DIRECTORY = "thumbs"
THUMBNAIL_MAX_FILES = 4000
THUMBNAIL_PRUNE_INTERVAL_SECONDS = 3600

# Pillow cannot rasterise SVG, so those fall through to the full-size original.
THUMBNAILABLE_EXTENSIONS = frozenset(
    {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".avif"}
)

_PRUNE_STATE = {"checked_at": 0.0}
_PRUNE_LOCK = threading.Lock()


def is_within(candidate: str, base: str) -> bool:
    """True when ``candidate`` resolves to a path inside ``base``."""
    try:
        relative = os.path.relpath(candidate, base)
    except (OSError, ValueError):
        # ValueError covers paths on different Windows drives.
        return False
    if relative == os.pardir or relative.startswith(os.pardir + os.sep):
        return False
    return not os.path.isabs(relative)


def resolve_image_path(filename: str, subfolder: str, image_type: str) -> Optional[str]:
    """Resolve a client-supplied image reference to a validated absolute path.

    Follows the rules ComfyUI's own ``/view`` route enforces: only the
    directories ``get_directory_by_type()`` exposes are reachable, and the
    resolved path must stay inside that directory.
    """
    try:
        import folder_paths
    except Exception:
        LOGGER.debug("folder_paths unavailable; cannot serve thumbnails.", exc_info=True)
        return None

    if not filename or "\x00" in filename or "\x00" in subfolder:
        return None

    # Note: "output"/"temp"/"input" are handled specially by this helper and are
    # NOT keys of folder_names_and_paths, so the call itself is the allowlist.
    get_directory = getattr(folder_paths, "get_directory_by_type", None)
    if not callable(get_directory):
        return None

    base = get_directory(image_type)
    if not base:
        return None
    base = os.path.abspath(base)

    if ".." in filename or ".." in subfolder:
        return None

    directory = base
    if subfolder:
        directory = os.path.abspath(os.path.join(base, subfolder))
        if not is_within(directory, base):
            return None

    candidate = os.path.join(directory, os.path.basename(filename))
    if not is_within(candidate, base):
        return None
    if not os.path.isfile(candidate):
        return None
    return candidate


def is_thumbnailable(path: str) -> bool:
    """True when Pillow is likely able to decode ``path``."""
    return os.path.splitext(path)[1].lower() in THUMBNAILABLE_EXTENSIONS


def thumbnail_cache_path(source_path: str) -> Path:
    """Return the cache path for a source image.

    The key covers mtime and size, so regenerating an image at the same path
    yields a new key and can never serve a stale thumbnail.
    """
    stat = os.stat(source_path)
    key = os.fsencode(source_path) + b"|" + f"{stat.st_mtime_ns}|{stat.st_size}".encode("ascii")
    digest = hashlib.sha256(key).hexdigest()
    directory = default_storage_directory() / THUMBNAIL_DIRECTORY
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{digest}.webp"


def etag_for(cache_path: Path) -> str:
    """Stable HTTP entity tag derived from the cache key."""
    return f'"{cache_path.stem}"'


def cache_headers(etag: str) -> Dict[str, str]:
    """Revalidate on every request: cheap 304s, but never a stale thumbnail."""
    return {
        "Cache-Control": "public, max-age=0, must-revalidate",
        "ETag": etag,
    }


def generate_thumbnail(source_path: str, destination: Path) -> bool:
    """Downscale a source image into ``destination``; False on any failure."""
    try:
        from PIL import Image, ImageOps
    except Exception:
        LOGGER.debug("Pillow unavailable; skipping thumbnail generation.")
        return False

    temporary: Optional[Path] = None
    try:
        with Image.open(source_path) as image:
            if getattr(image, "is_animated", False):
                image.seek(0)
            transposed = ImageOps.exif_transpose(image)
            if transposed is not None:
                image = transposed
            image.thumbnail((THUMBNAIL_SIZE, THUMBNAIL_SIZE))
            preview = image.convert("RGBA")
            # Write beside the target so os.replace() stays atomic.
            temporary = destination.with_name(f"{destination.name}.{uuid.uuid4().hex}.tmp")
            preview.save(temporary, format="WEBP", quality=THUMBNAIL_QUALITY, method=4)
        os.replace(temporary, destination)
        return True
    except Exception:
        LOGGER.debug("Failed to build thumbnail for %s", source_path, exc_info=True)
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
        return False


def maybe_prune_thumbnails(directory: Path) -> None:
    """Best-effort eviction so the cache cannot grow without bound."""
    now = time.time()
    if now - _PRUNE_STATE["checked_at"] < THUMBNAIL_PRUNE_INTERVAL_SECONDS:
        return
    if not _PRUNE_LOCK.acquire(blocking=False):
        return

    try:
        if now - _PRUNE_STATE["checked_at"] < THUMBNAIL_PRUNE_INTERVAL_SECONDS:
            return
        _PRUNE_STATE["checked_at"] = now

        files = sorted(
            (item for item in directory.iterdir() if item.suffix == ".webp"),
            key=lambda item: item.stat().st_mtime,
        )
        if len(files) <= THUMBNAIL_MAX_FILES:
            return
        for stale in files[: len(files) // 2]:
            try:
                stale.unlink()
            except OSError:
                pass
    except OSError:
        LOGGER.debug("Thumbnail cache prune failed.", exc_info=True)
    finally:
        _PRUNE_LOCK.release()


__all__ = [
    "cache_headers",
    "etag_for",
    "generate_thumbnail",
    "is_thumbnailable",
    "is_within",
    "maybe_prune_thumbnails",
    "resolve_image_path",
    "thumbnail_cache_path",
]
