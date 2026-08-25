"""Config flow for NL-Alert.

Deliberately small since 0.3.0: setup asks for the location and the polling
interval and nothing else. Speakers, alarm sound, voice, notifications and
the tests all live in the /nl-alert panel, which can show a map, preview a
sound and report per-step test results — none of which HA's flow framework
can do.

Changelog:
  0.3.0 (2026-08-09): Notifications step and test menu removed (moved to
                      the panel). Options flow reduced to the sidebar
                      toggle plus a link to the panel, mirroring Nida.
"""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, OptionsFlow
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers import selector

from .const import (
    CONF_ALARM_DURATION,
    CONF_ALARM_SOUND_URL,
    CONF_LATITUDE,
    CONF_LONGITUDE,
    CONF_SCAN_INTERVAL_MINUTES,
    CONF_SHOW_IN_SIDEBAR,
    CONF_USE_HOME_LOCATION,
    CONF_VOLUME_PCT,
    DEFAULT_ALARM_DURATION,
    DEFAULT_ALARM_SOUND,
    DEFAULT_POLLING_MINUTES,
    DEFAULT_VOLUME_PCT,
    DOMAIN,
    POLLING_CHOICES,
)


def _sel_polling_minutes() -> selector.Selector:
    """Dropdown 1–10 minutes."""
    return selector.SelectSelector(
        selector.SelectSelectorConfig(
            options=[
                selector.SelectOptionDict(value=v, label=f"{v} min")
                for v in POLLING_CHOICES
            ],
            mode=selector.SelectSelectorMode.DROPDOWN,
        )
    )


class NLAlertConfigFlow(ConfigFlow, domain=DOMAIN):
    """Single-step setup: location + polling interval."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Ask for the location to monitor."""
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        errors: dict[str, str] = {}

        if user_input is not None:
            use_home = user_input.get(CONF_USE_HOME_LOCATION, True)
            if use_home:
                lat: float | None = self.hass.config.latitude
                lon: float | None = self.hass.config.longitude
            else:
                lat = user_input.get(CONF_LATITUDE)
                lon = user_input.get(CONF_LONGITUDE)

            if lat is None or lon is None:
                errors["base"] = "missing_coordinates"
            else:
                return self.async_create_entry(
                    title="NL-Alert",
                    data={
                        CONF_USE_HOME_LOCATION: use_home,
                        CONF_LATITUDE: float(lat),
                        CONF_LONGITUDE: float(lon),
                        CONF_SCAN_INTERVAL_MINUTES: int(
                            user_input.get(
                                CONF_SCAN_INTERVAL_MINUTES, DEFAULT_POLLING_MINUTES
                            )
                        ),
                        # A working alarm out of the box; the panel can swap
                        # it for any other shipped sound or a own file.
                        CONF_ALARM_SOUND_URL: DEFAULT_ALARM_SOUND,
                        CONF_ALARM_DURATION: DEFAULT_ALARM_DURATION,
                        CONF_VOLUME_PCT: DEFAULT_VOLUME_PCT,
                    },
                )

        schema = vol.Schema(
            {
                vol.Required(CONF_USE_HOME_LOCATION, default=True): bool,
                vol.Optional(CONF_LATITUDE): vol.Coerce(float),
                vol.Optional(CONF_LONGITUDE): vol.Coerce(float),
                vol.Required(
                    CONF_SCAN_INTERVAL_MINUTES,
                    default=str(DEFAULT_POLLING_MINUTES),
                ): _sel_polling_minutes(),
            }
        )

        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(entry: ConfigEntry) -> OptionsFlow:
        """Return the options flow handler."""
        return NLAlertOptionsFlow()


class NLAlertOptionsFlow(OptionsFlow):
    """Sidebar toggle + a pointer at the panel where the real settings live."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Show the single toggle."""
        if user_input is not None:
            return self.async_create_entry(
                title="", data={**self.config_entry.options, **user_input}
            )

        current = self.config_entry.options.get(CONF_SHOW_IN_SIDEBAR, True)
        schema = vol.Schema(
            {vol.Required(CONF_SHOW_IN_SIDEBAR, default=current): bool}
        )
        return self.async_show_form(step_id="init", data_schema=schema)
