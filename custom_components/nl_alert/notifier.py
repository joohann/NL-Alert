"""Dispatch NL-Alert alerts to media player(s) and notify service(s).

Every public entry point returns a list of *step results* instead of
swallowing failures:

    [{"step": "alarm", "status": "ok", "detail": "…"}, …]

with ``status`` one of ``ok`` / ``skipped`` / ``error``. The panel renders
these inline per test button, the button entities raise a
``HomeAssistantError`` when any step errored (so HA shows a red toast
instead of nothing at all), and a real alert logs them.

Changelog:
  0.3.0 (2026-08-09): Rewritten after "het test alarm werkt niet" turned
                      out to be three independent silent failures on
                      Johann's setup, all hidden by a blanket
                      ``except Exception: _LOGGER.exception(...)``:

                        1. ``media_players`` pointed at
                           ``media_player.bedroom_2``, which no longer
                           exists (it is ``media_player.bedroom`` now).
                           ``volume_set`` raised, and because the alarm +
                           TTS shared one try-block the announcement never
                           ran either.
                        2. ``alarm_sound_url`` pointed at
                           ``/local/nida/sounds/Nadir [jingle] - Warning.mp3``
                           — Nida reorganised its sounds into subfolders,
                           so the file 404s. The URL was also passed
                           through unencoded (spaces and brackets) and
                           un-resolved (relative ``/local/…`` instead of
                           an absolute http URL, which most speakers can't
                           fetch).
                        3. ``tts_service`` was ``chime_tts.say`` without a
                           ``tts_platform``, which chime_tts needs to pick
                           an engine — so it produced no speech.

                      Fixes: pre-flight validation (async_validate), URL
                      resolution + quoting, per-step isolation so one
                      broken step can't cancel the next, and a rebuilt TTS
                      path that supports tts.speak (preferred), chime_tts
                      and legacy ``tts.*_say`` services.
"""
from __future__ import annotations

import asyncio
from datetime import time as dt_time
import io
import logging
import os
import time
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit
import uuid
import wave

from homeassistant.components.tts import async_get_media_source_audio
from homeassistant.components.tts.media_source import generate_media_source_id
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.network import NoURLAvailableError, get_url
from homeassistant.helpers.service import async_get_all_descriptions
from homeassistant.util import dt as dt_util

from .const import (
    CONF_ALARM_DURATION,
    CONF_ALARM_SOUND_URL,
    CONF_ANNOUNCE_LANGUAGE,
    CONF_CAST_AT_NIGHT,
    CONF_CAST_DASHBOARD,
    CONF_CAST_ENABLED,
    CONF_CAST_ENTITIES,
    CONF_CAST_ENTITY,
    CONF_CAST_POWER_ENTITIES,
    CONF_CAST_TURN_ON,
    CONF_CAST_VIEW,
    CONF_MEDIA_PLAYERS,
    CONF_NIGHT_ALARM_SOUND_URL,
    CONF_NIGHT_ENABLED,
    CONF_NIGHT_END,
    CONF_NIGHT_START,
    CONF_NIGHT_VOLUME_PCT,
    CONF_NOTIFY_CRITICAL,
    CONF_NOTIFY_SERVICES,
    CONF_NOTIFY_TTS_TARGETS,
    CONF_PREAMBLE,
    CONF_PREAMBLE_TEXT,
    CONF_SPEAK_ENGLISH,
    CONF_TRANSLATE_AGENT,
    CONF_TRANSLATE_MISSING,
    CONF_TTS_ENTITY,
    CONF_TTS_SERVICE,
    CONF_VOLUME_PCT,
    CAST_ASLEEP_STATES,
    CAST_WAKE_TIMEOUT,
    MEDIA_PLAYER_FEATURE_TURN_ON,
    DEFAULT_ALARM_DURATION,
    DEFAULT_NIGHT_END,
    DEFAULT_NIGHT_START,
    DEFAULT_NIGHT_VOLUME_PCT,
    DEFAULT_PREAMBLE,
    DEFAULT_TEST_MESSAGE,
    LANGUAGE_CANDIDATES,
    LANGUAGE_NAMES,
    DOMAIN,
    SEPARATOR,
    SOUNDS_URL_PATH,
    SPEECH_CACHE_MAX_AGE,
    SPEECH_URL_PATH,
    TEST_ALARM,
    TEST_ANNOUNCEMENT,
    TEST_CAST,
    TEST_FULL,
    TEST_NOTIFY,
)

_LOGGER = logging.getLogger(__name__)



# ── Step results ──────────────────────────────────────────────────────────────


def _step(step: str, status: str, detail: str = "") -> dict[str, str]:
    """Build one step result."""
    return {"step": step, "status": status, "detail": detail}


def has_errors(results: list[dict[str, str]]) -> bool:
    """Return True when any step failed."""
    return any(r["status"] == "error" for r in results)


def error_summary(results: list[dict[str, str]]) -> str:
    """Join all error details into one human-readable line."""
    return " ".join(r["detail"] for r in results if r["status"] == "error")


# ── Pure helpers ──────────────────────────────────────────────────────────────


def _dutch_part(message: str | None) -> str:
    """Return only the Dutch half — used for the push notification body."""
    return split_message(message)[0]


def _split_service(service: str | None) -> tuple[str, str] | None:
    """Split ``domain.service`` into ``(domain, service)``."""
    if not service or "." not in service:
        return None
    domain, _, name = service.partition(".")
    if not domain or not name:
        return None
    return domain, name


def _as_list(value: Any) -> list[str]:
    """Normalise to a non-empty list of strings."""
    if not value:
        return []
    if isinstance(value, str):
        return [value] if value else []
    return [v for v in value if v]


