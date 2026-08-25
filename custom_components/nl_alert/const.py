"""Constants for the NL-Alert integration.

Changelog:
  0.3.0 (2026-08-09): Panel release. New option keys for the custom panel
                      (show_in_sidebar), for the rebuilt TTS pipeline
                      (tts_entity — needed because chime_tts.say silently
                      does nothing without a tts_platform, and tts.speak
                      needs a target tts.* entity), and for the national
                      map card (map_zoom). Alert-type constants added so
                      the panel can colour/filter by type.
"""
from __future__ import annotations

from datetime import timedelta

DOMAIN = "nl_alert"
MANUFACTURER = "public-warning.app"

API_URL = "https://api.public-warning.app/api/v1/providers/nl-alert/alerts"
API_TIMEOUT = 30  # seconds

DEFAULT_SCAN_INTERVAL = timedelta(minutes=5)

# NL-Alert is always Dutch (sometimes followed by an English translation
# after a ``***`` separator, which we strip before sending to TTS / notify).
TTS_LANGUAGE = "nl"

# Location / polling
CONF_LATITUDE = "latitude"
CONF_LONGITUDE = "longitude"
CONF_USE_HOME_LOCATION = "use_home_location"
CONF_SCAN_INTERVAL_MINUTES = "scan_interval_minutes"

POLLING_CHOICES = [str(n) for n in range(1, 11)]  # "1" … "10"
DEFAULT_POLLING_MINUTES = 5

# How far outside an alert area still counts as "here". The feed draws its
# polygons around the incident, not around addresses, so a fire one street
# past the border is still your fire. 0 keeps the strict behaviour (inside
# the polygon or nothing), which is what every install had before this
# existed — widening what sets off the alarm is the user's call, not a
# silent upgrade.
CONF_ALERT_RADIUS_KM = "alert_radius_km"
DEFAULT_ALERT_RADIUS_KM = 0

# Media player / TTS
CONF_MEDIA_PLAYERS = "media_players"          # list[str]
CONF_ALARM_SOUND_URL = "alarm_sound_url"      # str (optional)
CONF_ALARM_DURATION = "alarm_duration_seconds"
CONF_VOLUME_PCT = "volume_pct"                # int 0..100
CONF_TTS_SERVICE = "tts_service"              # "tts.speak" | "chime_tts.say" | legacy
CONF_TTS_ENTITY = "tts_entity"                # tts.* entity backing the service

# Bilingual announcements. A real NL-Alert is Dutch, then (usually) the same
# warning in English after a ``***`` separator. Before 0.4.0 everything after
# the separator was thrown away; now both halves are spoken, each in its own
# language, and the missing half can be translated on the fly.
CONF_SPEAK_ENGLISH = "speak_english"                    # bool, default True
CONF_ANNOUNCE_LANGUAGE = "announce_language"            # bool, default True
CONF_TRANSLATE_MISSING = "translate_missing_english"    # bool, default True
CONF_TRANSLATE_AGENT = "translate_agent"                # ai_task.* entity

SEPARATOR = "***"

# Spoken before the alert text so a listener knows what they are hearing
# before the actual warning starts — by the time the message begins you have
# already looked up. Editable in the panel; the ellipses read as pauses.
CONF_PREAMBLE = "preamble_enabled"          # bool, default True
CONF_PREAMBLE_TEXT = "preamble_text"        # str
DEFAULT_PREAMBLE = "Attentie... Attentie... Dit is een NL-Alert."

# Spoken before each half when announce_language is on, in that half's own
# language so it stays intelligible.
LANGUAGE_NAMES = {"nl": "Nederlands.", "en": "English."}

# Language codes to try, in order, when handing a segment to a TTS engine.
# Engines disagree: google_translate wants "nl", Nabu Casa Cloud advertises
# "nl-NL". Trying the bare code first and falling back beats hardcoding a
# per-engine table that would rot.
LANGUAGE_CANDIDATES = {
    "nl": ["nl", "nl-NL"],
    "en": ["en", "en-US", "en-GB"],
}

