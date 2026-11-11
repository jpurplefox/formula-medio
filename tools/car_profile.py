"""Builds an F1 car profile from OpenF1 telemetry (https://openf1.org).

Takes the fastest laps of a race and, from the speed, RPM, gear, throttle, brake and position of
the cars, computes:
  - the ratio of each gear (km/h per rpm) and the maximum and shift RPM,
  - how hard the car accelerates at full throttle and how hard it brakes, by speed,
  - how much it slows when lifting off everything (air drag and engine braking),
  - how much lateral grip it has by speed (from the curvature of its path).
Uses only the standard library.

Usage:
    python3 tools/car_profile.py Interlagos 2023 cars/f1-2023.json
"""

import json
import math
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

API = "https://api.openf1.org/v1"
LAPS = 15
SPEED_BIN = 20  # km/h


def get(endpoint: str, **params: object) -> list[dict]:
    query = urllib.parse.urlencode(params, safe="<>=")
    for attempt in range(4):
        try:
            with urllib.request.urlopen(f"{API}/{endpoint}?{query}", timeout=60) as r:
                data = json.load(r)
            time.sleep(0.4)  # respect the API's request limit
            return data
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("OpenF1 did not respond (too many requests)")


def seconds(date: str) -> float:
    return datetime.fromisoformat(date).timestamp()


