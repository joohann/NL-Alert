"""Button entities for testing the NL-Alert dispatch.

Changelog:
  0.3.0 (2026-08-09): Buttons now surface failures. notifier's test helpers
                      return step results; anything with status "error"
                      becomes a HomeAssistantError so HA shows a red toast.
                      Previously a broken speaker or missing sound file made
                      the button look like it did nothing at all — which is
                      exactly how "het test alarm werkt niet" presented.
                      Entity names/icons moved to translation keys backed by
                      icons.json + translations/*.json.
"""
from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, TEST_ALARM, TEST_ANNOUNCEMENT, TEST_FULL, TEST_NOTIFY
from .coordinator import NLAlertCoordinator
from .entity import NLAlertBaseEntity
from .notifier import async_run_test, error_summary, has_errors


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up button entities."""
    coordinator: NLAlertCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            NLAlertTestButton(coordinator, TEST_FULL, "test_alert"),
            NLAlertTestButton(coordinator, TEST_ALARM, "test_alarm_sound"),
            NLAlertTestButton(coordinator, TEST_ANNOUNCEMENT, "test_announcement"),
            NLAlertTestButton(coordinator, TEST_NOTIFY, "test_notify"),
        ]
    )


class NLAlertTestButton(NLAlertBaseEntity, ButtonEntity):
    """Run one of the four dispatch tests.

    One class for all four buttons — before 0.3.0 these were four nearly
    identical subclasses differing only in which notifier helper they called,
    which is now a single ``kind`` argument.
    """

    def __init__(
        self, coordinator: NLAlertCoordinator, kind: str, suffix: str
    ) -> None:
        """Initialize the entity."""
        super().__init__(coordinator)
        self._kind = kind
        self._attr_translation_key = suffix
        self._attr_unique_id = f"{coordinator.entry.entry_id}_{suffix}"

    async def async_press(self) -> None:
        """Run the test and raise if any step failed."""
        entry = self.coordinator.entry
        options = {**entry.data, **entry.options}
        results = await async_run_test(self.hass, options, self._kind)
        if has_errors(results):
            raise HomeAssistantError(f"NL-Alert test mislukt: {error_summary(results)}")