DEFAULT_ALARM_DURATION = 5
DEFAULT_VOLUME_PCT = 70

# Night mode. A speaker set to 70% is fine in a noisy living room and
# genuinely painful at 03:00. Driven by a plain time window rather than a
# helper entity: this integration runs in other people's setups, and a window
# needs nothing to exist beforehand.
CONF_NIGHT_ENABLED = "night_enabled"                  # bool, default True
CONF_NIGHT_START = "night_start"                      # "HH:MM"
CONF_NIGHT_END = "night_end"                          # "HH:MM"
CONF_NIGHT_VOLUME_PCT = "night_volume_pct"
CONF_NIGHT_ALARM_SOUND_URL = "night_alarm_sound_url"  # optional override

DEFAULT_NIGHT_VOLUME_PCT = 40
DEFAULT_NIGHT_START = "22:30"
DEFAULT_NIGHT_END = "07:00"

# Notification
CONF_NOTIFY_SERVICES = "notify_services"      # list[str]
# Critical delivery. An NL-Alert that arrives silently because the phone is
# on mute defeats the point, so this defaults to on.
CONF_NOTIFY_CRITICAL = "notify_critical"              # bool, default True
# Per-target opt-in for the spoken variant. Deliberately not automatic: it
# changes WHAT the recipient hears (the message read aloud instead of a
# tone), which is not a decision to make on someone's behalf.
CONF_NOTIFY_TTS_TARGETS = "notify_tts_targets"        # list[str]

# Alert scope — what an alert covers, and therefore whether it makes noise.
SCOPE_LOCAL = "local"          # its area contains the monitored location
SCOPE_NATIONAL = "national"    # country-wide (includes the monthly test)
SCOPE_ELSEWHERE = "elsewhere"  # somewhere else in the country

# Cast to TV. HA Cast can only show a Lovelace view, never a custom panel,
# so this points at a dashboard/view the user builds — with nl-alert-card on
# it, ideally. Off by default: it needs a Chromecast-capable device and an
# HTTPS-reachable instance, neither of which is a given.
CONF_CAST_ENABLED = "cast_enabled"            # bool, default False
CONF_CAST_ENTITIES = "cast_entities"          # list[str] of cast media_players
CONF_CAST_ENTITY = "cast_entity"              # legacy single value, still read
CONF_CAST_DASHBOARD = "cast_dashboard_path"   # e.g. "dashboard-tv"; blank = default
CONF_CAST_VIEW = "cast_view_path"             # view path within that dashboard
CONF_CAST_AT_NIGHT = "cast_at_night"          # bool, default False

# Waking the TV. A cast command does not reliably power on a set that is
# fully off — Philips/Android TVs in particular only wake from standby, and
# only with the right HDMI-CEC settings. So turn it on first: the cast entity
# itself when it advertises TURN_ON, plus any extra entities the user points
# at (an androidtv_remote entity, a CEC switch, a script — homeassistant.turn_on
# works across all of those).
CONF_CAST_TURN_ON = "cast_turn_on"                  # bool, default True
CONF_CAST_POWER_ENTITIES = "cast_power_entities"    # list[str], optional
CAST_WAKE_TIMEOUT = 15  # seconds to wait for a TV to leave the off state
# States that mean "not awake yet". Chromecast reports off/standby; a set
# that is still booting shows up as unavailable for a moment.
CAST_ASLEEP_STATES = {"off", "standby", "unavailable", "unknown"}
MEDIA_PLAYER_FEATURE_TURN_ON = 128  # MediaPlayerEntityFeature.TURN_ON

# Monthly siren test — the Dutch air-raid sirens sound on the first Monday
# of every month at 12:00, and are skipped on public holidays. Reproduced
# locally rather than waited for: the API poll can be a minute late, which
# defeats the point of a test everyone recognises by its timing.
CONF_SIREN_TEST_ENABLED = "siren_test_enabled"   # bool, default False
CONF_SIREN_TEST_LEAD = "siren_test_lead"         # seconds before the sound
CONF_HOLIDAY_ENTITY = "holiday_entity"           # calendar.* from HA's Holiday

