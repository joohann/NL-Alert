"""The NL-Alert integration.

Layout:
  __init__.py     → entry setup, the nl_alert.test_alert service
  coordinator.py  → polls api.public-warning.app, fires nl_alert_new_alert
  notifier.py     → alarm sound + TTS + push, with per-step results
  panel.py        → /nl-alert sidebar panel (settings + national map)
  websocket.py    → the panel's API
  geo.py          → point-in-polygon for "is this alert about my address?"
  brand/          → the integration's icon, served locally (see below)

Brand images: since the brands integration moved behind
/api/brands/integration/{domain}/{image}, Home Assistant serves a CUSTOM
integration's own images before ever touching the CDN. The gate is
``Integration.has_branding``, which is simply "is there a top-level ``brand``
folder" (homeassistant/loader.py), and the files are read from
``<component>/brand/``. Allowed names are icon/logo, each with @2x and dark_
variants; missing ones fall back down a chain, so shipping icon.png +
icon@2x.png is enough to cover all eight. No PR to home-assistant/brands is
needed — the "icon not available" placeholder only appears when this folder
is missing.

Changelog:
  0.3.0 (2026-08-09): Custom panel added (panel.py + websocket.py +
                      frontend/nl-alert-panel.js), mirroring Nida — the
                      config flow was too cramped for the settings this
                      integration actually has, and had nowhere to show a
                      map. The flow is now location-only; everything else
                      is edited in the panel. The test_alert service and
                      the test buttons now raise on failure instead of
                      silently logging (see notifier.py's changelog for
                      the three bugs that hid behind that).
"""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import issue_registry as ir

from .const import (
    CONF_SHOW_IN_SIDEBAR,
    CONF_SIREN_TEST_ENABLED,
    DOMAIN,
    ISSUE_HOLIDAY_MISSING,
    PLATFORMS,
    SERVICE_TEST_ALERT,
    TEST_ALARM,
    TEST_ANNOUNCEMENT,
    TEST_CAST,
    TEST_FULL,
    TEST_NOTIFY,
)
from .coordinator import NLAlertCoordinator
from .notifier import async_run_test, error_summary, has_errors
from .panel import async_register_card, async_register_panel, async_remove_panel
from .siren_test import SirenTestScheduler, async_holiday_entity
from .websocket import async_register_websocket_commands

_LOGGER = logging.getLogger(__name__)

SERVICE_TEST_ALERT_SCHEMA = vol.Schema(
    {
        vol.Optional("message"): cv.string,
        vol.Optional("kind", default=TEST_FULL): vol.In(
            [TEST_ALARM, TEST_ANNOUNCEMENT, TEST_NOTIFY, TEST_CAST, TEST_FULL]
        ),
    }
)


def _merged_options(entry: ConfigEntry) -> dict[str, Any]:
    """Return merged config entry data + options."""
    return {**entry.data, **entry.options}


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up NL-Alert from a config entry."""
    coordinator = NLAlertCoordinator(hass, entry)
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    async_register_websocket_commands(hass)
    # NOT removed first: async_register_panel re-registers only when the
    # sidebar setting actually changed. Tearing the panel down on every
    # reload kicked anyone viewing /nl-alert back to the default dashboard.
    await async_register_panel(
        hass, _merged_options(entry).get(CONF_SHOW_IN_SIDEBAR, True)
    )
    await async_register_card(hass)

    # Monthly siren test. Re-planted on every reload, so a changed setting
    # takes effect without waiting a month.
    scheduler = SirenTestScheduler(hass, entry)
    scheduler.async_schedule()
    entry.async_on_unload(scheduler.async_cancel)
    _async_check_holiday_source(hass, _merged_options(entry))

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    # Register the service once (re-registration on subsequent entries is fine
    # because async_register replaces the existing handler).
    async def _async_test_alert(call: ServiceCall) -> None:
        """Trigger a synthetic NL-Alert for testing."""
        entries = hass.data.get(DOMAIN, {})
        if not entries:
            raise HomeAssistantError("NL-Alert is not configured")
        # Single-entry integration → use the first (and only) entry.
        first_coord = entries[next(iter(entries))]
        options = _merged_options(first_coord.entry)
        results = await async_run_test(
            hass, options, call.data.get("kind", TEST_FULL), call.data.get("message")
        )
        if has_errors(results):
            raise HomeAssistantError(
                f"NL-Alert test mislukt: {error_summary(results)}"
            )

    hass.services.async_register(
        DOMAIN,
        SERVICE_TEST_ALERT,
        _async_test_alert,
        schema=SERVICE_TEST_ALERT_SCHEMA,
    )

    return True


@callback
def _async_check_holiday_source(hass: HomeAssistant, options: dict[str, Any]) -> None:
    """Demand HA's Holiday integration when the siren test is switched on.

    An integration can't install another one, so this raises a repair issue —
    HA's own way of saying "you need to do something". Without a holiday
    source the test refuses to sound rather than risk a siren on Koningsdag.
    """
    if not options.get(CONF_SIREN_TEST_ENABLED, False):
        ir.async_delete_issue(hass, DOMAIN, ISSUE_HOLIDAY_MISSING)
        return

    if async_holiday_entity(hass, options):
        ir.async_delete_issue(hass, DOMAIN, ISSUE_HOLIDAY_MISSING)
        return

    ir.async_create_issue(
        hass,
        DOMAIN,
        ISSUE_HOLIDAY_MISSING,
        is_fixable=False,
        severity=ir.IssueSeverity.WARNING,
        translation_key=ISSUE_HOLIDAY_MISSING,
    )


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
        if not hass.data[DOMAIN]:
            hass.services.async_remove(DOMAIN, SERVICE_TEST_ALERT)
    # The panel deliberately survives an unload: HA unloads and re-sets-up
    # the entry on every options change, and dropping the panel in between
    # navigates the user away from it. It is removed in async_remove_entry,
    # which only runs when the integration is really deleted.
    return unload_ok


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Clean up the sidebar entry when NL-Alert is removed for good."""
    async_remove_panel(hass)


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload integration when options change."""
    await hass.config_entries.async_reload(entry.entry_id)