def make_test_alert(message: str | None = None) -> dict[str, Any]:
    """Construct a synthetic alert payload for previews / tests."""
    return {
        "id": "test",
        "type": "test",
        "message": message or DEFAULT_TEST_MESSAGE,
        "start_at": None,
        "stop_at": None,
        "area": [],
        "is_local": True,
        "is_active": True,
    }


def _parse_hhmm(value: Any, fallback: str) -> dt_time:
    """Parse an ``HH:MM`` string, falling back on anything unparseable."""
    for candidate in (value, fallback):
        if isinstance(candidate, str) and ":" in candidate:
            hour, _, minute = candidate.partition(":")
            try:
                return dt_time(int(hour) % 24, int(minute[:2]) % 60)
            except ValueError:
                continue
    return dt_time(0, 0)


def is_night(hass: HomeAssistant, options: dict[str, Any]) -> bool:
    """Is night mode active right now?

    A plain time window rather than a helper entity: this integration ships
    to other people's setups, and a window works everywhere without assuming
    the house already has something that tracks bedtime. Windows crossing
    midnight (the normal case) are handled.
    """
    if not options.get(CONF_NIGHT_ENABLED, True):
        return False

    now = dt_util.now().time()
    start = _parse_hhmm(options.get(CONF_NIGHT_START), DEFAULT_NIGHT_START)
    end = _parse_hhmm(options.get(CONF_NIGHT_END), DEFAULT_NIGHT_END)
    if start <= end:
        return start <= now < end
    return now >= start or now < end


def effective_volume(hass: HomeAssistant, options: dict[str, Any]) -> float | None:
    """Volume percentage to use, honouring night mode."""
    if is_night(hass, options):
        value = options.get(CONF_NIGHT_VOLUME_PCT, DEFAULT_NIGHT_VOLUME_PCT)
    else:
        value = options.get(CONF_VOLUME_PCT)
    if value is None:
        return None
    try:
        return max(0.0, min(100.0, float(value)))
    except (TypeError, ValueError):
        return None


def effective_alarm_sound(hass: HomeAssistant, options: dict[str, Any]) -> str:
    """Alarm sound to use, honouring the optional night-time override."""
    if is_night(hass, options):
        night_sound = options.get(CONF_NIGHT_ALARM_SOUND_URL)
        if night_sound:
            return night_sound
    return options.get(CONF_ALARM_SOUND_URL) or ""


def resolve_media_url(hass: HomeAssistant, url: str) -> str:
    """Turn a stored alarm-sound value into a URL a speaker can actually fetch.

    Two things happen here, both of which were missing before 0.3.0:

    * Relative ``/local/…`` paths are prefixed with Home Assistant's own
      base URL. A Sonos or ESPHome speaker resolves the URL itself and has
      no idea what ``/local`` means.
    * The path is percent-encoded. Johann's configured sound was
      ``/local/nida/sounds/Nadir [jingle] - Warning.mp3`` — spaces and
      brackets make that an invalid URL for most players.
    """
    if not url:
        return ""

    parts = urlsplit(url)
    # ``safe`` keeps the separators intact while escaping spaces, brackets, …
    encoded_path = quote(parts.path, safe="/-_.!~*'()")

    if parts.scheme:  # already absolute (http://, https://, media-source://)
        return urlunsplit(
            (parts.scheme, parts.netloc, encoded_path, parts.query, parts.fragment)
        )
    if not url.startswith("/"):
        return url  # e.g. a media_content_id we shouldn't touch

    try:
        base = get_url(hass, prefer_external=False)
    except NoURLAvailableError:
        try:
            base = get_url(hass)
        except NoURLAvailableError:
            _LOGGER.warning(
                "No Home Assistant base URL available; sending %s unresolved", url
            )
            return url
    return f"{base.rstrip('/')}{encoded_path}"


def _local_path(hass: HomeAssistant, url: str) -> str | None:
    """Map a locally served sound URL back to its file on disk, or None.

    Covers both ``/local/…`` (the user's own files in config/www) and
    ``/nl_alert_sounds/…`` (the sounds shipped with this integration).
    Returns None for anything else — an external URL can't be stat'ed.
    """
    if not url:
        return None
    if url.startswith("/local/"):
        return hass.config.path("www", url[len("/local/") :])
    prefix = f"{SOUNDS_URL_PATH}/"
    if url.startswith(prefix):
        name = url[len(prefix) :]
        if "/" in name or ".." in name:  # keep it inside sounds/
            return None
        return os.path.join(os.path.dirname(__file__), "sounds", name)
    return None


# ── Pre-flight validation ─────────────────────────────────────────────────────


