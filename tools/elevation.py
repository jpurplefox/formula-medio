"""Extracts a track's elevation profile from F1 telemetry.

Uses the open OpenF1 API (https://openf1.org), which has the X, Y, Z positions of the cars.
Averages the fastest laps of a race and saves the height as a function of the lap fraction
(0 = start line, 1 = full lap). Uses only the standard library.

Usage:
    python3 tools/elevation.py Interlagos 2023 tracks/interlagos.elevation.json
"""

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

API = "https://api.openf1.org/v1"
SAMPLES = 256
LAPS = 5


def get(endpoint: str, **params: object) -> list[dict]:
    query = urllib.parse.urlencode(params, safe="<>=")
    for attempt in range(6):
        try:
            with urllib.request.urlopen(f"{API}/{endpoint}?{query}", timeout=60) as r:
                data = json.load(r)
            break
        except urllib.error.HTTPError as e:
            # 429: we asked too fast; wait longer each time and retry
            if e.code != 429 or attempt == 5:
                raise
            time.sleep(5 * 2**attempt)
    time.sleep(0.4)  # respect the API's request limit
    return data


def lap_profile(session_key: int, lap: dict) -> tuple[list[float], float]:
    start = datetime.fromisoformat(lap["date_start"])
    end = start + timedelta(seconds=lap["lap_duration"])
    points = get(
        "location",
        session_key=session_key,
        driver_number=lap["driver_number"],
        **{"date>": start.isoformat(), "date<": end.isoformat()},
    )
    # OpenF1 gives positions in tenths of a meter
    xs = [p["x"] / 10 for p in points]
    ys = [p["y"] / 10 for p in points]
    zs = [p["z"] / 10 for p in points]
    dist = [0.0]
    for i in range(1, len(points)):
        dist.append(dist[-1] + ((xs[i] - xs[i - 1]) ** 2 + (ys[i] - ys[i - 1]) ** 2) ** 0.5)
    length = dist[-1]
    # The lap is a closed loop: spread the small closure error along the lap
    closure = zs[-1] - zs[0]
    heights = []
    j = 0
    for k in range(SAMPLES):
        f = k / SAMPLES
        target = f * length
        while j < len(dist) - 2 and dist[j + 1] < target:
            j += 1
        t = (target - dist[j]) / max(1e-9, dist[j + 1] - dist[j])
        heights.append(zs[j] + (zs[j + 1] - zs[j]) * t - closure * f)
    return heights, length


def main(circuit: str, year: int, out: Path) -> None:
    sessions = get("sessions", circuit_short_name=circuit, session_name="Race", year=year)
    if not sessions:
        sys.exit(f"Could not find the {year} race at {circuit}")
    session_key = sessions[0]["session_key"]

    laps = [
        l for l in get("laps", session_key=session_key)
        if l.get("lap_duration") and l.get("date_start") and not l.get("is_pit_out_lap")
    ]
    laps.sort(key=lambda l: l["lap_duration"])
    best = laps[:LAPS]

    profiles, lengths = [], []
    for lap in best:
        h, length = lap_profile(session_key, lap)
        profiles.append(h)
        lengths.append(length)
        print(f"  car {lap['driver_number']:>2} lap {lap['lap_number']:>2}: {lap['lap_duration']:.3f}s, {length:.0f} m")

    heights = [sum(p[k] for p in profiles) / len(profiles) for k in range(SAMPLES)]
    low = min(heights)
    heights = [h - low for h in heights]

    data = {
        "source": f"OpenF1 · {year} race at {circuit} · average of the {len(best)} fastest laps",
        "lapLengthMeters": round(sum(lengths) / len(lengths), 1),
        "heightsMeters": [round(h, 2) for h in heights],
    }
    out.write_text(json.dumps(data, ensure_ascii=False))
    print(data["source"])
    print(f"Lap length: {data['lapLengthMeters']:.0f} m · elevation change: {max(heights):.1f} m")


if __name__ == "__main__":
    circuit, year, out = sys.argv[1:4]
    main(circuit, int(year), Path(out))
