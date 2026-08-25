"""Offline checks for the pure logic in this integration.

Home Assistant itself is not importable outside its container, so the
modules under test are loaded into a synthetic package with the handful of
``homeassistant.*`` names they touch stubbed out. Everything exercised here
is deliberately side-effect free: URL building, message splitting, geometry,
time windows, notification payload shapes and the siren-test calendar maths.

Anything that needs a live hass (playing audio, casting, storing history) is
out of scope — that is what the panel's test buttons are for.

Run it straight:

    python3 custom_components/nl_alert/tests/offline_checks.py

It lives in the repo rather than a scratch directory because the previous
copy sat in /tmp and was wiped by the OS, taking 73 checks with it.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
import importlib.util
import os
import sys
import types

COMPONENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ── Stubs ─────────────────────────────────────────────────────────────────────


def stub(name: str, **attrs):
    """Register a fake module so the real import succeeds."""
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module
    return module


class NoURLAvailableError(Exception):
    """Stand-in for helpers.network.NoURLAvailableError."""


async def _no_descriptions(hass):
    """Stand-in for helpers.service.async_get_all_descriptions."""
    return {}


class FakeDt:
    """dt_util stand-in whose clock the tests move around."""

    class Now:
        value: datetime | None = None

    @staticmethod
    def now():
        return FakeDt.Now.value

    @staticmethod
    def utcnow():
        return FakeDt.Now.value or datetime(2026, 8, 9, 12, 0)

    @staticmethod
    def parse_datetime(value):
        try:
            return datetime.fromisoformat(value)
        except (TypeError, ValueError):
            return None


stub("homeassistant").__path__ = []
stub(
    "homeassistant.core",
    HomeAssistant=object,
    callback=lambda f: f,
    CALLBACK_TYPE=object,
)
stub("homeassistant.exceptions", HomeAssistantError=Exception)
stub("homeassistant.config_entries", ConfigEntry=object)
stub("homeassistant.components").__path__ = []
stub("homeassistant.components.tts", async_get_media_source_audio=None).__path__ = []
stub("homeassistant.components.tts.media_source", generate_media_source_id=None)
stub("homeassistant.helpers").__path__ = []
stub("homeassistant.helpers.entity_registry", async_get=lambda hass: None)
stub("homeassistant.helpers.service", async_get_all_descriptions=_no_descriptions)
stub("homeassistant.helpers.storage", Store=object)
stub(
    "homeassistant.helpers.event",
    async_track_point_in_time=lambda *a, **k: (lambda: None),
)
stub(
    "homeassistant.helpers.network",
    NoURLAvailableError=NoURLAvailableError,
    get_url=lambda hass, **kw: "http://homeassistant.local:8123",
)
stub("homeassistant.util").__path__ = []
sys.modules["homeassistant.util.dt"] = FakeDt
setattr(sys.modules["homeassistant.util"], "dt", FakeDt)

package = types.ModuleType("nl_alert_under_test")
package.__path__ = [COMPONENT]
sys.modules["nl_alert_under_test"] = package


def load(name: str):
    """Import one module of the integration as part of the fake package."""
    spec = importlib.util.spec_from_file_location(
        f"nl_alert_under_test.{name}", os.path.join(COMPONENT, f"{name}.py")
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"nl_alert_under_test.{name}"] = module
    spec.loader.exec_module(module)
    return module


notifier = load("notifier")
geo = load("geo")
siren = load("siren_test")
audio_scan = load("audio_scan")
history = load("history")


# ── Harness ───────────────────────────────────────────────────────────────────

failures: list[str] = []
passed = 0


def check(label: str, got, want) -> None:
    """Compare and record; prints one line per check."""
    global passed
    if got != want:
        failures.append(f"{label}\n  got:  {got!r}\n  want: {want!r}")
        print(f"FAIL  {label}")
    else:
        passed += 1
        print(f"ok    {label}")


# ── Alarm sound URLs ──────────────────────────────────────────────────────────
# The original bug: a relative, unencoded /local path that no speaker could
# fetch. Both halves of the fix are pinned here.

check(
    "a /local URL with spaces and brackets becomes absolute and encoded",
    notifier.resolve_media_url(None, "/local/sounds/Nadir [jingle] - Warning.mp3"),
    "http://homeassistant.local:8123/local/sounds/Nadir%20%5Bjingle%5D%20-%20Warning.mp3",
)
check(
    "an absolute URL keeps its host",
    notifier.resolve_media_url(None, "http://example.com/a b.mp3"),
    "http://example.com/a%20b.mp3",
)
check(
    "media-source URIs are only encoded, never rewritten",
    notifier.resolve_media_url(None, "media-source://media_source/local/x.mp3"),
    "media-source://media_source/local/x.mp3",
)
check("empty stays empty", notifier.resolve_media_url(None, ""), "")


# ── Step results ──────────────────────────────────────────────────────────────

check(
    "an error anywhere marks the run as failed",
    notifier.has_errors(
        [
            {"step": "a", "status": "ok", "detail": ""},
            {"step": "b", "status": "error", "detail": "boom"},
        ]
    ),
    True,
)
check(
    "the summary quotes only the failures",
    notifier.error_summary(
        [
            {"step": "a", "status": "ok", "detail": "fine"},
            {"step": "b", "status": "error", "detail": "boom"},
        ]
    ),
    "boom",
)


# ── Bilingual messages ────────────────────────────────────────────────────────

BILINGUAL = "Brand in Rotterdam. *** Fire in Rotterdam."

check(
    "the Dutch and English halves split on ***",
    notifier.split_message(BILINGUAL),
    ("Brand in Rotterdam.", "Fire in Rotterdam."),
)
check(
    "a Dutch-only alert has an empty English half",
    notifier.split_message("Alleen Nederlands."),
    ("Alleen Nederlands.", ""),
)
check(
    "a second separator stays inside the English half",
    notifier.split_message("NL *** EN one *** EN two"),
    ("NL", "EN one   EN two"),
)
check("an empty message splits into two empties", notifier.split_message(None), ("", ""))
check(
    "the push notification carries only the Dutch half",
    notifier._dutch_part(BILINGUAL),
    "Brand in Rotterdam.",
)


def segments(message, **options):
    """What actually reaches the TTS engine, per segment."""
    result, _steps = asyncio.run(
        notifier.async_build_segments(None, options, message)
    )
    return result


check(
    "the preamble leads and replaces the redundant Dutch cue",
    segments(BILINGUAL),
    [
        ("nl", "Attentie... Attentie... Dit is een NL-Alert. Brand in Rotterdam."),
        ("en", "English. Fire in Rotterdam."),
    ],
)
check(
    "without a preamble both halves are announced",
    segments(BILINGUAL, preamble_enabled=False),
    [("nl", "Nederlands. Brand in Rotterdam."), ("en", "English. Fire in Rotterdam.")],
)
check(
    "a custom preamble is used verbatim",
    segments(BILINGUAL, preamble_text="Let op."),
    [("nl", "Let op. Brand in Rotterdam."), ("en", "English. Fire in Rotterdam.")],
)
check(
    "Dutch-only with translation off is a single segment",
    segments("Brand in Rotterdam.", translate_missing_english=False),
    [("nl", "Attentie... Attentie... Dit is een NL-Alert. Brand in Rotterdam.")],
)
check(
    "everything off yields the bare text",
    segments(
        BILINGUAL,
        preamble_enabled=False,
        announce_language=False,
        speak_english=False,
    ),
    [("nl", "Brand in Rotterdam.")],
)


# ── Geometry ──────────────────────────────────────────────────────────────────
# A real polygon from the feed (Rotterdam, 2026-08-07).

POLY = (
    "51.77994,4.51627 51.78119,4.50206 51.78314,4.43142 51.87129,4.44305 "
    "51.89732,4.47963 51.82795,4.53129 51.78092,4.54942 51.77994,4.51627"
)
POINTS = geo.parse_polygon(POLY)
NL = {"min_lat": 50.70, "max_lat": 53.60, "min_lon": 3.20, "max_lon": 7.30}
WHOLE_COUNTRY = ["50.80,3.40 53.50,3.40 53.50,7.10 50.80,7.10 50.80,3.40"]

check("the polygon parses to 8 points", len(POINTS), 8)
check("points are (lat, lon)", POINTS[0], (51.77994, 4.51627))
check("a point inside the ring is detected", geo.point_in_polygon(51.83, 4.48, POINTS), True)
check("a point outside is not", geo.point_in_polygon(52.18, 4.99, POINTS), False)
check(
    "the bounding box spans every point",
    tuple(round(v, 3) for v in geo.polygons_bbox([POLY])),
    (51.78, 51.897, 4.431, 4.549),
)
# Radius: distance to the nearest EDGE, so a huge area whose border runs past
# your street is metres away however far its centre is.
check(
    "a point inside the area is zero km away",
    geo.distance_to_area_km(51.83, 4.48, [POLY]),
    0.0,
)
check(
    "just outside the northern edge is about a kilometre",
    round(geo.distance_to_area_km(51.9080, 4.4796, [POLY]), 1),
    1.2,
)
check(
    "Utrecht is tens of kilometres away",
    round(geo.distance_to_area_km(52.09, 5.12, [POLY])),
    49,
)
check(
    "no geometry means no distance",
    geo.distance_to_area_km(52.0, 5.0, []),
    None,
)
check(
    "distance is symmetric about the border, not the centre",
    geo.distance_to_area_km(51.9080, 4.4796, [POLY])
    < geo.distance_to_area_km(52.09, 5.12, [POLY]),
    True,
)

check("an alert with no area counts as national", geo.is_national([], NL), True)
check("a city-sized area does not", geo.is_national([POLY], NL), False)
check("a country-spanning polygon does", geo.is_national(WHOLE_COUNTRY, NL), True)


# ── Night mode ────────────────────────────────────────────────────────────────

NIGHT = {"night_start": "22:30", "night_end": "07:00"}


def at(clock: str, **options):
    """Ask is_night() as if the clock read `clock`."""
    hour, minute = (int(part) for part in clock.split(":"))
    FakeDt.Now.value = datetime(2026, 8, 9, hour, minute)
    return notifier.is_night(None, {**NIGHT, **options})


check("23:00 is inside a window crossing midnight", at("23:00"), True)
check("03:00 is still night", at("03:00"), True)
check("06:59 is the last night minute", at("06:59"), True)
check("07:00 is no longer night", at("07:00"), False)
check("14:00 is daytime", at("14:00"), False)
check("22:29 is just before the window", at("22:29"), False)
check("the toggle disables it entirely", at("03:00", night_enabled=False), False)
check(
    "a same-day window works too",
    at("14:00", night_start="13:00", night_end="15:00"),
    True,
)
check("a malformed time falls back instead of raising", at("03:00", night_start="x"), True)

FakeDt.Now.value = datetime(2026, 8, 9, 3, 0)
check(
    "night volume replaces the day volume",
    notifier.effective_volume(None, {**NIGHT, "volume_pct": 70, "night_volume_pct": 40}),
    40.0,
)
check(
    "the night sound overrides the day sound",
    notifier.effective_alarm_sound(
        None, {**NIGHT, "alarm_sound_url": "/a.wav", "night_alarm_sound_url": "/b.wav"}
    ),
    "/b.wav",
)
FakeDt.Now.value = datetime(2026, 8, 9, 14, 0)
check(
    "by day the normal volume applies",
    notifier.effective_volume(None, {**NIGHT, "volume_pct": 70, "night_volume_pct": 40}),
    70.0,
)
check(
    "and the normal sound",
    notifier.effective_alarm_sound(
        None, {**NIGHT, "alarm_sound_url": "/a.wav", "night_alarm_sound_url": "/b.wav"}
    ),
    "/a.wav",
)


# ── Casting ───────────────────────────────────────────────────────────────────

CAST = {
    **NIGHT,
    "cast_enabled": True,
    "cast_entities": ["media_player.tv1", "media_player.tv2"],
    "cast_view_path": "alert",
}


def cast_at(clock: str, **options):
    """Ask should_cast() as if the clock read `clock`."""
    hour, minute = (int(part) for part in clock.split(":"))
    FakeDt.Now.value = datetime(2026, 8, 9, hour, minute)
    return notifier.should_cast(None, {**CAST, **options})[0]


check("by day a configured TV is cast to", cast_at("20:00"), True)
check("at night it stays off by default", cast_at("03:00"), False)
check("unless the night override is on", cast_at("03:00", cast_at_night=True), True)
check("disabled means never", cast_at("20:00", cast_enabled=False), False)
check("no TV chosen means never", cast_at("20:00", cast_entities=[]), False)
check("no view configured means never", cast_at("20:00", cast_view_path=""), False)
check(
    "every chosen TV is returned",
    notifier.cast_targets(CAST),
    ["media_player.tv1", "media_player.tv2"],
)
check(
    "a config from before multi-TV still resolves",
    notifier.cast_targets({"cast_entity": "media_player.old"}),
    ["media_player.old"],
)
check(
    "the list wins when both keys are present",
    notifier.cast_targets(
        {"cast_entities": ["media_player.new"], "cast_entity": "media_player.old"}
    ),
    ["media_player.new"],
)
check(
    "the skip reason explains itself",
    notifier.should_cast(None, {**CAST, "cast_enabled": False})[1],
    "Casten naar de TV staat uit.",
)


class FakeState:
    """Minimal hass state stand-in."""

    def __init__(self, state: str, features: int = 0) -> None:
        self.state = state
        self.attributes = {"supported_features": features}


class FakeHass:
    """Enough of hass for the TURN_ON feature check."""

    def __init__(self, mapping: dict[str, FakeState]) -> None:
        self.states = self
        self._mapping = mapping

    def get(self, entity_id: str):
        return self._mapping.get(entity_id)


HASS = FakeHass(
    {
        "media_player.can": FakeState("off", 128 | 512),
        "media_player.cannot": FakeState("off", 512),
    }
)
check("a TURN_ON capable player is detected", notifier._supports_turn_on(HASS, "media_player.can"), True)
check("one without the bit is not", notifier._supports_turn_on(HASS, "media_player.cannot"), False)
check("an unknown entity is not", notifier._supports_turn_on(HASS, "media_player.nope"), False)
check(
    "off/standby/unavailable/unknown all count as asleep",
    sorted(notifier.CAST_ASLEEP_STATES),
    ["off", "standby", "unavailable", "unknown"],
)


# ── Notification payloads ─────────────────────────────────────────────────────

critical = notifier.notify_payload(
    {"notify_critical": True}, "notify.mobile_app_x", "Titel", "Bericht"
)
check("critical carries the iOS key", critical["data"]["interruption-level"], "critical")
check("and the Android alarm stream", critical["data"]["channel"], "alarm_stream")
check("with the visible text intact", critical["message"], "Bericht")
check(
    "a normal notification carries no data block",
    "data"
    in notifier.notify_payload(
        {"notify_critical": False}, "notify.mobile_app_x", "Titel", "Bericht"
    ),
    False,
)

spoken = notifier.notify_payload(
    {"notify_critical": True, "notify_tts_targets": ["notify.samsung"]},
    "notify.samsung",
    "Titel",
    "Brand in Rotterdam.",
)
check("the Samsung route sends the TTS marker", spoken["message"], "TTS")
check("with the real text in tts_text", spoken["data"]["tts_text"], "Brand in Rotterdam.")
check("over the alarm stream at max", spoken["data"]["media_stream"], "alarm_stream_max")
check(
    "a target not on that list keeps the normal shape",
    notifier.notify_payload(
        {"notify_critical": True, "notify_tts_targets": ["notify.other"]},
        "notify.mobile_app_x",
        "Titel",
        "Bericht",
    )["message"],
    "Bericht",
)


# ── Monthly siren test ────────────────────────────────────────────────────────

check("Aug 2026 starts on a Saturday, so Monday the 3rd", siren.first_monday(2026, 8), 3)
check("Sep 2026 starts on a Tuesday, so Monday the 7th", siren.first_monday(2026, 9), 7)
check("Jun 2026 starts on a Monday, so the 1st", siren.first_monday(2026, 6), 1)
check("Feb 2027 starts on a Monday, so the 1st", siren.first_monday(2027, 2), 1)


def nxt(*args):
    """next_siren_test() for a naive local datetime."""
    return siren.next_siren_test(datetime(*args))


check("mid-month looks ahead to next month", nxt(2026, 8, 20), datetime(2026, 9, 7, 12, 0))
check("the morning of the day itself counts", nxt(2026, 8, 3, 9, 0), datetime(2026, 8, 3, 12, 0))
check("one second before is still today", nxt(2026, 8, 3, 11, 59, 59), datetime(2026, 8, 3, 12, 0))
check("exactly on the dot rolls forward", nxt(2026, 8, 3, 12, 0, 0), datetime(2026, 9, 7, 12, 0))
check("one second after rolls forward", nxt(2026, 8, 3, 12, 0, 1), datetime(2026, 9, 7, 12, 0))
check("December rolls into the next year", nxt(2026, 12, 20), datetime(2027, 1, 4, 12, 0))
check(
    "every month resolves to a Monday at noon",
    sorted({nxt(2026, m, 15).strftime("%a %H:%M") for m in range(1, 13)}),
    ["Mon 12:00"],
)


# ── Shipped sounds ────────────────────────────────────────────────────────────

builtin = audio_scan._scan_builtin_sync()
names = [item["name"] for item in builtin]
check("all shipped sounds are discovered", len(builtin), 6)
check("the slow whoop keeps its own label", "Slow whoop (evacuatie)" in names, True)
check("they are sorted on label, not filename", names, sorted(names, key=str.lower))
check(
    "each is served from the integration's own path",
    all(item["url"].startswith("/nl_alert_sounds/") for item in builtin),
    True,
)


# ── History retention ─────────────────────────────────────────────────────────
# _prune is pure list work, so it can be exercised on a bare instance.

log = history.NLAlertHistory.__new__(history.NLAlertHistory)
FakeDt.Now.value = datetime(2026, 8, 9, 12, 0)
recent = (FakeDt.utcnow() - timedelta(days=30)).isoformat()
old = (FakeDt.utcnow() - timedelta(days=400)).isoformat()
log._entries = [
    {"id": "recent", "recorded_at": recent},
    {"id": "old", "recorded_at": old},
    {"id": "broken", "recorded_at": "not-a-date"},
]
removed = log._prune()
check("pruning reports that it dropped something", removed, True)
check(
    "only entries past a year are dropped, unparseable ones are kept",
    [entry["id"] for entry in log._entries],
    ["recent", "broken"],
)
check("a second pass has nothing left to do", log._prune(), False)


# ── Result ────────────────────────────────────────────────────────────────────

print()
if failures:
    print(f"{len(failures)} FAILED, {passed} passed\n")
    for failure in failures:
        print(failure)
    sys.exit(1)
print(f"all {passed} checks passed")