async def async_validate(
    hass: HomeAssistant, options: dict[str, Any]
) -> list[dict[str, str]]:
    """Check the configuration and report anything that would break a dispatch.

    Returned entries look like the step results but carry a ``field`` key so
    the panel can highlight the offending setting.
    """
    problems: list[dict[str, str]] = []

    players = _as_list(options.get(CONF_MEDIA_PLAYERS))
    missing = [p for p in players if hass.states.get(p) is None]
    if missing:
        problems.append(
            {
                "field": CONF_MEDIA_PLAYERS,
                "status": "error",
                "detail": (
                    "Deze media player(s) bestaan niet (meer): "
                    + ", ".join(missing)
                ),
            }
        )

    sound = options.get(CONF_ALARM_SOUND_URL)
    if sound:
        path = _local_path(hass, sound)
        if path and not await hass.async_add_executor_job(os.path.isfile, path):
            problems.append(
                {
                    "field": CONF_ALARM_SOUND_URL,
                    "status": "error",
                    "detail": (
                        f"Het alarmgeluid bestaat niet: {sound} — kies een "
                        "van de meegeleverde NL-Alert geluiden."
                    ),
                }
            )

    tts_service = options.get(CONF_TTS_SERVICE)
    tts_entity = options.get(CONF_TTS_ENTITY)
    if tts_service:
        target = _split_service(tts_service)
        if target and not hass.services.has_service(*target):
            problems.append(
                {
                    "field": CONF_TTS_SERVICE,
                    "status": "error",
                    "detail": f"De TTS-service {tts_service} bestaat niet.",
                }
            )
        elif tts_service in ("tts.speak", "chime_tts.say") and not tts_entity:
            problems.append(
                {
                    "field": CONF_TTS_ENTITY,
                    "status": "error",
                    "detail": (
                        f"{tts_service} heeft een TTS-engine nodig. "
                        "Kies er een bij 'Stem'."
                    ),
                }
            )
        elif tts_entity and hass.states.get(tts_entity) is None:
            problems.append(
                {
                    "field": CONF_TTS_ENTITY,
                    "status": "error",
                    "detail": f"De TTS-engine {tts_entity} bestaat niet (meer).",
                }
            )

    night_sound = options.get(CONF_NIGHT_ALARM_SOUND_URL)
    if night_sound:
        path = _local_path(hass, night_sound)
        if path and not await hass.async_add_executor_job(os.path.isfile, path):
            problems.append(
                {
                    "field": CONF_NIGHT_ALARM_SOUND_URL,
                    "status": "error",
                    "detail": f"Het nachtgeluid bestaat niet: {night_sound}",
                }
            )

    if (
        tts_service
        and options.get(CONF_SPEAK_ENGLISH, True)
        and options.get(CONF_TRANSLATE_MISSING, True)
    ):
        agent = options.get(CONF_TRANSLATE_AGENT)
        if agent and hass.states.get(agent) is None:
            problems.append(
                {
                    "field": CONF_TRANSLATE_AGENT,
                    "status": "error",
                    "detail": f"De vertaler {agent} bestaat niet (meer).",
                }
            )
        elif not agent and not hass.states.async_all("ai_task"):
            problems.append(
                {
                    "field": CONF_TRANSLATE_AGENT,
                    "status": "warning",
                    "detail": (
                        "Geen AI Task-entiteit gevonden: alerts zonder Engelse "
                        "tekst worden alleen in het Nederlands uitgesproken."
                    ),
                }
            )

    for service in _as_list(options.get(CONF_NOTIFY_SERVICES)):
        target = _split_service(service)
        if not target or not hass.services.has_service(*target):
            problems.append(
                {
                    "field": CONF_NOTIFY_SERVICES,
                    "status": "error",
                    "detail": f"De notify-service {service} bestaat niet (meer).",
                }
            )

    if not players and not options.get(CONF_NOTIFY_SERVICES):
        problems.append(
            {
                "field": CONF_MEDIA_PLAYERS,
                "status": "warning",
                "detail": (
                    "Er is geen speaker en geen notificatie ingesteld — "
                    "een alert doet dan niets."
                ),
            }
        )

    return problems


# ── Low-level building blocks ─────────────────────────────────────────────────


async def _async_play_alarm_sound(
    hass: HomeAssistant, options: dict[str, Any]
) -> list[dict[str, str]]:
    """Set volume and play the alarm sound on the configured media players."""
    results: list[dict[str, str]] = []
    media_players = _as_list(options.get(CONF_MEDIA_PLAYERS))
    if not media_players:
        return [_step("alarm", "skipped", "Geen media players ingesteld.")]

    missing = [p for p in media_players if hass.states.get(p) is None]
    available = [p for p in media_players if p not in missing]
    if missing:
        results.append(
            _step(
                "alarm",
                "error",
                "Onbekende media player(s): " + ", ".join(missing) + ".",
            )
        )
    if not available:
        return results

    night = is_night(hass, options)
    if night:
        results.append(
            _step("alarm", "ok", "Nachtmodus actief: zachter volume.")
        )

    volume_pct = effective_volume(hass, options)
    if volume_pct is not None:
        volume_level = max(0.0, min(1.0, volume_pct / 100.0))
        try:
            await hass.services.async_call(
                "media_player",
                "volume_set",
                {"entity_id": available, "volume_level": volume_level},
                blocking=True,
            )
        except Exception as err:  # noqa: BLE001
            # Not fatal — a speaker that refuses volume_set can usually still
            # play. Before 0.3.0 this exception aborted the whole dispatch,
            # including the TTS announcement.
            _LOGGER.warning("NL-Alert: kon volume niet zetten: %s", err)
            results.append(
                _step("alarm", "warning", f"Volume zetten mislukt: {err}")
            )

    alarm_url = effective_alarm_sound(hass, options)
    if not alarm_url:
        results.append(_step("alarm", "skipped", "Geen alarmgeluid ingesteld."))
        return results

    path = _local_path(hass, alarm_url)
    if path and not await hass.async_add_executor_job(os.path.isfile, path):
        results.append(
            _step("alarm", "error", f"Bestand niet gevonden: {alarm_url}")
        )
        return results

    try:
        await hass.services.async_call(
            "media_player",
            "play_media",
            {
                "entity_id": available,
                "media_content_id": resolve_media_url(hass, alarm_url),
                "media_content_type": "music",
            },
            blocking=True,
        )
    except Exception as err:  # noqa: BLE001
        _LOGGER.exception("NL-Alert: afspelen alarmgeluid mislukt")
        results.append(_step("alarm", "error", f"Afspelen mislukt: {err}"))
        return results

    results.append(
        _step("alarm", "ok", "Alarmgeluid gestart op " + ", ".join(available) + ".")
    )
    return results


