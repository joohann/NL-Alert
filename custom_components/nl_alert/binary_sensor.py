"""Binary sensor: alert active at monitored location."""
from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import NLAlertCoordinator
from .entity import NLAlertBaseEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the binary sensor platform."""
    coordinator: NLAlertCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([NLAlertLocalActiveBinarySensor(coordinator)])


class NLAlertLocalActiveBinarySensor(NLAlertBaseEntity, BinarySensorEntity):
    """`on` when at least one active NL-Alert covers the monitored location."""

    _attr_translation_key = "local_active"
    _attr_device_class = BinarySensorDeviceClass.SAFETY

    def __init__(self, coordinator: NLAlertCoordinator) -> None:
        """Initialize the entity."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_local_active"

    @property
    def is_on(self) -> bool:
        """Return True when there is at least one local active alert."""
        data = self.coordinator.data or {}
        return bool(data.get("local"))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Expose details of local alerts."""
        data = self.coordinator.data or {}
        local = data.get("local") or []
        return {
            "count": len(local),
            "latitude": self.coordinator.latitude,
            "longitude": self.coordinator.longitude,
            "alerts": [
                {
                    "id": a.get("id"),
                    "type": a.get("type"),
                    "message": a.get("message"),
                    "start_at": a.get("start_at"),
                    "stop_at": a.get("stop_at"),
                }
                for a in local
            ],
        }
