"""Geometry helpers for NL-Alert polygon checks."""
from __future__ import annotations


def parse_polygon(area_string: str) -> list[tuple[float, float]]:
    """Parse a polygon string from the NL-Alert API.

    Format: "lat,lon lat,lon lat,lon ..."
    Returns a list of (lat, lon) tuples.
    """
    points: list[tuple[float, float]] = []
    for pair in area_string.strip().split():
        try:
            lat_str, lon_str = pair.split(",")
            points.append((float(lat_str), float(lon_str)))
        except (ValueError, AttributeError):
            # Skip malformed coordinate pairs.
            continue
    return points


def point_in_polygon(
    lat: float, lon: float, polygon: list[tuple[float, float]]
) -> bool:
    """Determine whether a point is inside a polygon using ray casting.

    Polygon is a list of (lat, lon) tuples. Polygon is treated as closed
    (last vertex connects back to first).
    """
    n = len(polygon)
    if n < 3:
        return False

    inside = False
    j = n - 1
    for i in range(n):
        lat_i, lon_i = polygon[i]
        lat_j, lon_j = polygon[j]

        # Check whether the horizontal ray from (lon, lat) crosses edge i-j.
        intersects = ((lat_i > lat) != (lat_j > lat)) and (
            lon
            < (lon_j - lon_i) * (lat - lat_i) / (lat_j - lat_i + 1e-15) + lon_i
        )
        if intersects:
            inside = not inside
        j = i

    return inside


def point_in_any_polygon(
    lat: float, lon: float, area: list[str]
) -> bool:
    """Return True if (lat, lon) falls inside any polygon in the area list."""
    for poly_str in area:
        polygon = parse_polygon(poly_str)
        if polygon and point_in_polygon(lat, lon, polygon):
            return True
    return False


def polygons_bbox(
    area: list[str],
) -> tuple[float, float, float, float] | None:
    """Return ``(min_lat, max_lat, min_lon, max_lon)`` over every polygon."""
    min_lat = min_lon = 1e9
    max_lat = max_lon = -1e9
    for poly_str in area or []:
        for lat, lon in parse_polygon(poly_str):
            min_lat = min(min_lat, lat)
            max_lat = max(max_lat, lat)
            min_lon = min(min_lon, lon)
            max_lon = max(max_lon, lon)
    if min_lat > max_lat:
        return None
    return (min_lat, max_lat, min_lon, max_lon)


def is_national(area: list[str], bounds: dict[str, float]) -> bool:
    """Is this alert effectively nationwide?

    Used to decide whether to sound the alarm for something that doesn't
    cover your own address. Two cases count as national: an alert with no
    area at all (the feed does this for country-wide messages, including the
    monthly test), and one whose bounding box spans most of the country.
    The 70% threshold is deliberately loose — a province-sized area should
    not qualify, but a "whole of NL" polygon traced slightly inside the
    borders should.
    """
    if not area:
        return True
    box = polygons_bbox(area)
    if box is None:
        return True
    min_lat, max_lat, min_lon, max_lon = box
    nl_lat = bounds["max_lat"] - bounds["min_lat"]
    nl_lon = bounds["max_lon"] - bounds["min_lon"]
    if nl_lat <= 0 or nl_lon <= 0:
        return False
    return (
        (max_lat - min_lat) >= 0.7 * nl_lat
        and (max_lon - min_lon) >= 0.7 * nl_lon
    )


# ── Distance ──────────────────────────────────────────────────────────────────
#
# NL-Alert areas are drawn around an incident, not around addresses, so a fire
# one street outside the polygon is still your fire. A radius lets the user
# widen the catch without touching the feed's geometry.

# Kilometres per degree. Longitude shrinks towards the poles, hence the cosine
# correction applied per-alert below. Over the tens of kilometres this is used
# for, treating the result as flat costs well under a metre.
_KM_PER_DEG_LAT = 110.574
_KM_PER_DEG_LON = 111.320


def _to_local_km(
    lat: float, lon: float, lat0: float, lon0: float
) -> tuple[float, float]:
    """Project to a flat kilometre grid centred on (lat0, lon0)."""
    import math

    return (
        (lon - lon0) * _KM_PER_DEG_LON * math.cos(math.radians(lat0)),
        (lat - lat0) * _KM_PER_DEG_LAT,
    )


def _point_to_segment_km(
    px: float, py: float, ax: float, ay: float, bx: float, by: float
) -> float:
    """Shortest distance from a point to a line segment, all in km."""
    import math

    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def distance_to_area_km(lat: float, lon: float, area: list[str]) -> float | None:
    """Distance in km from (lat, lon) to the nearest edge of any polygon.

    0.0 when the point is inside — being in the area is not "0 km away from
    the edge", it is simply in it. None when there is no usable geometry.

    Measured to the nearest EDGE, not to the centre: a province-sized area
    whose border runs past your street is metres away, however far its
    midpoint happens to be.
    """
    if not area:
        return None
    if point_in_any_polygon(lat, lon, area):
        return 0.0

    best: float | None = None
    for poly_str in area:
        polygon = parse_polygon(poly_str)
        if len(polygon) < 2:
            continue
        points = [_to_local_km(plat, plon, lat, lon) for plat, plon in polygon]
        for index in range(len(points)):
            ax, ay = points[index]
            bx, by = points[(index + 1) % len(points)]
            distance = _point_to_segment_km(0.0, 0.0, ax, ay, bx, by)
            if best is None or distance < best:
                best = distance
    return best
