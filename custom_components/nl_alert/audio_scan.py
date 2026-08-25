"""Discover alarm sounds: the ones NL-Alert ships, and the user's own.

Changelog:
  0.3.0 (2026-08-09): async_scan_builtin_sounds() added. NL-Alert now ships
                      its own alarm sounds in ``sounds/`` (served at
                      /nl_alert_sounds) so a fresh install has a working
                      alarm without borrowing a file from another
                      integration — which is how the previous setup ended up
                      pointing at a path that later disappeared.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

from homeassistant.core import HomeAssistant

from .const import (
    AUDIO_EXTENSIONS,
    BUILTIN_SOUND_LABELS,
    MAX_AUDIO_FILES,
    SOUNDS_URL_PATH,
)

_LOGGER = logging.getLogger(__name__)

_SOUNDS_DIR = os.path.join(os.path.dirname(__file__), "sounds")


def _scan_sync(www_dir: str) -> list[str]:
    """Recursively list audio files under ``www_dir`` as ``/local/...`` URLs."""
    base = Path(www_dir)
    if not base.is_dir():
        return []

    results: list[str] = []
    try:
        for path in base.rglob("*"):
            if not path.is_file():
                continue
            if path.suffix.lower() not in AUDIO_EXTENSIONS:
                continue
            try:
                rel = path.relative_to(base).as_posix()
            except ValueError:
                continue
            results.append(f"/local/{rel}")
            if len(results) >= MAX_AUDIO_FILES:
                break
    except OSError as err:
        _LOGGER.warning("Error scanning %s for audio files: %s", base, err)
        return results

    results.sort()
    return results


def _scan_builtin_sync() -> list[dict[str, str]]:
    """List the sounds shipped with the integration."""
    base = Path(_SOUNDS_DIR)
    if not base.is_dir():
        return []
    results: list[dict[str, str]] = []
    for path in base.iterdir():
        if not path.is_file() or path.suffix.lower() not in AUDIO_EXTENSIONS:
            continue
        results.append(
            {
                "url": f"{SOUNDS_URL_PATH}/{path.name}",
                # The folder is the source of truth: a new .wav dropped in
                # sounds/ shows up without touching any code. The label map
                # only overrides the auto-generated name where a nicer Dutch
                # one exists.
                "name": BUILTIN_SOUND_LABELS.get(path.name)
                or path.stem.replace("-", " ").replace("_", " ").capitalize(),
            }
        )
    # Sorted on the label, not the filename: the dropdown shows the labels,
    # and "alert-chime.wav" ordering put Attentietoon between Korte pieptonen
    # and Oplopende sirene, which reads as random.
    results.sort(key=lambda item: item["name"].lower())
    return results


async def async_scan_audio_files(hass: HomeAssistant) -> list[str]:
    """Return audio file URLs available under ``/config/www``."""
    www = hass.config.path("www")
    return await hass.async_add_executor_job(_scan_sync, www)


async def async_scan_builtin_sounds(
    hass: HomeAssistant,
) -> list[dict[str, str]]:
    """Return the alarm sounds shipped with NL-Alert."""
    return await hass.async_add_executor_job(_scan_builtin_sync)
