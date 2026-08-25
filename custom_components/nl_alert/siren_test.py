"""Monthly siren test — first Monday of the month, 12:00:00 sharp.

The Dutch air-raid sirens are tested on the first Monday of every month at
noon, and skipped when that Monday is a public holiday. This reproduces it
locally instead of waiting for the feed: polling the API can be a minute
late, and "a minute late" is not a siren test.

Two moments per month:
  * T minus ``siren_test_lead`` seconds — a heads-up notification, so nobody
    is startled by what follows.
  * T (12:00:00) — the alarm sound itself.

The holiday check is not optional. Without a source of truth for holidays
the test is skipped rather than guessed at: sounding a siren on Koningsdag
is a worse failure than staying quiet, and the user is told why through a
repair issue and the panel.

New in 0.11.0 (2026-08-09).
"""
from __future__ import annotations

from datetime import datetime, timedelta
import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import async_track_point_in_time
from homeassistant.util import dt as dt_util

from .const import (
    CONF_HOLIDAY_ENTITY,
    CONF_SIREN_TEST_ENABLED,
    CONF_SIREN_TEST_LEAD,
    DEFAULT_SIREN_TEST_LEAD,
    DOMAIN,
    SIREN_TEST_HOUR,
    SIREN_TEST_MESSAGE,
    SIREN_TEST_MINUTE,
    SIREN_TEST_NOTIFY_TITLE,
    SIREN_TEST_WARNING,
)
from .notifier import _async_notify, _async_play_alarm_sound

_LOGGER = logging.getLogger(__name__)

HOLIDAY_PLATFORM = "holiday"


# ── Pure scheduling maths ─────────────────────────────────────────────────────


def first_monday(year: int, month: int) -> int:
    """Day-of-month of the first Monday in that month."""
    weekday = datetime(year, month, 1).weekday()  # Monday == 0
    return 1 + ((0 - weekday) % 7)


def next_siren_test(now: datetime) -> datetime:
    """The next first-Monday-of-the-month at 12:00:00, strictly after ``now``.

    Naive/aware follows ``now``: callers pass local time, so the result is
    local too. Returning the moment *after* now matters on the test day
    itself — at 12:00:01 the answer must be next month, not a second ago.
    """
    year, month = now.year, now.month
    for _ in range(2):
        candidate = now.replace(
            year=year,
            month=month,
            day=first_monday(year, month),
            hour=SIREN_TEST_HOUR,
            minute=SIREN_TEST_MINUTE,
            second=0,
            microsecond=0,
        )
        if candidate > now:
            return candidate
        month += 1
        if month > 12:
            month = 1
            year += 1
    raise RuntimeError("unreachable")  # pragma: no cover


# ── Holiday source ────────────────────────────────────────────────────────────


@callback
def async_find_holiday_entity(hass: HomeAssistant) -> str | None:
    """Entity id of HA's own Holiday calendar, if it is set up."""
    registry = er.async_get(hass)
    for entry in registry.entities.values():
        if entry.domain == "calendar" and entry.platform == HOLIDAY_PLATFORM:
            return entry.entity_id
    return None


@callback
def async_holiday_entity(hass: HomeAssistant, options: dict[str, Any]) -> str | None:
    """The configured holiday entity, or the auto-detected one."""
    configured = options.get(CONF_HOLIDAY_ENTITY)
    if configured:
        return configured
    return async_find_holiday_entity(hass)


@callback
def async_is_holiday(hass: HomeAssistant, options: dict[str, Any]) -> bool | None:
    """Is today a holiday? ``None`` when there is no source to ask.

    The Holiday integration models each holiday as an all-day event, so its
    calendar entity simply reads "on" for the whole day.
    """
    entity_id = async_holiday_entity(hass, options)
    if not entity_id:
        return None
    state = hass.states.get(entity_id)
    if state is None or state.state in ("unknown", "unavailable"):
        return None
    return state.state == "on"


# ── Scheduler ─────────────────────────────────────────────────────────────────


class SirenTestScheduler:
    """Plants the two timers and re-plants them after each run."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialize the scheduler."""
        self._hass = hass
        self._entry = entry
        self._cancels: list[CALLBACK_TYPE] = []

    @property
    def _options(self) -> dict[str, Any]:
        return {**self._entry.data, **self._entry.options}

    @callback
    def async_schedule(self) -> None:
        """(Re)plant the timers for the next occurrence."""
        self.async_cancel()
        options = self._options
        if not options.get(CONF_SIREN_TEST_ENABLED, False):
            return

        target = next_siren_test(dt_util.now())
        lead = int(options.get(CONF_SIREN_TEST_LEAD, DEFAULT_SIREN_TEST_LEAD) or 0)
        heads_up = target - timedelta(seconds=lead)

        if lead > 0 and heads_up > dt_util.now():
            self._cancels.append(
                async_track_point_in_time(self._hass, self._async_notify, heads_up)
            )
        self._cancels.append(
            async_track_point_in_time(self._hass, self._async_sound, target)
        )
        _LOGGER.debug(
            "NL-Alert siren test scheduled: %s (heads-up %ss earlier)", target, lead
        )

    @callback
    def async_cancel(self) -> None:
        """Drop any pending timers."""
        for cancel in self._cancels:
            cancel()
        self._cancels = []

    def _skip_reason(self) -> str | None:
        """Why this month's run should not happen, if it shouldn't."""
        holiday = async_is_holiday(self._hass, self._options)
        if holiday is None:
            return (
                "geen feestdagenbron gevonden — installeer de Holiday-"
                "integratie (land: Nederland)"
            )
        if holiday:
            return "vandaag is een feestdag"
        return None

    async def _async_notify(self, _now: datetime) -> None:
        """Heads-up notification, ``lead`` seconds before the sound."""
        reason = self._skip_reason()
        if reason:
            _LOGGER.info("NL-Alert siren test skipped (%s)", reason)
            return
        await _async_notify(
            self._hass, self._options, SIREN_TEST_NOTIFY_TITLE, SIREN_TEST_WARNING
        )

    async def _async_sound(self, _now: datetime) -> None:
        """The alarm itself, then re-plant for next month."""
        reason = self._skip_reason()
        coordinator = self._hass.data.get(DOMAIN, {}).get(self._entry.entry_id)

        if reason:
            _LOGGER.info("NL-Alert siren test skipped (%s)", reason)
            if coordinator is not None:
                await coordinator.history.async_load()
                await coordinator.history.async_record_siren_test(
                    fired=False, detail=f"Overgeslagen: {reason}."
                )
        else:
            results = await _async_play_alarm_sound(self._hass, self._options)
            if coordinator is not None:
                await coordinator.history.async_load()
                await coordinator.history.async_record_siren_test(
                    fired=True, detail=SIREN_TEST_MESSAGE, results=results
                )

        # Next month, regardless of whether this one ran.
        self.async_schedule()
