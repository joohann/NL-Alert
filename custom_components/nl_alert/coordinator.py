"""DataUpdateCoordinator for NL-Alert."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import logging
from typing import Any

import aiohttp
import async_timeout

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import (
    API_TIMEOUT,
    API_URL,
    CONF_LATITUDE,
    CONF_LONGITUDE,
    CONF_ALERT_RADIUS_KM,
    CONF_SCAN_INTERVAL_MINUTES,
    DEFAULT_ALERT_RADIUS_KM,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
    EVENT_NEW_ALERT,
    NL_BOUNDS,
    SCOPE_ELSEWHERE,
    SCOPE_LOCAL,
    SCOPE_NATIONAL,
)
from .geo import distance_to_area_km, is_national, point_in_any_polygon
from .history import NLAlertHistory
from .notifier import async_dispatch_alert

_LOGGER = logging.getLogger(__name__)


def _parse_iso(value: str | None) -> datetime | None:
    """Parse an ISO-8601 datetime string with a trailing Z."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def _merged_options(entry: ConfigEntry) -> dict[str, Any]:
    """Merge ``entry.data`` and ``entry.options`` with options taking priority."""
    return {**entry.data, **entry.options}


class NLAlertCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Coordinator that polls the NL-Alert API and dispatches notifications."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialize the coordinator."""
        merged = _merged_options(entry)
        scan_minutes = merged.get(CONF_SCAN_INTERVAL_MINUTES)
        interval = (
            timedelta(minutes=int(scan_minutes))
            if scan_minutes
            else DEFAULT_SCAN_INTERVAL
        )

        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=interval,
        )

        self.entry = entry
        self._latitude: float = float(entry.data[CONF_LATITUDE])
        self._longitude: float = float(entry.data[CONF_LONGITUDE])
        self._known_ids: set[str] = set()
        self._first_refresh_done: bool = False
        self._session: aiohttp.ClientSession = async_get_clientsession(hass)
        self.history = NLAlertHistory(hass)

    @property
    def latitude(self) -> float:
        """Monitored latitude."""
        return self._latitude

    @property
    def longitude(self) -> float:
        """Monitored longitude."""
        return self._longitude

    async def _async_update_data(self) -> dict[str, Any]:
        """Fetch alerts and compute filtered views."""
        try:
            async with async_timeout.timeout(API_TIMEOUT):
                resp = await self._session.get(API_URL)
                resp.raise_for_status()
                payload = await resp.json()
        except asyncio.TimeoutError as err:
            raise UpdateFailed(f"Timeout fetching NL-Alert API: {err}") from err
        except aiohttp.ClientError as err:
            raise UpdateFailed(f"Error fetching NL-Alert API: {err}") from err

        raw_alerts: list[dict[str, Any]] = payload.get("data", []) or []
        now = datetime.now(timezone.utc)
        radius_km = float(
            _merged_options(self.entry).get(
                CONF_ALERT_RADIUS_KM, DEFAULT_ALERT_RADIUS_KM
            )
            or 0
        )

        active: list[dict[str, Any]] = []
        local: list[dict[str, Any]] = []

        for raw in raw_alerts:
            start_at = _parse_iso(raw.get("start_at"))
            stop_at = _parse_iso(raw.get("stop_at"))

            is_active = (
                (start_at is None or start_at <= now)
                and (stop_at is None or stop_at >= now)
            )

            area = raw.get("area") or []
            if not isinstance(area, list):
                area = []

            enriched = {
                **raw,
                "start_at_dt": start_at,
                "stop_at_dt": stop_at,
                "is_active": is_active,
                "is_local": False,
            }

            # Distance to the nearest edge, kept on every alert so the panel
            # can show "3,2 km" whether or not the radius is in use.
            distance = distance_to_area_km(self._latitude, self._longitude, area)
            enriched["distance_km"] = (
                round(distance, 2) if distance is not None else None
            )

            if area:
                inside = point_in_any_polygon(
                    self._latitude, self._longitude, area
                )
                near = (
                    radius_km > 0
                    and distance is not None
                    and distance <= radius_km
                )
                enriched["is_local"] = inside or near

            # Scope decides whether this alert is worth waking the house for.
            # Local wins over national so the panel can label it precisely.
            if enriched["is_local"]:
                enriched["scope"] = SCOPE_LOCAL
            elif is_national(area, NL_BOUNDS):
                enriched["scope"] = SCOPE_NATIONAL
            else:
                enriched["scope"] = SCOPE_ELSEWHERE

            if is_active:
                active.append(enriched)
                if enriched["is_local"]:
                    local.append(enriched)

        # What we actually alarm for: an alert covering this address, a
        # nationwide one (which includes the monthly test broadcast), or
        # anything the feed marks as a test. An alert two provinces away is
        # shown on the map and logged, but stays quiet.
        dispatchable = [
            a
            for a in active
            if a["scope"] in (SCOPE_LOCAL, SCOPE_NATIONAL) or a.get("type") == "test"
        ]

        # Everything active is logged, so the panel can show what has been
        # going on lately — not just what made noise here.
        await self.history.async_load()
        for alert in active:
            await self.history.async_record_alert(
                alert,
                scope=alert["scope"],
                dispatched=alert in dispatchable and self._first_refresh_done,
            )

        # On the very first poll after startup we record IDs but don't fire
        # events/dispatchers — otherwise every restart would re-trigger every
        # currently-active alert.
        seen_now = {a["id"] for a in dispatchable if a.get("id")}

        if not self._first_refresh_done:
            self._known_ids = seen_now
            self._first_refresh_done = True
        else:
            new_ids = seen_now - self._known_ids
            if new_ids:
                merged_options = _merged_options(self.entry)
                for alert in dispatchable:
                    if alert.get("id") not in new_ids:
                        continue
                    self.hass.bus.async_fire(
                        EVENT_NEW_ALERT,
                        {
                            "id": alert.get("id"),
                            "message": alert.get("message"),
                            "type": alert.get("type"),
                            "scope": alert.get("scope"),
                            "start_at": alert.get("start_at"),
                            "stop_at": alert.get("stop_at"),
                        },
                    )
                    # Fire-and-forget dispatch so a slow/failing media player
                    # never blocks the update cycle.
                    self.hass.async_create_task(
                        async_dispatch_alert(self.hass, merged_options, alert),
                        name=f"nl_alert dispatch {alert.get('id')}",
                    )
            self._known_ids = seen_now

        active.sort(key=lambda a: a.get("start_at") or "", reverse=True)
        local.sort(key=lambda a: a.get("start_at") or "", reverse=True)

        return {
            "all": raw_alerts,
            "active": active,
            "local": local,
            "fetched_at": now,
        }
