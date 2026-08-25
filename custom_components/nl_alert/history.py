"""Persistent log of NL-Alerts this installation has seen.

Answers "what has been going on lately?" — and, just as importantly, "did my
test actually fire?". Both live in the same list so the panel can show one
timeline: real alerts from the feed, and every test you triggered.

Stored via HA's Store helper (``.storage/nl_alert_history``) so it survives a
restart, capped at MAX_ENTRIES newest-first. Entries are plain dicts, ready
to hand to the websocket API unchanged.

New in 0.10.0 (2026-08-09).
"""
from __future__ import annotations

from datetime import timedelta
import logging
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .geo import polygons_bbox

_LOGGER = logging.getLogger(__name__)

STORAGE_VERSION = 1
STORAGE_KEY = f"{DOMAIN}_history"
MAX_ENTRIES = 100
# Entries older than this are dropped on load and on every write. A warning
# log is a record, not an archive: a year covers "was there an alert here
# last winter?" without the store growing forever.
MAX_AGE_DAYS = 365

# Where an entry came from.
SOURCE_FEED = "feed"
SOURCE_TEST = "test"
SOURCE_SIREN = "siren"


class NLAlertHistory:
    """Newest-first list of alerts and tests, persisted across restarts."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize the store."""
        self._hass = hass
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._entries: list[dict[str, Any]] = []
        self._loaded = False

    async def async_load(self) -> None:
        """Read the stored history once."""
        if self._loaded:
            return
        data = await self._store.async_load()
        if isinstance(data, dict):
            entries = data.get("entries")
            if isinstance(entries, list):
                self._entries = entries[:MAX_ENTRIES]
        self._loaded = True
        if self._prune():
            await self._async_save()

    def _prune(self) -> bool:
        """Drop anything past MAX_AGE_DAYS. True when something was removed."""
        cutoff = dt_util.utcnow() - timedelta(days=MAX_AGE_DAYS)
        kept = []
        for entry in self._entries:
            recorded = dt_util.parse_datetime(entry.get("recorded_at") or "")
            # An unparseable timestamp is kept rather than silently binned;
            # losing history to a bad string is worse than a stale row.
            if recorded is None or recorded >= cutoff:
                kept.append(entry)
        changed = len(kept) != len(self._entries)
        self._entries = kept
        return changed

    @property
    def entries(self) -> list[dict[str, Any]]:
        """Everything recorded, newest first."""
        return self._entries

    def has(self, alert_id: str | None) -> bool:
        """Is this feed alert already recorded?

        Keyed on the alert id so re-seeing the same alert on every poll
        doesn't fill the log with duplicates. Tests have no id and are
        always appended.
        """
        if not alert_id:
            return False
        return any(
            entry.get("id") == alert_id and entry.get("source") == SOURCE_FEED
            for entry in self._entries
        )

    async def async_record_alert(
        self,
        alert: dict[str, Any],
        *,
        scope: str,
        dispatched: bool,
    ) -> None:
        """Record one alert from the feed, if it isn't in there yet.

        The geometry is boiled down to a bounding box and its centre rather
        than kept whole: that is all the panel needs to fly to the spot and
        put a crosshair on it, and it keeps a 100-entry log to a few kB
        instead of megabytes of polygon points.
        """
        if self.has(alert.get("id")):
            return

        entry: dict[str, Any] = {
            "source": SOURCE_FEED,
            "id": alert.get("id"),
            "type": alert.get("type"),
            "message": alert.get("message"),
            "start_at": alert.get("start_at"),
            "stop_at": alert.get("stop_at"),
            "scope": scope,
            "is_local": bool(alert.get("is_local")),
            "distance_km": alert.get("distance_km"),
            "dispatched": dispatched,
        }

        box = polygons_bbox(alert.get("area") or [])
        if box is not None:
            min_lat, max_lat, min_lon, max_lon = box
            entry["bounds"] = {
                "min_lat": round(min_lat, 5),
                "max_lat": round(max_lat, 5),
                "min_lon": round(min_lon, 5),
                "max_lon": round(max_lon, 5),
            }
            entry["centroid"] = [
                round((min_lat + max_lat) / 2, 5),
                round((min_lon + max_lon) / 2, 5),
            ]

        await self._async_add(entry)

    async def async_record_test(
        self, kind: str, results: list[dict[str, str]]
    ) -> None:
        """Record that a test ran, and how it went.

        Johann's reason for wanting this: without it there is no trace that a
        test happened at all, so a test that silently did nothing looks the
        same as never having pressed the button.
        """
        failed = [r for r in results if r.get("status") == "error"]
        await self._async_add(
            {
                "source": SOURCE_TEST,
                "id": None,
                "type": "test",
                "kind": kind,
                "message": f"Test uitgevoerd: {kind}",
                "scope": "test",
                "is_local": False,
                "dispatched": not failed,
                "results": results,
            }
        )

    async def async_record_siren_test(
        self,
        *,
        fired: bool,
        detail: str,
        results: list[dict[str, str]] | None = None,
    ) -> None:
        """Record the monthly siren test — including the months it skipped.

        A skipped month is the more interesting entry of the two: it is the
        only way to tell "the holiday check worked" apart from "the whole
        thing is broken".
        """
        await self._async_add(
            {
                "source": SOURCE_SIREN,
                "id": None,
                "type": "siren_test",
                "message": detail,
                "scope": "national",
                "is_local": False,
                "dispatched": fired,
                "results": results or [],
            }
        )

    async def _async_add(self, entry: dict[str, Any]) -> None:
        """Prepend an entry, trim, and persist."""
        entry["recorded_at"] = dt_util.utcnow().isoformat()
        self._entries.insert(0, entry)
        del self._entries[MAX_ENTRIES:]
        self._prune()
        await self._async_save()

    async def async_delete(self, key: str) -> bool:
        """Remove one entry by its id (feed alerts) or recorded_at (the rest)."""
        before = len(self._entries)
        self._entries = [
            entry
            for entry in self._entries
            if str(entry.get("id") or entry.get("recorded_at")) != key
        ]
        if len(self._entries) == before:
            return False
        await self._async_save()
        return True

    async def _async_save(self) -> None:
        """Write the list back to disk."""
        try:
            await self._store.async_save({"entries": self._entries})
        except Exception:  # noqa: BLE001
            # History is a nice-to-have; a failed write must never take an
            # actual alert dispatch down with it.
            _LOGGER.exception("NL-Alert: kon geschiedenis niet opslaan")
