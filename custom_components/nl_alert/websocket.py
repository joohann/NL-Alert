"""Websocket API backing the NL-Alert panel.

The panel (frontend/nl-alert-panel.js) is the only consumer. Everything it
needs — current settings, the pick-lists behind each dropdown, the four
tests, and the live alert feed for the national map — goes through here so
the frontend never has to touch ``hass.callService`` or the config-entry
internals directly.

Commands:
  nl_alert/get_config         → merged data+options, validation, HA location
  nl_alert/save_config        → write options (admin only), reloads the entry
  nl_alert/list_media_players → media_player entities
  nl_alert/list_notify_services → notify.* services
  nl_alert/list_tts_services  → tts.* entities + whether chime_tts is present
  nl_alert/list_audio_files   → /local/**.mp3 etc.
  nl_alert/test               → run one test, return per-step results
  nl_alert/get_alerts         → national + local alerts incl. parsed polygons
  nl_alert/refresh            → force a coordinator poll

New in 0.3.0 (2026-08-09).
"""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util

from .audio_scan import async_scan_audio_files, async_scan_builtin_sounds
from .const import (
    CONF_LATITUDE,
    CONF_LONGITUDE,
    CONF_MAP_ATTRIBUTION,
    CONF_MAP_TILE_URL,
    CONF_USE_HOME_LOCATION,
    DOMAIN,
    DEFAULT_MAP_ATTRIBUTION,
    DEFAULT_MAP_TILE_URL,
    MEDIA_PLAYER_FEATURE_TURN_ON,
    NL_BOUNDS,
    POLLING_CHOICES,
    TEST_ALARM,
    TEST_ANNOUNCEMENT,
    TEST_CAST,
    TEST_FULL,
    TEST_NOTIFY,
)
from .geo import parse_polygon, polygons_bbox
from .siren_test import async_holiday_entity, next_siren_test
from .notifier import async_run_test, async_validate

_LOGGER = logging.getLogger(__name__)

# Options the panel is allowed to write. Anything else in the payload is
# dropped — the panel is trusted, but a typo shouldn't be able to inject
# arbitrary keys into the config entry.
_WRITABLE_KEYS = {
    "use_home_location",
    "latitude",
    "longitude",
    "scan_interval_minutes",
    "alert_radius_km",
    "media_players",
    "alarm_sound_url",
    "alarm_duration_seconds",
    "volume_pct",
    "night_enabled",
    "night_start",
    "night_end",
    "night_volume_pct",
    "night_alarm_sound_url",
    "tts_service",
    "tts_entity",
    "preamble_enabled",
    "preamble_text",
    "speak_english",
    "announce_language",
    "translate_missing_english",
    "translate_agent",
    "notify_services",
    "notify_critical",
    "notify_tts_targets",
    "cast_enabled",
    "cast_entities",
    "cast_entity",
    "cast_dashboard_path",
    "cast_view_path",
    "cast_at_night",
    "cast_turn_on",
    "cast_power_entities",
    "siren_test_enabled",
    "siren_test_lead",
    "holiday_entity",
    "show_in_sidebar",
    "map_show_national",
    "welcome_seen",
    "map_tile_url",
    "map_attribution",
}


def _first_entry(hass: HomeAssistant) -> ConfigEntry | None:
    """Return the single NL-Alert config entry, if set up."""
    entries = hass.config_entries.async_entries(DOMAIN)
    return entries[0] if entries else None


def _merged(entry: ConfigEntry) -> dict[str, Any]:
    """Merge entry data and options, options winning."""
    return {**entry.data, **entry.options}


def _coordinator(hass: HomeAssistant, entry: ConfigEntry):
    """Return the coordinator for ``entry``, or None if not loaded yet."""
    return hass.data.get(DOMAIN, {}).get(entry.entry_id)


def _serialize_alert(alert: dict[str, Any]) -> dict[str, Any]:
    """Flatten one alert for the panel, with polygons parsed to [lat, lon].

    The API hands out each area as a single space-separated string of
    ``lat,lon`` pairs (see geo.parse_polygon); doing the parse here keeps the
    frontend free of string wrangling and lets it draw straight away.
    """
    polygons = [
        [[lat, lon] for lat, lon in parse_polygon(poly)]
        for poly in (alert.get("area") or [])
    ]
    return {
        "id": alert.get("id"),
        "type": alert.get("type"),
        "message": alert.get("message"),
        "start_at": alert.get("start_at"),
        "stop_at": alert.get("stop_at"),
        "resource_uri": alert.get("resource_uri"),
        "is_local": bool(alert.get("is_local")),
        "scope": alert.get("scope"),
        "distance_km": alert.get("distance_km"),
        "polygons": [p for p in polygons if len(p) >= 3],
    }