def percentile(values: list[float], p: float) -> float:
    values = sorted(values)
    k = (len(values) - 1) * p
    lo = math.floor(k)
    hi = min(lo + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (k - lo)


def table(samples: list[tuple[float, float]], p: float, min_count: int = 6) -> list[list[float]]:
    """Groups (speed km/h, value) into speed bins and returns [speed m/s, percentile p]."""
    bins: dict[int, list[float]] = {}
    for kmh, value in samples:
        bins.setdefault(int(kmh // SPEED_BIN), []).append(value)
    rows = []
    for b in sorted(bins):
        if len(bins[b]) >= min_count:
            mid = (b + 0.5) * SPEED_BIN
            rows.append([round(mid / 3.6, 1), round(percentile(bins[b], p), 2)])
    return rows


def fit_v2(rows: list[list[float]], vmin: float, vmax: float) -> dict:
    """Fits a + b·v² (least squares) to the rows [v, a] with vmin ≤ v ≤ vmax.
    It is the physical shape of downforce: more speed, more load, more grip and more braking."""
    pts = [(v * v, a) for v, a in rows if vmin <= v <= vmax]
    n = len(pts)
    mx = sum(x for x, _ in pts) / n
    my = sum(y for _, y in pts) / n
    sxx = sum((x - mx) ** 2 for x, _ in pts)
    b = max(0.0, sum((x - mx) * (y - my) for x, y in pts) / sxx) if sxx else 0.0
    return {"base": round(my - b * mx, 2), "perV2": round(b, 5)}


def lap_data(session_key: int, lap: dict) -> tuple[list[dict], list[dict]]:
    start = datetime.fromisoformat(lap["date_start"])
    end = start + timedelta(seconds=lap["lap_duration"])
    window = {"date>": start.isoformat(), "date<": end.isoformat()}
    car = get("car_data", session_key=session_key, driver_number=lap["driver_number"], **window)
    loc = get("location", session_key=session_key, driver_number=lap["driver_number"], **window)
    return car, loc


def lateral_samples(car: list[dict], loc: list[dict]) -> list[tuple[float, float]]:
    """Lateral acceleration v²·curvature, with the curvature of the circle through 3 positions."""
    if len(loc) < 7 or len(car) < 2:
        return []
    ct = [seconds(c["date"]) for c in car]
    out = []
    for i in range(3, len(loc) - 3):
        a, b, c = loc[i - 3], loc[i], loc[i + 3]
        ax, ay, bx, by, cx, cy = a["x"] / 10, a["y"] / 10, b["x"] / 10, b["y"] / 10, c["x"] / 10, c["y"] / 10
        ab, bc, ca = math.hypot(bx - ax, by - ay), math.hypot(cx - bx, cy - by), math.hypot(ax - cx, ay - cy)
        area = abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2
        if ab < 5 or bc < 5 or area < 1e-6:
            continue
        radius = ab * bc * ca / (4 * area)
        # speed at that instant (the car telemetry has a different sample rate)
        t = seconds(b["date"])
        j = min(range(len(ct)), key=lambda k: abs(ct[k] - t))
        kmh = car[j]["speed"]
        v = kmh / 3.6
        out.append((kmh, v * v / radius))
    return out


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

    ratios: dict[int, list[float]] = {}
    upshift, downshift, rpms, speeds = [], [], [], []
    accel, brake, coast, lateral = [], [], [], []

    for lap in best:
        car, loc = lap_data(session_key, lap)
        print(f"  car {lap['driver_number']:>2} lap {lap['lap_number']:>2}: {lap['lap_duration']:.3f}s, {len(car)} samples")
        for p in car:
            rpms.append(p["rpm"])
            speeds.append(p["speed"])
            if p["n_gear"] >= 1 and p["rpm"] > 6000 and p["throttle"] >= 90 and p["speed"] > 30:
                ratios.setdefault(p["n_gear"], []).append(p["speed"] / p["rpm"])
        for a, b in zip(car, car[1:]):
            dt = seconds(b["date"]) - seconds(a["date"])
            if not 0.1 < dt < 0.5:
                continue
            dv = (b["speed"] - a["speed"]) / 3.6 / dt
            mid = (a["speed"] + b["speed"]) / 2
            if b["n_gear"] == a["n_gear"] + 1:
                upshift.append(a["rpm"])
            if b["n_gear"] == a["n_gear"] - 1:
                downshift.append(b["rpm"])
            if a["throttle"] >= 98 and b["throttle"] >= 98 and a["brake"] == 0 and b["brake"] == 0:
                accel.append((mid, dv))
            elif a["brake"] > 0 and b["brake"] > 0:
                brake.append((mid, -dv))
            elif a["throttle"] < 5 and b["throttle"] < 5 and a["brake"] == 0 and b["brake"] == 0:
                coast.append((mid, -dv))
        lateral += lateral_samples(car, loc)

    # ratio of each gear; those barely used at full throttle are estimated by following the progression
    known = {g: statistics.median(r) for g, r in ratios.items() if len(r) >= 10}
    top = max(known)
    for g in range(top - 1, 0, -1):
        if g not in known:
            known[g] = known[g + 1] * known[g + 1] / known[g + 2]
    brake_rows = table(brake, 0.9)
    grip_rows = table(lateral, 0.9)
    data = {
        "source": f"OpenF1 · {year} race at {circuit} · {len(best)} fastest laps",
        "maxRpm": round(percentile(rpms, 0.995)),
        "upshiftRpm": round(statistics.median(upshift)),
        "downshiftRpm": round(statistics.median(downshift)),
        "topSpeed": round(max(speeds) / 3.6, 1),
        # km/h per rpm for each gear, from 1st up (those not seen at full throttle are estimated)
        "gearKmhPerRpm": [round(known[g], 5) for g in range(1, top + 1)],
        "estimatedGears": [g for g in range(1, top + 1) if g not in ratios or len(ratios[g]) < 10],
        # [speed m/s, m/s²]: full-throttle acceleration and no-pedal deceleration, by speed
        "accel": table(accel, 0.75),
        "coast": table(coast, 0.5, 3),
        # braking and lateral grip as base + perV2·v² (m/s²), fitted to the measurements
        "brake": fit_v2(brake_rows, 40, 100),
        "lateralGrip": fit_v2(grip_rows, 20, 70),
        "measured": {"brake": brake_rows, "lateralGrip": grip_rows},
        "realLapSeconds": best[0]["lap_duration"],
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    print(data["source"])
    print(f"max RPM {data['maxRpm']} · upshift {data['upshiftRpm']} · downshift {data['downshiftRpm']} · top {data['topSpeed'] * 3.6:.0f} km/h")
    print("gears (km/h at 10,000 rpm):", [round(r * 10000) for r in data["gearKmhPerRpm"]])
    for name in ("accel", "coast"):
        print(f"{name:12}", " ".join(f"{v * 3.6:.0f}:{a / 9.81:.1f}g" for v, a in data[name]))
    for name in ("brake", "lateralGrip"):
        m = data[name]
        print(f"{name:12}", " ".join(f"{k}:{(m['base'] + m['perV2'] * (k / 3.6) ** 2) / 9.81:.1f}g" for k in (100, 200, 300)))


if __name__ == "__main__":
    circuit, year, out = sys.argv[1:4]
    main(circuit, int(year), Path(out))