async def _chime_tts_platform(hass: HomeAssistant, tts_entity: str) -> str:
    """Translate a tts.* entity into a value chime_tts understands.

    chime_tts takes either a legacy platform name ("cloud",
    "google_translate") or a "tts.<entity>" id for entity-based engines, and
    the exact set depends on the installed chime_tts version. Rather than
    hardcoding that list, read the options straight out of chime_tts's own
    service description — the same data HA renders in its service UI — so a
    chime_tts update can't leave a stale copy behind here.
    """
    registry = er.async_get(hass)
    entry = registry.async_get(tts_entity)
    platform = entry.platform if entry else None

    known: set[str] = set()
    try:
        descriptions = await async_get_all_descriptions(hass)
        options = descriptions["chime_tts"]["say"]["fields"]["tts_platform"][
            "selector"
        ]["select"]["options"]
        known = {
            option["value"] if isinstance(option, dict) else option
            for option in options
        }
    except (KeyError, TypeError):
        _LOGGER.debug("Could not read chime_tts tts_platform options")

    if platform and platform in known:
        return platform
    if tts_entity in known:
        return tts_entity
    # Neither is advertised (or the description couldn't be read). The entity
    # id is the safer guess: chime_tts's own selector allows custom values and
    # lists entity-based engines exactly that way.
    return tts_entity


def split_message(message: str | None) -> tuple[str, str]:
    """Split an NL-Alert message into its Dutch and English halves.

    The feed puts the English translation after a ``***`` separator. A few
    messages carry more than one separator; everything after the first is
    treated as the English half.
    """
    if not message:
        return "", ""
    head, sep, tail = message.partition(SEPARATOR)
    return head.strip(), tail.replace(SEPARATOR, " ").strip() if sep else ""


async def async_translate_to_english(
    hass: HomeAssistant, options: dict[str, Any], text: str
) -> tuple[str, str | None]:
    """Translate ``text`` to English with an AI Task entity.

    Returns ``(translation, error)``. ai_task is HA's own vendor-neutral
    entry point for this, so whichever LLM integration the user has set up
    (OpenAI, Gemini, Ollama, …) works without special-casing any of them.
    """
    agent = options.get(CONF_TRANSLATE_AGENT)
    if not agent:
        candidates = [state.entity_id for state in hass.states.async_all("ai_task")]
        if not candidates:
            return "", "Geen AI Task-entiteit gevonden om mee te vertalen."
        agent = sorted(candidates)[0]

    if hass.states.get(agent) is None:
        return "", f"AI Task-entiteit {agent} bestaat niet (meer)."

    try:
        response = await hass.services.async_call(
            "ai_task",
            "generate_data",
            {
                "task_name": "NL-Alert translation",
                "entity_id": agent,
                "instructions": (
                    "Translate the following Dutch emergency alert into "
                    "English. Keep it short and factual, keep place names as "
                    "they are, and reply with the translation only — no "
                    "preamble, no quotes.\n\n" + text
                ),
            },
            blocking=True,
            return_response=True,
        )
    except Exception as err:  # noqa: BLE001
        _LOGGER.exception("NL-Alert: vertalen mislukt")
        return "", f"Vertalen mislukt: {err}"

    translated = (response or {}).get("data")
    if not isinstance(translated, str) or not translated.strip():
        return "", "De vertaler gaf geen bruikbare tekst terug."
    return translated.strip(), None


async def async_build_segments(
    hass: HomeAssistant, options: dict[str, Any], message: str | None
) -> tuple[list[tuple[str, str]], list[dict[str, str]]]:
    """Build the ``(language, text)`` list to speak, plus any step results.

    Dutch first, then English — the same order the alert itself uses.
    """
    dutch, english = split_message(message)
    steps: list[dict[str, str]] = []
    segments: list[tuple[str, str]] = []

    if dutch:
        segments.append(("nl", dutch))

    if options.get(CONF_SPEAK_ENGLISH, True):
        if english:
            segments.append(("en", english))
        elif dutch and options.get(CONF_TRANSLATE_MISSING, True):
            translated, error = await async_translate_to_english(
                hass, options, dutch
            )
            if translated:
                segments.append(("en", translated))
                steps.append(
                    _step("tts", "ok", "Engelse tekst ontbrak en is vertaald.")
                )
            else:
                steps.append(_step("tts", "warning", error or "Vertalen mislukt."))

    if not segments:
        return segments, steps

    preamble = ""
    if options.get(CONF_PREAMBLE, True):
        preamble = (options.get(CONF_PREAMBLE_TEXT) or DEFAULT_PREAMBLE).strip()

    if options.get(CONF_ANNOUNCE_LANGUAGE, True) and len(segments) > 1:
        announced = []
        for index, (lang, text) in enumerate(segments):
            # "Nederlands." right after a Dutch preamble is noise — the
            # listener just heard a Dutch sentence. The English half still
            # gets its announcement, which is where the cue actually helps.
            if index == 0 and preamble and lang == "nl":
                announced.append((lang, text))
            else:
                announced.append(
                    (lang, f"{LANGUAGE_NAMES.get(lang, '')} {text}".strip())
                )
        segments = announced

    if preamble:
        lang, text = segments[0]
        segments[0] = (lang, f"{preamble} {text}".strip())

    return segments, steps


async def _async_await_playback(
    hass: HomeAssistant, players: list[str], *, settle: float = 1.5, timeout: float = 90.0
) -> None:
    """Wait until the players stop playing, so segments don't overlap.

    ``blocking=True`` on a TTS call returns once the audio is queued, not once
    it has been heard — without this the English half would talk over the
    Dutch one.
    """
    await asyncio.sleep(settle)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        still_playing = False
        for player in players:
            state = hass.states.get(player)
            if state is not None and state.state == "playing":
                still_playing = True
                break
        if not still_playing:
            return
        await asyncio.sleep(0.5)
    _LOGGER.debug("NL-Alert: playback wait timed out after %ss", timeout)


