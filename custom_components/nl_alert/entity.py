"""Base entity for NL-Alert."""
from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, MANUFACTURER
from .coordinator import NLAlertCoordinator


class NLAlertBaseEntity(CoordinatorEntity[NLAlertCoordinator]):
    """Shared base entity with device info."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: NLAlertCoordinator) -> None:
        """Initialize base entity."""
        super().__init__(coordinator)
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, coordinator.entry.entry_id)},
            name="NL-Alert",
            manufacturer=MANUFACTURER,
            model="Public Warning Feed",
            configuration_url="https://api.public-warning.app/",
        )