# ── Config ────────────────────────────────────────────────────────────────────


@websocket_api.websocket_command({vol.Required("type"): "nl_alert/get_config"})
@websocket_api.async_response
async def ws_get_config(hass: HomeAssistant, connection, msg) -> None:
    """Return the merged settings plus everything the panel shows around them."""
    entry = _first_entry(hass)
    if entry is None:
        connection.send_error(msg["id"], "not_found", "NL-Alert is niet ingesteld")
        return

    options = _merged(entry)
    connection.send_result(
        msg["id"],
        {
            "entry_id": entry.entry_id,
            "options": options,
            "validation": await async_validate(hass, options),
            "home": {
                "latitude": hass.config.latitude,
                "longitude": hass.config.longitude,
                "location_name": hass.config.location_name,
            },
            "monitored": {
                "latitude": options.get(CONF_LATITUDE),
                "longitude": options.get(CONF_LONGITUDE),
                "use_home_location": options.get(CONF_USE_HOME_LOCATION, True),
            },
            "bounds": NL_BOUNDS,
            # Sent rather than duplicated in the frontend, so the dropdown
            # can never drift from what the coordinator actually accepts.
            "polling_choices": POLLING_CHOICES,
            "map_defaults": {
                "tile_url": DEFAULT_MAP_TILE_URL,
                "attribution": DEFAULT_MAP_ATTRIBUTION,
            },
            # Whether HA can tell us about holidays at all — the panel needs
            # this to explain why the siren test would be skipped.
            "holiday_entity": async_holiday_entity(hass, options),
            "next_siren_test": next_siren_test(dt_util.now()).isoformat(),
        },
    )


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "nl_alert/save_config",
        vol.Required("options"): dict,
    }
)
@websocket_api.async_response
async def ws_save_config(hass: HomeAssistant, connection, msg) -> None:
    """Persist settings from the panel.

    Written to ``entry.options`` only. ``entry.data`` keeps the original
    setup values, which is what HA expects and what the coordinator already
    merges on top of. The update listener in __init__.py reloads the entry,
    so a changed polling interval or location takes effect immediately.
    """
    entry = _first_entry(hass)
    if entry is None:
        connection.send_error(msg["id"], "not_found", "NL-Alert is niet ingesteld")
        return

    incoming = {k: v for k, v in msg["options"].items() if k in _WRITABLE_KEYS}

    # Keep latitude/longitude in sync with the "use home location" switch so
    # the coordinator (which reads them straight from the entry) can stay
    # simple.
    if incoming.get(CONF_USE_HOME_LOCATION):
        incoming[CONF_LATITUDE] = hass.config.latitude
        incoming[CONF_LONGITUDE] = hass.config.longitude

    new_options = {**entry.options, **incoming}
    hass.config_entries.async_update_entry(entry, options=new_options)

    merged = {**entry.data, **new_options}
    _LOGGER.debug("NL-Alert settings updated from panel: %s", incoming)
    connection.send_result(
        msg["id"],
        {
            "success": True,
            "options": merged,
            "validation": await async_validate(hass, merged),
        },
    )


# ── Pick-lists ────────────────────────────────────────────────────────────────


@websocket_api.websocket_command(
    {vol.Required("type"): "nl_alert/list_media_players"}
)
@callback
def ws_list_media_players(hass: HomeAssistant, connection, msg) -> None:
    """Return all media_player entities for the speaker and TV pickers.

    ``platform`` rides along so the panel can offer only Chromecast-capable
    devices for casting — cast.show_lovelace_view works with the cast
    integration and nothing else.
    """
    registry = er.async_get(hass)
    items = []
    for state in hass.states.async_all("media_player"):
        entry = registry.async_get(state.entity_id)
        items.append(
            {
                "entity_id": state.entity_id,
                "name": state.attributes.get("friendly_name") or state.entity_id,
                "state": state.state,
                "platform": entry.platform if entry else None,
            }
        )
    items.sort(key=lambda x: x["name"].lower())
    connection.send_result(msg["id"], items)