async def _async_speak_once(
    hass: HomeAssistant,
    options: dict[str, Any],
    players: list[str],
    language: str,
    text: str,
) -> dict[str, str]:
    """Speak one segment, trying the language codes the engine may expect."""
    tts_service = options.get(CONF_TTS_SERVICE)
    tts_entity = options.get(CONF_TTS_ENTITY)
    domain, service = _split_service(tts_service)  # validated by the caller

    async def _call(lang: str | None) -> None:
        if tts_service == "tts.speak":
            data: dict[str, Any] = {
                "entity_id": tts_entity,
                "media_player_entity_id": players,
                "message": text,
                "cache": True,
            }
            if lang:
                data["language"] = lang
        elif domain == "chime_tts":
            data = {
                "entity_id": players,
                "message": text,
                "tts_platform": await _chime_tts_platform(hass, tts_entity),
            }
            if lang:
                data["language"] = lang
            volume_pct = effective_volume(hass, options)
            if volume_pct is not None:
                data["volume_level"] = max(0.0, min(1.0, volume_pct / 100.0))
        else:
            # Legacy tts.<platform>_say services.
            data = {"entity_id": players, "message": text}
            if lang:
                data["language"] = lang
        await hass.services.async_call(domain, service, data, blocking=True)

    # Bare code first, then regional variants, then no language at all: engines
    # disagree about which they accept and a rejected code raises before any
    # audio is produced, so retrying costs nothing but a failed validation.
    candidates: list[str | None] = list(
        LANGUAGE_CANDIDATES.get(language, [language])
    )
    candidates.append(None)

    last_error: Exception | None = None
    for candidate in candidates:
        try:
            await _call(candidate)
        except Exception as err:  # noqa: BLE001
            last_error = err
            continue
        else:
            return _step(
                "tts",
                "ok",
                f"{LANGUAGE_NAMES.get(language, language)} uitgesproken"
                + (f" ({candidate})." if candidate else " (zonder taalcode)."),
            )

    _LOGGER.error("NL-Alert: TTS voor '%s' mislukt: %s", language, last_error)
    return _step("tts", "error", f"TTS mislukt voor {language}: {last_error}")


def speech_cache_dir(hass: HomeAssistant) -> str:
    """Directory holding pre-rendered speech clips."""
    if hasattr(hass.config, "cache_path"):
        return hass.config.cache_path(DOMAIN)
    return hass.config.path(f".{DOMAIN}_cache")


def _prune_speech_cache(directory: str) -> None:
    """Delete rendered clips older than SPEECH_CACHE_MAX_AGE."""
    cutoff = time.time() - SPEECH_CACHE_MAX_AGE
    try:
        for name in os.listdir(directory):
            path = os.path.join(directory, name)
            try:
                if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                    os.remove(path)
            except OSError:
                continue
    except OSError:
        pass


def _concatenate(parts: list[tuple[str, bytes]]) -> tuple[str, bytes] | None:
    """Join rendered segments into one clip, or None if they can't be joined.

    MP3 is a stream of self-contained frames, so appending the bytes yields a
    file every decoder plays — this is what ``cat a.mp3 b.mp3`` relies on.
    WAV needs its header rewritten, which the stdlib ``wave`` module does.
    Anything else (or a mix of formats) is left to the caller to handle.
    """
    extensions = {ext for ext, _ in parts}
    if len(extensions) != 1:
        return None
    extension = extensions.pop()

    if extension == "mp3":
        return extension, b"".join(data for _, data in parts)

    if extension == "wav":
        frames: list[bytes] = []
        params = None
        for _, data in parts:
            with wave.open(io.BytesIO(data), "rb") as handle:
                if params is None:
                    params = handle.getparams()
                elif handle.getparams()[:3] != params[:3]:
                    return None  # different channels/width/rate
                frames.append(handle.readframes(handle.getnframes()))
        if params is None:
            return None
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as out:
            out.setnchannels(params.nchannels)
            out.setsampwidth(params.sampwidth)
            out.setframerate(params.framerate)
            out.writeframes(b"".join(frames))
        return extension, buffer.getvalue()

    return None


async def _async_render_segment(
    hass: HomeAssistant, engine: str, language: str, text: str
) -> tuple[str, bytes]:
    """Render one segment to audio, trying the language codes the engine takes."""
    last_error: Exception | None = None
    for candidate in [*LANGUAGE_CANDIDATES.get(language, [language]), None]:
        try:
            media_id = generate_media_source_id(
                hass, text, engine=engine, language=candidate, cache=True
            )
            return await async_get_media_source_audio(hass, media_id)
        except Exception as err:  # noqa: BLE001
            last_error = err
            continue
    raise last_error or HomeAssistantError("Kon geen audio genereren")


async def _async_speak_prerendered(
    hass: HomeAssistant,
    options: dict[str, Any],
    players: list[str],
    segments: list[tuple[str, str]],
) -> list[dict[str, str]] | None:
    """Render every segment first, then play them as one clip.

    Returns None when this route isn't usable, so the caller can fall back to
    speaking segment by segment.

    Why: ``tts.speak`` returns as soon as the audio is queued, not when it has
    been heard, so playing the halves one after another means waiting on the
    media player's state — and generating the English half only starts after
    the Dutch one has finished. Rendering both up front (concurrently) and
    stitching them into a single file removes both the generation gap and the
    guesswork.
    """
    engine = options.get(CONF_TTS_ENTITY)
    if not engine:
        return None

    try:
        parts = await asyncio.gather(
            *(
                _async_render_segment(hass, engine, language, text)
                for language, text in segments
            )
        )
    except Exception as err:  # noqa: BLE001
        _LOGGER.warning(
            "NL-Alert: vooraf renderen mislukt (%s), val terug op los afspelen",
            err,
        )
        return None

    joined = _concatenate(list(parts))
    if joined is None:
        _LOGGER.debug(
            "NL-Alert: kan formaten %s niet samenvoegen",
            {ext for ext, _ in parts},
        )
        return None

    extension, data = joined
    directory = speech_cache_dir(hass)
    filename = f"speech-{uuid.uuid4().hex}.{extension}"
    path = os.path.join(directory, filename)

    def _write() -> None:
        os.makedirs(directory, exist_ok=True)
        _prune_speech_cache(directory)
        with open(path, "wb") as handle:
            handle.write(data)

    try:
        await hass.async_add_executor_job(_write)
    except OSError as err:
        _LOGGER.warning("NL-Alert: kon speech-bestand niet schrijven: %s", err)
        return None

    try:
        await hass.services.async_call(
            "media_player",
            "play_media",
            {
                "entity_id": players,
                "media_content_id": resolve_media_url(
                    hass, f"{SPEECH_URL_PATH}/{filename}"
                ),
                "media_content_type": "music",
            },
            blocking=True,
        )
    except Exception as err:  # noqa: BLE001
        _LOGGER.exception("NL-Alert: afspelen van het gerenderde bericht mislukt")
        return [_step("tts", "error", f"Afspelen mislukt: {err}")]

    spoken = ", ".join(LANGUAGE_NAMES.get(lang, lang).rstrip(".") for lang, _ in segments)
    return [
        _step(
            "tts",
            "ok",
            f"{spoken} als één clip afgespeeld ({len(data) // 1024} kB).",
        )
    ]