DEFAULT_SIREN_TEST_LEAD = 30
SIREN_TEST_HOUR = 12
SIREN_TEST_MINUTE = 0

SIREN_TEST_NOTIFY_TITLE = "NL-Alert — maandelijkse test"
SIREN_TEST_WARNING = (
    "Over 30 seconden klinkt het maandelijkse testalarm. Er is niets aan de hand."
)
SIREN_TEST_MESSAGE = "Maandelijkse test van het luchtalarm (eerste maandag, 12:00)."

# Repair issue raised when the siren test is on but HA has no holiday source.
ISSUE_HOLIDAY_MISSING = "holiday_integration_missing"

# Panel
CONF_SHOW_IN_SIDEBAR = "show_in_sidebar"      # bool, default True
# One-shot welcome screen. Stored on the config entry rather than in the
# browser: the disclaimer is about this installation, so it should not
# reappear because someone opened the panel on the tablet instead of the
# laptop — nor stay dismissed after a reinstall.
CONF_WELCOME_SEEN = "welcome_seen"            # bool, default False
CONF_MAP_SHOW_NATIONAL = "map_show_national"  # bool, default True

# Audio scanning
AUDIO_EXTENSIONS = {".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac"}
MAX_AUDIO_FILES = 200

# Built-in alarm sounds. Shipped in the integration's own ``sounds/`` folder
# and served at SOUNDS_URL_PATH, so a fresh install has a working alarm out
# of the box instead of pointing at a file from some other integration.
SOUNDS_URL_PATH = "/nl_alert_sounds"

# Pre-rendered speech. The Dutch and English halves are generated up front
# and stitched into one file, so the speaker plays a single uninterrupted
# clip instead of us guessing when the first half has finished.
SPEECH_URL_PATH = "/nl_alert_speech"
SPEECH_CACHE_MAX_AGE = 600  # seconds; rendered clips are cleaned up after this
# Attentietoon: the steady dual tone. Cuts through room noise without being
# as startling as the sirens, which matters most at night — an NL-Alert can
# arrive at 3am and the point is to be heard, not to frighten.
DEFAULT_ALARM_SOUND = f"{SOUNDS_URL_PATH}/attention-tone.wav"

# Filename → label shown in the panel. Anything in sounds/ that isn't listed
# here still shows up, just under its bare filename.
BUILTIN_SOUND_LABELS = {
    "siren-two-tone.wav": "Tweetonige sirene",
    "siren-sweep.wav": "Oplopende sirene",
    "slow-whoop.wav": "Slow whoop (evacuatie)",
    "attention-tone.wav": "Attentietoon",
    "alert-chime.wav": "Aankondigingsklank",
    "alert-pips.wav": "Korte pieptonen",
}

# Services
SERVICE_TEST_ALERT = "test_alert"

# Test kinds accepted by the panel's nl_alert/test websocket command and by
# the button platform. "full" is alarm + TTS + push, i.e. exactly what a real
# alert does.
TEST_ALARM = "alarm"
TEST_ANNOUNCEMENT = "announcement"
TEST_NOTIFY = "notify"
TEST_CAST = "cast"
TEST_FULL = "full"

# Default test payload (Dutch first, then English after ***, mirroring real NL-Alerts)
DEFAULT_TEST_MESSAGE = (
    "Dit is een TEST van de Home Assistant NL-Alert integratie. "
    "Er is geen daadwerkelijke waarschuwing. "
    "*** This is a TEST. No real warning is in effect."
)

EVENT_NEW_ALERT = f"{DOMAIN}_new_alert"

PLATFORMS = ["binary_sensor", "button", "sensor"]

# Geographic bounding box of the Netherlands, used by the panel's national
# map to pick a tile window. Slightly padded so alerts on the border (and the
# Wadden islands) stay inside the frame.
NL_BOUNDS = {
    "min_lat": 50.70,
    "max_lat": 53.60,
    "min_lon": 3.20,
    "max_lon": 7.30,
}
