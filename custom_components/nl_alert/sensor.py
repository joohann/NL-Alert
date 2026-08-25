"""Sensors for NL-Alert.

Changelog:
  0.3.0 (2026-08-09): Names and icons moved to translation keys
                      (translations/*.json + icons.json) instead of
                      hardcoded Dutch ``_attr_name`` / ``_attr_icon``.
"""
from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import NLAlertCoordinator
from .entity import NLAlertBaseEntity

# Native max-length for sensor state values in HA.
_STATE_MAX_LEN = 255


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up sensor entities."""
    coordinator: NLAlertCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            NLAlertActiveCountSensor(coordinator),
            NLAlertLocalCountSensor(coordinator),
            NLAlertLatestLocalSensor(coordinator),
            NLAlertLatestAlertSensor(coordinator),
        ]
    )


class _CountSensorBase(NLAlertBaseEntity, SensorEntity):
    """Shared base for count sensors."""

    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "alerts"
    _key: str = ""

    @property
    def native_value(self) -> int:
        """Return the count of alerts for this sensor's key."""
        data = self.coordinator.data or {}
        return len(data.get(self._key) or [])


class NLAlertActiveCountSensor(_CountSensorBase):
    """Number of active NL-Alerts across the Netherlands."""

    _attr_translation_key = "active_count"
    _key = "active"

    def __init__(self, coordinator: NLAlertCoordinator) -> None:
        """Initialize the entity."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_active_count"


class NLAlertLocalCountSensor(_CountSensorBase):
    """Number of active alerts whose area contains the monitored location."""

    _attr_translation_key = "local_count"
    _key = "local"

    def __init__(self, coordinator: NLAlertCoordinator) -> None:
        """Initialize the entity."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_local_count"


class _LatestAlertSensorBase(NLAlertBaseEntity, SensorEntity):
    """Shared base for latest-alert sensors."""

    _key: str = ""

    def _latest(self) -> dict[str, Any] | None:
        """Return the most recent alert from the chosen key, if any."""
        data = self.coordinator.data or {}
        alerts = data.get(self._key) or []
        return alerts[0] if alerts else None

    @property
    def native_value(self) -> str | None:
        """Return a truncated alert message as the state."""
        alert = self._latest()
        if not alert:
            return None
        message = alert.get("message") or ""
        if len(message) > _STATE_MAX_LEN:
            return message[: _STATE_MAX_LEN - 1] + "…"
        return message

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Expose the full alert payload via attributes."""
        alert = self._latest()
        if not alert:
            return {}
        return {
            "id": alert.get("id"),
            "type": alert.get("type"),
            "full_message": alert.get("message"),
            "start_at": alert.get("start_at"),
            "stop_at": alert.get("stop_at"),
            "resource_uri": alert.get("resource_uri"),
            "is_local": alert.get("is_local"),
            "area_polygons": len(alert.get("area") or []),
        }


class NLAlertLatestAlertSensor(_LatestAlertSensorBase):
    """Most recent currently-active alert from anywhere in NL."""

    _attr_translation_key = "latest_active"
    _key = "active"

    def __init__(self, coordinator: NLAlertCoordinator) -> None:
        """Initialize the entity."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_latest_active"


class NLAlertLatestLocalSensor(_LatestAlertSensorBase):
    """Most recent active alert whose area contains the monitored location."""

    _attr_translation_key = "latest_local"
    _key = "local"

    def __init__(self, coordinator: NLAlertCoordinator) -> None:
        """Initialize the entity."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_latest_local"