async def _async_speak(
    hass: HomeAssistant, options: dict[str, Any], message: str
) -> list[dict[str, str]]:
    """Speak the alert on the configured media players, Dutch then English."""
    media_players = _as_list(options.get(CONF_MEDIA_PLAYERS))
    tts_service = options.get(CONF_TTS_SERVICE)
    tts_entity = options.get(CONF_TTS_ENTITY)

    if not message:
        return [_step("tts", "skipped", "Geen tekst om uit te spreken.")]
    if not media_players:
        return [_step("tts", "skipped", "Geen media players ingesteld.")]
    if not tts_service:
        return [_step("tts", "skipped", "Geen TTS-service ingesteld.")]

    target = _split_service(tts_service)
    if not target or not hass.services.has_service(*target):
        return [_step("tts", "error", f"TTS-service {tts_service} bestaat niet.")]

    if tts_service in ("tts.speak", "chime_tts.say") and not tts_entity:
        return [
            _step(
                "tts",
                "error",
                f"{tts_service} heeft een TTS-engine nodig (veld 'Stem').",
            )
        ]

    available = [p for p in media_players if hass.states.get(p) is not None]
    if not available:
        return [_step("tts", "error", "Geen bruikbare media player.")]

    segments, results = await async_build_segments(hass, options, message)
    if not segments:
        return [*results, _step("tts", "skipped", "Geen tekst om uit te spreken.")]

    # Two or more halves: render them up front and play one stitched clip, so
    # there is no silence between Dutch and English. Only possible with a real
    # TTS engine — chime_tts runs its own pipeline and keeps the step-by-step
    # route below.
    if len(segments) > 1 and tts_service == "tts.speak":
        prerendered = await _async_speak_prerendered(
            hass, options, available, segments
        )
        if prerendered is not None:
            return [*results, *prerendered]

    for index, (language, text) in enumerate(segments):
        if index:
            # Fallback route: wait for the previous half to finish, otherwise
            # the next one talks over it.
            await _async_await_playback(hass, available)
        results.append(
            await _async_speak_once(hass, options, available, language, text)
        )

    return results


def cast_targets(options: dict[str, Any]) -> list[str]:
    """The TVs to cast to.

    ``cast_entities`` is a list; ``cast_entity`` is the single-value key this
    setting started out as and is still honoured so an existing config keeps
    working after the upgrade.
    """
    targets = _as_list(options.get(CONF_CAST_ENTITIES))
    if not targets:
        targets = _as_list(options.get(CONF_CAST_ENTITY))
    return targets


def should_cast(hass: HomeAssistant, options: dict[str, Any]) -> tuple[bool, str]:
    """Should this alert go to the TV(s)? Returns (yes, reason-when-no)."""
    if not options.get(CONF_CAST_ENABLED):
        return False, "Casten naar de TV staat uit."
    if not cast_targets(options):
        return False, "Geen TV gekozen."
    if not options.get(CONF_CAST_VIEW):
        return False, "Geen view ingesteld om te casten."
    if is_night(hass, options) and not options.get(CONF_CAST_AT_NIGHT, False):
        return False, "Nachtmodus: er gaat niets naar de TV."
    return True, ""


def _supports_turn_on(hass: HomeAssistant, entity_id: str) -> bool:
    """Does this media_player advertise TURN_ON?"""
    state = hass.states.get(entity_id)
    if state is None:
        return False
    try:
        features = int(state.attributes.get("supported_features") or 0)
    except (TypeError, ValueError):
        return False
    return bool(features & MEDIA_PLAYER_FEATURE_TURN_ON)