@websocket_api.websocket_command(
    {vol.Required("type"): "nl_alert/list_power_entities"}
)
@callback
def ws_list_power_entities(hass: HomeAssistant, connection, msg) -> None:
    """Entities that can wake a TV before casting.

    remote.* (an Android TV remote wakes the set the cast entity can't) plus
    any media_player that advertises TURN_ON. Kept short on purpose — this is
    a picker, not an entity browser.
    """
    items = []
    for state in hass.states.async_all("remote"):
        items.append(
            {
                "entity_id": state.entity_id,
                "name": state.attributes.get("friendly_name") or state.entity_id,
            }
        )
    for state in hass.states.async_all("media_player"):
        try:
            features = int(state.attributes.get("supported_features") or 0)
        except (TypeError, ValueError):
            continue
        if features & MEDIA_PLAYER_FEATURE_TURN_ON:
            items.append(
                {
                    "entity_id": state.entity_id,
                    "name": state.attributes.get("friendly_name") or state.entity_id,
                }
            )
    items.sort(key=lambda x: x["name"].lower())
    connection.send_result(msg["id"], items)


@websocket_api.websocket_command(
    {vol.Required("type"): "nl_alert/list_notify_services"}
)
@callback
def ws_list_notify_services(hass: HomeAssistant, connection, msg) -> None:
    """Return every notify.* service except the generic entity-based one."""
    services = hass.services.async_services().get("notify", {})
    items = [
        {"service": f"notify.{name}", "name": name.replace("_", " ")}
        for name in sorted(services)
        if name != "send_message"
    ]
    connection.send_result(msg["id"], items)


@websocket_api.websocket_command(
    {vol.Required("type"): "nl_alert/list_tts_services"}
)
@callback
def ws_list_tts_services(hass: HomeAssistant, connection, msg) -> None:
    """Return the available TTS engines and which delivery services exist.

    The panel asks for an engine (a ``tts.*`` entity) plus a delivery method.
    ``tts.speak`` is always available in modern HA; ``chime_tts.say`` only if
    the chime_tts custom integration is installed. Both need the engine —
    that missing engine is why chime_tts silently said nothing before 0.3.0.
    """
    engines = [
        {
            "entity_id": state.entity_id,
            "name": state.attributes.get("friendly_name") or state.entity_id,
        }
        for state in hass.states.async_all("tts")
    ]
    engines.sort(key=lambda x: x["name"].lower())

    services = []
    if hass.services.has_service("tts", "speak"):
        services.append({"service": "tts.speak", "name": "Home Assistant TTS"})
    if hass.services.has_service("chime_tts", "say"):
        services.append({"service": "chime_tts.say", "name": "Chime TTS"})

    # AI Task entities double as translators for alerts that arrive without an
    # English half. Vendor-neutral: whatever LLM integration is set up shows up
    # here, so there is nothing OpenAI-specific in the code.
    translators = [
        {
            "entity_id": state.entity_id,
            "name": state.attributes.get("friendly_name") or state.entity_id,
        }
        for state in hass.states.async_all("ai_task")
    ]
    translators.sort(key=lambda x: x["name"].lower())

    connection.send_result(
        msg["id"],
        {"engines": engines, "services": services, "translators": translators},
    )


@websocket_api.websocket_command({vol.Required("type"): "nl_alert/list_audio_files"})
@websocket_api.async_response
async def ws_list_audio_files(hass: HomeAssistant, connection, msg) -> None:
    """Return NL-Alert's own sounds plus the user's files in /config/www."""
    connection.send_result(
        msg["id"],
        {
            "builtin": await async_scan_builtin_sounds(hass),
            "local": await async_scan_audio_files(hass),
        },
    )


# ── Actions ───────────────────────────────────────────────────────────────────


@websocket_api.websocket_command(
    {
        vol.Required("type"): "nl_alert/test",
        vol.Required("kind"): vol.In(
            [TEST_ALARM, TEST_ANNOUNCEMENT, TEST_NOTIFY, TEST_CAST, TEST_FULL]
        ),
        vol.Optional("message"): cv.string,
        # Test against unsaved edits so "try it, then save" works.
        vol.Optional("options"): dict,
    }
)
@websocket_api.async_response
async def ws_test(hass: HomeAssistant, connection, msg) -> None:
    """Run one test and return its per-step results."""
    entry = _first_entry(hass)
    if entry is None:
        connection.send_error(msg["id"], "not_found", "NL-Alert is niet ingesteld")
        return

    options = _merged(entry)
    overrides = {k: v for k, v in (msg.get("options") or {}).items() if k in _WRITABLE_KEYS}
    options.update(overrides)

    results = await async_run_test(hass, options, msg["kind"], msg.get("message"))

    # Logged like a real alert: without a trace, a test that quietly did
    # nothing is indistinguishable from never having pressed the button.
    coordinator = _coordinator(hass, entry)
    if coordinator is not None:
        await coordinator.history.async_load()
        await coordinator.history.async_record_test(msg["kind"], results)

    connection.send_result(msg["id"], {"results": results})


