"""NL-Alert custom panel — registers the sidebar entry.

Same shape as Nida's panel.py: a web component served from ``frontend/``
via panel_custom, registered from ``async_setup_entry`` and removed again
on unload. The config flow is deliberately kept to the bare minimum
(location only) — everything else lives here, because HA's flow framework
can't render the pieces this integration needs: a national map, inline test
results per button, and validation that points at the exact setting that is
wrong.

The sidebar entry can be hidden with the ``show_in_sidebar`` option; the
panel then stays reachable at /nl-alert directly.

New in 0.3.0 (2026-08-09).
"""
from __future__ import annotations

import logging
import os

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant, callback
from homeassistant.loader import async_get_integration

from .const import DOMAIN, SOUNDS_URL_PATH, SPEECH_URL_PATH
from .notifier import speech_cache_dir

_LOGGER = logging.getLogger(__name__)

PANEL_URL_PATH = "nl-alert"
PANEL_TITLE = "NL-Alert"
PANEL_ICON = "mdi:alert"
STATIC_URL_PATH = "/nl_alert_panel_files"
FRONTEND_SCRIPT_URL = f"{STATIC_URL_PATH}/nl-alert-panel.js"
CARD_SCRIPT_URL = f"{STATIC_URL_PATH}/nl-alert-card.js"
_STATIC_FILES_KEY = f"{DOMAIN}_static_files_registered"
_CARD_KEY = f"{DOMAIN}_card_registered"
_PANEL_SIDEBAR_KEY = f"{DOMAIN}_panel_sidebar"


async def _asset_version(hass: HomeAssistant) -> str:
    """manifest.json's version, used as a cache-busting query param.

    Same reasoning as Nida 2.1.22: a kiosk tablet keeps an already-imported
    ES module for the life of the page, so without a versioned URL a fixed
    bug can keep "coming back" on that one screen for weeks.
    """
    integration = await async_get_integration(hass, DOMAIN)
    return integration.version or "0"


async def async_register_static_files(hass: HomeAssistant) -> None:
    """Serve frontend/ at /nl_alert_panel_files and sounds/ at /nl_alert_sounds.

    The sounds path is registered here rather than alongside the panel
    because a dispatch needs those URLs whether or not the sidebar entry
    exists — a speaker fetches the alarm sound over HTTP.

    Guarded with its own flag: async_register_static_paths raises if the
    same prefix is registered twice, and the frontend_panels check below
    tells us nothing about the static paths.
    """
    if hass.data.get(_STATIC_FILES_KEY):
        return
    here = os.path.dirname(__file__)
    speech_dir = speech_cache_dir(hass)
    await hass.async_add_executor_job(
        lambda: os.makedirs(speech_dir, exist_ok=True)
    )
    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(
                STATIC_URL_PATH, os.path.join(here, "frontend"), cache_headers=False
            ),
            # Cacheable: these files only change with a release.
            StaticPathConfig(
                SOUNDS_URL_PATH, os.path.join(here, "sounds"), cache_headers=True
            ),
            # Rendered speech clips, fetched once by the speaker then deleted.
            StaticPathConfig(
                SPEECH_URL_PATH, speech_dir, cache_headers=False
            ),
        ]
    )
    hass.data[_STATIC_FILES_KEY] = True


async def async_register_panel(
    hass: HomeAssistant, show_in_sidebar: bool = True
) -> None:
    """Register the NL-Alert panel + serve the frontend bundle.

    ``show_in_sidebar=False`` still registers the panel — passing
    ``sidebar_title=None`` means HA routes /nl-alert without putting an entry
    in the sidebar, so the dashboard stays reachable by URL (and from the
    integration's Configure dialog) for people who keep a tidy sidebar.
    """
    await async_register_static_files(hass)

    registered = PANEL_URL_PATH in hass.data.get("frontend_panels", {})
    if registered and hass.data.get(_PANEL_SIDEBAR_KEY) == show_in_sidebar:
        # Nothing changed. Re-registering would tear the route down and put
        # it back, and the frontend reacts to a disappearing panel by
        # navigating to the default dashboard — which is what happened on
        # every save, since saving options triggers an entry reload.
        _LOGGER.debug("NL-Alert panel already registered, skipping")
        return

    if registered:
        frontend.async_remove_panel(hass, PANEL_URL_PATH)

    version = await _asset_version(hass)
    await panel_custom.async_register_panel(
        hass,
        webcomponent_name="nl-alert-panel",
        frontend_url_path=PANEL_URL_PATH,
        module_url=f"{FRONTEND_SCRIPT_URL}?v={version}",
        sidebar_title=PANEL_TITLE if show_in_sidebar else None,
        sidebar_icon=PANEL_ICON if show_in_sidebar else None,
        embed_iframe=False,  # False for custom elements (web components)
        require_admin=False,
    )
    hass.data[_PANEL_SIDEBAR_KEY] = show_in_sidebar
    _LOGGER.debug(
        "NL-Alert panel registered at /%s (v%s, sidebar=%s)",
        PANEL_URL_PATH,
        version,
        show_in_sidebar,
    )


async def async_register_card(hass: HomeAssistant) -> None:
    """Register nl-alert-card.js as a global Lovelace resource.

    Called unconditionally, unlike the panel, which is gated on
    show_in_sidebar: the card has to exist on any dashboard the user builds —
    including the one that gets cast to a TV, where the sidebar panel is not
    available at all (HA Cast renders Lovelace views only).
    """
    if hass.data.get(_CARD_KEY):
        return
    await async_register_static_files(hass)
    version = await _asset_version(hass)
    frontend.add_extra_js_url(hass, f"{CARD_SCRIPT_URL}?v={version}")
    hass.data[_CARD_KEY] = True
    _LOGGER.debug("NL-Alert card registered (%s, v%s)", CARD_SCRIPT_URL, version)


@callback
def async_remove_panel(hass: HomeAssistant) -> None:
    """Remove the NL-Alert panel from the sidebar. No-op if absent."""
    if PANEL_URL_PATH in hass.data.get("frontend_panels", {}):
        frontend.async_remove_panel(hass, PANEL_URL_PATH)
        hass.data.pop(_PANEL_SIDEBAR_KEY, None)
        _LOGGER.debug("NL-Alert panel removed from sidebar")