async def _async_wake_tvs(
    hass: HomeAssistant, options: dict[str, Any]
) -> list[dict[str, str]]:
    """Power on the TVs before casting, and wait until they respond.

    Casting to a set that is fully off usually shows nothing: the cast
    receiver is not running yet, and HDMI-CEC wake-on-cast is unreliable on
    Philips/Android TVs. Turning it on first — and giving it a moment — is
    the difference between "it works" and "nothing happened".
    """
    if not options.get(CONF_CAST_TURN_ON, True):
        return []

    results: list[dict[str, str]] = []
    targets = cast_targets(options)
    asleep = [
        entity
        for entity in targets
        if (state := hass.states.get(entity)) is not None
        and state.state in CAST_ASLEEP_STATES
    ]

    # Extra power entities first: a remote or CEC switch usually wakes the set
    # that the cast entity itself can't. homeassistant.turn_on dispatches to
    # whatever domain each entity belongs to, so this works for remote.*,
    # media_player.*, switch.* and script.* alike.
    extras = _as_list(options.get(CONF_CAST_POWER_ENTITIES))
    if extras and asleep:
        try:
            await hass.services.async_call(
                "homeassistant", "turn_on", {"entity_id": extras}, blocking=True
            )
            results.append(
                _step("cast", "ok", "Aangezet via " + ", ".join(extras) + ".")
            )
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("NL-Alert: aanzetten via %s mislukt: %s", extras, err)
            results.append(
                _step("cast", "warning", f"Aanzetten via {extras} mislukt: {err}")
            )

    wakeable = [e for e in asleep if _supports_turn_on(hass, e)]
    if wakeable:
        try:
            await hass.services.async_call(
                "media_player", "turn_on", {"entity_id": wakeable}, blocking=True
            )
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("NL-Alert: TV aanzetten mislukt: %s", err)
            results.append(_step("cast", "warning", f"TV aanzetten mislukt: {err}"))

    if not asleep:
        return results
    if not extras and not wakeable:
        results.append(
            _step(
                "cast",
                "warning",
                "TV staat uit en kan niet worden aangezet — kies bij "
                "'Aanzetten via' een entiteit die dat wel kan "
                "(bijv. de Android TV remote).",
            )
        )
        return results

    # Give the set time to boot far enough to accept a cast.
    deadline = time.monotonic() + CAST_WAKE_TIMEOUT
    while time.monotonic() < deadline:
        still_off = [
            entity
            for entity in asleep
            if (state := hass.states.get(entity)) is None
            or state.state in CAST_ASLEEP_STATES
        ]
        if not still_off:
            return results
        await asyncio.sleep(1)

    results.append(
        _step(
            "cast",
            "warning",
            f"TV was na {CAST_WAKE_TIMEOUT}s nog niet wakker; casten wordt "
            "toch geprobeerd.",
        )
    )
    return results


async def _async_cast(
    hass: HomeAssistant, options: dict[str, Any]
) -> list[dict[str, str]]:
    """Show the configured Lovelace view on the configured Chromecast."""
    allowed, reason = should_cast(hass, options)
    if not allowed:
        return [_step("cast", "skipped", reason)]

    if not hass.services.has_service("cast", "show_lovelace_view"):
        return [
            _step(
                "cast",
                "error",
                "De Google Cast-integratie is niet actief in Home Assistant.",
            )
        ]

    view = options.get(CONF_CAST_VIEW)
    dashboard = options.get(CONF_CAST_DASHBOARD)
    where = f"{dashboard}/" if dashboard else ""

    results: list[dict[str, str]] = await _async_wake_tvs(hass, options)
    reached: list[str] = []
    # cast.show_lovelace_view takes a single entity_id (cv.entity_id), so
    # several TVs means several calls. One failing TV must not stop the rest.
    for entity in cast_targets(options):
        if hass.states.get(entity) is None:
            results.append(
                _step("cast", "error", f"De TV {entity} bestaat niet (meer).")
            )
            continue

        data: dict[str, Any] = {"entity_id": entity, "view_path": view}
        if dashboard:
            data["dashboard_path"] = dashboard

        try:
            await hass.services.async_call(
                "cast", "show_lovelace_view", data, blocking=True
            )
        except Exception as err:  # noqa: BLE001
            _LOGGER.exception("NL-Alert: casten naar %s mislukt", entity)
            # The usual cause is the instance not being reachable over HTTPS,
            # which HA Cast requires; say so rather than only echoing the error.
            results.append(
                _step(
                    "cast",
                    "error",
                    f"{entity}: {err} — HA Cast vereist dat je instantie via "
                    "HTTPS bereikbaar is (Nabu Casa Cloud of een eigen externe "
                    "URL met geldig certificaat).",
                )
            )
        else:
            reached.append(entity)

    if reached:
        results.append(
            _step("cast", "ok", f"{where}{view} op " + ", ".join(reached) + ".")
        )
    return results


def _critical_notify_data() -> dict[str, Any]:
    """Extra ``data`` asking the companion apps for a critical alert.

    Both the iOS and the Android keys go out on every call rather than
    guessing the platform from the service name — device names are
    user-chosen, so "notify.mobile_app_iphone_johann" proves nothing. Each
    app ignores the other's keys.

    iOS: interruption-level critical + push.sound.critical. Only actually
    bypasses silent/Focus if the app carries Apple's critical-alert
    entitlement; without it iOS quietly downgrades to a normal high-priority
    notification and there is no way to detect that from here.

    Android: ``channel: "alarm_stream"`` is a reserved value, not a display
    name — it routes the sound over the alarm stream, the one stream that
    rings through silent/DND. A custom channel name only affects heads-up
    importance, which is fixed at channel-creation time and can't be changed
    remotely afterwards.
    """
    return {
        "push": {"sound": {"name": "default", "critical": 1, "volume": 1.0}},
        "interruption-level": "critical",
        "channel": "alarm_stream",
        "importance": "high",
        "priority": "high",
        "ttl": 0,
    }


def _tts_notify_data(message: str) -> dict[str, Any]:
    """Full service data for a spoken notification.

    Several Samsung/OneUI builds ignore ``channel: alarm_stream`` on a normal
    notification outright — an OEM restriction on overriding a notification's
    audio attributes, not something any channel/importance combination gets
    around. What does work there: don't send a normal notification at all,
    send a TTS one, which the companion app plays through the alarm stream
    via its own code path. ``message: "TTS"`` is a literal marker the app
    checks for; the real text rides in ``data.tts_text``.

    Hence a full service_data rather than just a ``data`` dict: TTS mode has
    a different top-level shape and carries no title.
    """
    return {
        "message": "TTS",
        "data": {
            "tts_text": message,
            "media_stream": "alarm_stream_max",
            "ttl": 0,
            "priority": "high",
        },
    }