@websocket_api.websocket_command({vol.Required("type"): "nl_alert/refresh"})
@websocket_api.async_response
async def ws_refresh(hass: HomeAssistant, connection, msg) -> None:
    """Force an immediate poll of the NL-Alert API."""
    entry = _first_entry(hass)
    coordinator = _coordinator(hass, entry) if entry else None
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "NL-Alert is niet geladen")
        return
    await coordinator.async_request_refresh()
    connection.send_result(msg["id"], {"success": True})


@websocket_api.websocket_command({vol.Required("type"): "nl_alert/get_alerts"})
@callback
def ws_get_alerts(hass: HomeAssistant, connection, msg) -> None:
    """Return the current alert feed for the national map card."""
    entry = _first_entry(hass)
    coordinator = _coordinator(hass, entry) if entry else None
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "NL-Alert is niet geladen")
        return

    options = _merged(entry)
    data = coordinator.data or {}
    active = [_serialize_alert(a) for a in data.get("active") or []]
    fetched = data.get("fetched_at")
    connection.send_result(
        msg["id"],
        {
            "active": active,
            "local": [a for a in active if a["is_local"]],
            "total": len(data.get("all") or []),
            "fetched_at": fetched.isoformat() if fetched else None,
            "monitored": {
                "latitude": coordinator.latitude,
                "longitude": coordinator.longitude,
            },
            "bounds": NL_BOUNDS,
            # The Lovelace card has no settings of its own; it draws the same
            # basemap the panel does, so the choice travels with the data.
            "tile_url": options.get(CONF_MAP_TILE_URL) or DEFAULT_MAP_TILE_URL,
            "attribution": options.get(CONF_MAP_ATTRIBUTION)
            or DEFAULT_MAP_ATTRIBUTION,
        },
    )


@websocket_api.websocket_command({vol.Required("type"): "nl_alert/get_history"})
@websocket_api.async_response
async def ws_get_history(hass: HomeAssistant, connection, msg) -> None:
    """Return recently seen alerts and tests, newest first."""
    entry = _first_entry(hass)
    coordinator = _coordinator(hass, entry) if entry else None
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "NL-Alert is niet geladen")
        return
    await coordinator.history.async_load()

    # Backfill: entries recorded before 0.12.0 have no geometry, so clicking
    # them could not put anything on the map. The feed keeps recent alerts
    # around for days, so for anything still in it we can work the bounding
    # box out now instead of making the user wait for a fresh alert.
    feed = {
        alert.get("id"): alert
        for alert in (coordinator.data or {}).get("all") or []
        if alert.get("id")
    }
    entries = []
    for entry in coordinator.history.entries:
        if not entry.get("bounds") and entry.get("id") in feed:
            box = polygons_bbox(feed[entry["id"]].get("area") or [])
            if box is not None:
                min_lat, max_lat, min_lon, max_lon = box
                entry = {
                    **entry,
                    "bounds": {
                        "min_lat": round(min_lat, 5),
                        "max_lat": round(max_lat, 5),
                        "min_lon": round(min_lon, 5),
                        "max_lon": round(max_lon, 5),
                    },
                    "centroid": [
                        round((min_lat + max_lat) / 2, 5),
                        round((min_lon + max_lon) / 2, 5),
                    ],
                }
        entries.append(entry)

    connection.send_result(msg["id"], {"entries": entries})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "nl_alert/delete_history_entry",
        vol.Required("key"): cv.string,
    }
)
@websocket_api.async_response
async def ws_delete_history_entry(hass: HomeAssistant, connection, msg) -> None:
    """Remove one history entry."""
    entry = _first_entry(hass)
    coordinator = _coordinator(hass, entry) if entry else None
    if coordinator is None:
        connection.send_error(msg["id"], "not_found", "NL-Alert is niet geladen")
        return
    await coordinator.history.async_load()
    removed = await coordinator.history.async_delete(msg["key"])
    connection.send_result(msg["id"], {"success": removed})


@callback
def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register every NL-Alert websocket command."""
    websocket_api.async_register_command(hass, ws_get_config)
    websocket_api.async_register_command(hass, ws_save_config)
    websocket_api.async_register_command(hass, ws_list_media_players)
    websocket_api.async_register_command(hass, ws_list_notify_services)
    websocket_api.async_register_command(hass, ws_list_power_entities)
    websocket_api.async_register_command(hass, ws_list_tts_services)
    websocket_api.async_register_command(hass, ws_list_audio_files)
    websocket_api.async_register_command(hass, ws_test)
    websocket_api.async_register_command(hass, ws_refresh)
    websocket_api.async_register_command(hass, ws_get_alerts)
    websocket_api.async_register_command(hass, ws_get_history)
    websocket_api.async_register_command(hass, ws_delete_history_entry)