def notify_payload(
    options: dict[str, Any], target: str, title: str, message: str
) -> dict[str, Any]:
    """Build the service data for one notify target."""
    critical = options.get(CONF_NOTIFY_CRITICAL, True)
    if critical and target in set(_as_list(options.get(CONF_NOTIFY_TTS_TARGETS))):
        return _tts_notify_data(message)
    payload: dict[str, Any] = {"title": title, "message": message}
    if critical:
        payload["data"] = _critical_notify_data()
    return payload


async def _async_notify(
    hass: HomeAssistant, options: dict[str, Any], title: str, message: str
) -> list[dict[str, str]]:
    """Send a push notification to all configured notify services."""
    services = _as_list(options.get(CONF_NOTIFY_SERVICES))
    if not services:
        return [_step("notify", "skipped", "Geen notify-services ingesteld.")]
    if not message:
        return [_step("notify", "skipped", "Geen tekst om te versturen.")]

    results: list[dict[str, str]] = []
    sent: list[str] = []
    for full_service in services:
        target = _split_service(full_service)
        if not target or not hass.services.has_service(*target):
            results.append(
                _step("notify", "error", f"Onbekende service: {full_service}.")
            )
            continue
        domain, service = target
        try:
            await hass.services.async_call(
                domain,
                service,
                notify_payload(options, full_service, title, message),
                blocking=True,
            )
        except Exception as err:  # noqa: BLE001
            _LOGGER.exception(
                "Error sending NL-Alert notification via %s", full_service
            )
            results.append(_step("notify", "error", f"{full_service}: {err}"))
        else:
            sent.append(full_service)

    if sent:
        how = "kritiek" if options.get(CONF_NOTIFY_CRITICAL, True) else "normaal"
        results.append(
            _step("notify", "ok", f"Verstuurd ({how}) naar " + ", ".join(sent) + ".")
        )
    return results


# ── Public API ────────────────────────────────────────────────────────────────


async def async_dispatch_alert(
    hass: HomeAssistant,
    options: dict[str, Any],
    alert: dict[str, Any],
) -> list[dict[str, str]]:
    """Run the full pipeline for one alert: media (alarm + TTS) + notify."""
    # Speech gets the whole message so it can do Dutch then English; the push
    # notification keeps just the Dutch half, since the phone shows text and
    # the reader can stop when they've understood it.
    full_message = (alert.get("message") or "").strip()
    message = _dutch_part(full_message)
    alert_type = (alert.get("type") or "alert").capitalize()
    title = f"NL-Alert ({alert_type})"
    alarm_duration = int(options.get(CONF_ALARM_DURATION) or DEFAULT_ALARM_DURATION)

    results: list[dict[str, str]] = []

    if options.get(CONF_MEDIA_PLAYERS):
        alarm_results = await _async_play_alarm_sound(hass, options)
        results.extend(alarm_results)
        played = any(
            r["step"] == "alarm" and r["status"] == "ok" for r in alarm_results
        )
        if played and alarm_duration > 0:
            await asyncio.sleep(alarm_duration)
        # The announcement runs even when the alarm sound failed — losing the
        # chime is annoying, losing the actual warning is not acceptable.
        results.extend(await _async_speak(hass, options, full_message))

    results.extend(await _async_notify(hass, options, title, message))
    results.extend(await _async_cast(hass, options))

    if has_errors(results):
        _LOGGER.error("NL-Alert dispatch had errors: %s", error_summary(results))
    return results


async def async_run_test(
    hass: HomeAssistant,
    options: dict[str, Any],
    kind: str = TEST_FULL,
    message: str | None = None,
) -> list[dict[str, str]]:
    """Run one of the four tests and return its step results."""
    if kind == TEST_FULL:
        return await async_dispatch_alert(hass, options, make_test_alert(message))

    full_message = (message or DEFAULT_TEST_MESSAGE).strip()

    if kind == TEST_ALARM:
        return await _async_play_alarm_sound(hass, options)

    if kind == TEST_ANNOUNCEMENT:
        results = await _async_play_alarm_sound(hass, options)
        played = any(r["status"] == "ok" for r in results)
        duration = int(options.get(CONF_ALARM_DURATION) or DEFAULT_ALARM_DURATION)
        if played and duration > 0:
            await asyncio.sleep(duration)
        results.extend(await _async_speak(hass, options, full_message))
        return results

    if kind == TEST_NOTIFY:
        return await _async_notify(
            hass, options, "NL-Alert (TEST)", _dutch_part(full_message)
        )

    if kind == TEST_CAST:
        # Deliberately runs through the same gate as a real alert, so a
        # "skipped: nachtmodus" here is the truth about tonight, not a
        # different code path pretending everything is fine.
        return await _async_cast(hass, options)

    return [_step(kind, "error", f"Onbekend testtype: {kind}")]


# Thin wrappers kept so button.py / __init__.py read naturally.


async def async_test_alarm_sound(
    hass: HomeAssistant, options: dict[str, Any]
) -> list[dict[str, str]]:
    """Test: only play the alarm sound."""
    return await async_run_test(hass, options, TEST_ALARM)


async def async_test_announcement(
    hass: HomeAssistant, options: dict[str, Any], message: str | None = None
) -> list[dict[str, str]]:
    """Test: play alarm + speak the test message (no push notification)."""
    return await async_run_test(hass, options, TEST_ANNOUNCEMENT, message)


async def async_test_notify(
    hass: HomeAssistant, options: dict[str, Any], message: str | None = None
) -> list[dict[str, str]]:
    """Test: only send the push notification."""
    return await async_run_test(hass, options, TEST_NOTIFY, message)


async def async_test_full(
    hass: HomeAssistant, options: dict[str, Any], message: str | None = None
) -> list[dict[str, str]]:
    """Test: complete alert (alarm + TTS + push)."""
    return await async_run_test(hass, options, TEST_FULL, message)
