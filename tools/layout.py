"""Builds a track layout from F1 telemetry: centerline, lap length and heights.

Uses the open OpenF1 API (https://openf1.org), which has the X, Y, Z positions of the cars about 4 times per
second. Careful: these are not GPS positions. The timing system places each car by how far it has gone around the
lap, on the official track drawing, so every car follows the same line (just ±0.4 m across 1,300 laps by all
drivers at Montreal). That gives neither the edges nor the width, but it does give the track's shape, smooth and in
real meters: much better than extracting the centerline from an image.

Collects every lap by every driver in practice and qualifying, except pit in and pit out laps (so the pit lane does
not show up).
  1. A reference line: a lap of typical length, smoothed.
  2. Each position is projected onto the reference; for each segment the median of the measurements is taken (so a
     few distant positions, such as those in the pit lane, do not shift it) and the reference is moved there. This
     is repeated three times, and the segments nobody drove through are removed (a jump in the positions of the
     reference lap).
  3. It is smoothed and resampled every CELL meters, from the start line (where laps begin) in the racing
     direction.

Saves tracks/<id>.layout.json: centerline points (m, with y pointing down as in an image), lap length and the
height at each point. Downloads stay in tools/.cache/ so they are not requested again. Uses only the standard
library.

Usage:
    python3 tools/layout.py Montreal 2025 tracks/montreal.layout.json
"""

import bisect
import http.client
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

API = "https://api.openf1.org/v1"
CACHE = Path(__file__).parent / ".cache"
SESSIONS = ("Practice 1", "Practice 2", "Practice 3", "Sprint Qualifying", "Qualifying")
CELL = 2.0  # m between centerline points (one map cell)
BIN = 4.0  # m of track per segment when measuring the edges
EDGE = 0.02  # percentile of each edge (discards track excursions and position noise)
MAX_SIDE = 30.0  # m: farther from the reference is not this track (pit lane, another nearby section)
SMOOTH_CENTER = 40.0  # m: window to smooth the center offset and the width along the track
SMOOTH_LINE = 12.0  # m: window to smooth the final line (removes noise without rounding off the corners)


def get(endpoint: str, **params: object) -> list[dict]:
    query = urllib.parse.urlencode(params, safe="<>=")
    key = CACHE / f"{endpoint}_{urllib.parse.quote(query, safe='')}.json"
    if key.exists():
        return json.loads(key.read_text())
    for attempt in range(6):
        try:
            with urllib.request.urlopen(f"{API}/{endpoint}?{query}", timeout=120) as r:
                data = json.load(r)
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:  # this is how OpenF1 answers when there are no results
                data = []
                break
            # 429: we asked too fast; wait longer each time and retry
            if e.code != 429 or attempt == 5:
                sys.exit(f"OpenF1 answered {e.code}: {e.read().decode(errors='replace')[:300]}")
            time.sleep(5 * 2**attempt)
        except (http.client.IncompleteRead, urllib.error.URLError, TimeoutError):
            # the connection dropped halfway: request it again
            if attempt == 5:
                raise
            time.sleep(5)
    time.sleep(0.4)  # respect the API's request limit
    if not isinstance(data, list):
        sys.exit(f"OpenF1 answered: {data}")
    CACHE.mkdir(exist_ok=True)
    key.write_text(json.dumps(data))
    return data


def when(s: str) -> float:
    return datetime.fromisoformat(s).timestamp()


def valid_laps(laps: list[dict]) -> list[tuple[float, float]]:
    """(start, end) intervals of the laps on track: without the pit out lap or the one that ends in the pits."""
    laps = sorted((l for l in laps if l.get("date_start")), key=lambda l: l["lap_number"])
    out = []
    for i, lap in enumerate(laps):
        if lap.get("is_pit_out_lap") or not lap.get("lap_duration"):
            continue
        nxt = laps[i + 1] if i + 1 < len(laps) else None
        if nxt is None or nxt.get("is_pit_out_lap"):
            continue  # the last lap of each run ends in the pits
        start = when(lap["date_start"])
        out.append((start, start + lap["lap_duration"]))
    return out


def session_points(session_key: int) -> tuple[list[tuple[float, float, float]], list[list[tuple[float, float]]], list[tuple[float, float]]]:
    """Positions (x, y, z in m) of all valid laps, the laps as polylines, and where each one started."""
    points, laps_xy, starts = [], [], []
    drivers = sorted({d["driver_number"] for d in get("drivers", session_key=session_key)})
    for number in drivers:
        intervals = valid_laps(get("laps", session_key=session_key, driver_number=number))
        if not intervals:
            continue
        loc = get("location", session_key=session_key, driver_number=number)
        times = [when(p["date"]) for p in loc]
        print(f"    car {number:>2}: {len(intervals)} laps, {len(loc)} positions")
        for a, b in intervals:
            i, j = bisect.bisect_left(times, a), bisect.bisect_right(times, b)
            lap = [(p["x"] / 10, p["y"] / 10, p["z"] / 10) for p in loc[i:j]]
            # standing still on track (red flag, stuck API feed) adds nothing: drop the repeated points
            lap = [p for k, p in enumerate(lap) if k == 0 or p[:2] != lap[k - 1][:2]]
            if len(lap) < 20:
                continue
            points.extend(lap)
            laps_xy.append([(x, y) for x, y, _ in lap])
            # the start: interpolated between the two positions around the beginning of the lap
            if 0 < i < len(loc):
                t0, t1 = times[i - 1], times[i]
                f = (a - t0) / max(1e-9, t1 - t0)
                p0, p1 = loc[i - 1], loc[i]
                starts.append(((p0["x"] + (p1["x"] - p0["x"]) * f) / 10, (p0["y"] + (p1["y"] - p0["y"]) * f) / 10))
    return points, laps_xy, starts


def resample(xy: list[tuple[float, float]], step: float, closed: bool = True) -> list[tuple[float, float]]:
    pts = xy + [xy[0]] if closed else xy
    d = [0.0]
    for i in range(1, len(pts)):
        d.append(d[-1] + math.dist(pts[i], pts[i - 1]))
    n = max(8, round(d[-1] / step))
    out, j = [], 0
    for k in range(n):
        target = d[-1] * k / n
        while j < len(d) - 2 and d[j + 1] < target:
            j += 1
        t = (target - d[j]) / max(1e-9, d[j + 1] - d[j])
        out.append((pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t))
    return out


def smooth(values: list, window: int) -> list:
    """Circular moving average (works for numbers and for points)."""
    n, half = len(values), max(1, window // 2)
    if isinstance(values[0], tuple):
        cols = [smooth([v[c] for v in values], window) for c in range(len(values[0]))]
        return list(zip(*cols))
    pre = [0.0]
    ext = values[-half:] + values + values[:half]
    for v in ext:
        pre.append(pre[-1] + v)
    return [(pre[i + 2 * half + 1] - pre[i]) / (2 * half + 1) for i in range(n)]


class Projector:
    """Projects points onto a closed line: distance from the first point and offset (+ to the left)."""

    def __init__(self, line: list[tuple[float, float]], reach: float):
        self.line, self.n = line, len(line)
        self.s = [0.0]
        for i in range(1, self.n + 1):
            self.s.append(self.s[-1] + math.dist(line[i % self.n], line[i - 1]))
        self.size = reach
        self.grid: dict[tuple[int, int], list[int]] = {}
        for i in range(self.n):
            (ax, ay), (bx, by) = line[i], line[(i + 1) % self.n]
            for gx in range(int((min(ax, bx) - reach) // reach), int((max(ax, bx) + reach) // reach) + 1):
                for gy in range(int((min(ay, by) - reach) // reach), int((max(ay, by) + reach) // reach) + 1):
                    self.grid.setdefault((gx, gy), []).append(i)

    def project(self, x: float, y: float) -> tuple[float, float, float] | None:
        best = None
        for i in self.grid.get((int(x // self.size), int(y // self.size)), ()):
            (ax, ay), (bx, by) = self.line[i], self.line[(i + 1) % self.n]
            ex, ey = bx - ax, by - ay
            l2 = ex * ex + ey * ey or 1e-9
            t = max(0.0, min(1.0, ((x - ax) * ex + (y - ay) * ey) / l2))
            dx, dy = x - ax - ex * t, y - ay - ey * t
            d2 = dx * dx + dy * dy
            if best is None or d2 < best[0]:
                side = (ex * (y - ay) - ey * (x - ax)) / math.sqrt(l2)
                best = (d2, self.s[i] + t * math.sqrt(l2), side)
        if best is None or best[0] > MAX_SIDE**2:
            return None
        return best[1], best[2], math.sqrt(best[0])


def percentile(sorted_values: list[float], q: float) -> float:
    k = q * (len(sorted_values) - 1)
    i = int(k)
    return sorted_values[i] + (sorted_values[min(i + 1, len(sorted_values) - 1)] - sorted_values[i]) * (k - i)


def normals(line: list[tuple[float, float]]) -> list[tuple[float, float]]:
    n, out = len(line), []
    for i in range(n):
        (ax, ay), (bx, by) = line[i - 1], line[(i + 1) % n]
        l = math.hypot(bx - ax, by - ay) or 1
        out.append((-(by - ay) / l, (bx - ax) / l))  # to the left of the racing direction
    return out


def fill(arr: list) -> list:
    """Segments with no data take the value of the next one that has it."""
    return [v if v is not None else next(arr[(k + j) % len(arr)] for j in range(1, len(arr)) if arr[(k + j) % len(arr)] is not None)
            for k, v in enumerate(arr)]


def at(per_bin: list[float], s: float, total: float) -> float:
    return per_bin[min(len(per_bin) - 1, int(s / total * len(per_bin)))]


def measure(line: list[tuple[float, float]], points: list[tuple[float, float, float]]):
    """Per BIN-meter segment along the line: center offset, spread, height and number of positions."""
    proj = Projector(line, MAX_SIDE)
    total = proj.s[-1]
    nb = max(1, int(total // BIN))
    sides, zs = [[] for _ in range(nb)], [[] for _ in range(nb)]
    for x, y, z in points:
        r = proj.project(x, y)
        if r:
            k = min(nb - 1, int(r[0] / total * nb))
            sides[k].append(r[1])
            if r[2] < 8:
                zs[k].append(z)
    lo, hi, mid, zm = [], [], [], []
    for b, z in zip(sides, zs):
        b.sort()
        z.sort()
        enough = len(b) >= 20
        lo.append(percentile(b, EDGE) if enough else None)
        hi.append(percentile(b, 1 - EDGE) if enough else None)
        # the center is the median: a few distant positions (the pit lane beside the straight) do not shift it
        mid.append(percentile(b, 0.5) if enough else None)
        zm.append(z[len(z) // 2] if z else None)
    lo, hi, mid, zm = fill(lo), fill(hi), fill(mid), fill(zm)
    w = round(SMOOTH_CENTER / BIN)
    center = smooth(mid, w)
    width = smooth([b - a for a, b in zip(lo, hi)], w)
    return proj, center, width, zm, [len(b) for b in sides]


def main(circuit: str, year: int, out: Path) -> None:
    sessions = [s for s in get("sessions", circuit_short_name=circuit, year=year) if s["session_name"] in SESSIONS]
    if not sessions:
        sys.exit(f"Could not find {year} practice or qualifying at {circuit}")
    points, laps_xy, starts = [], [], []
    for s in sessions:
        print(f"  {s['session_name']} ({s['date_start'][:10]})")
        p, l, st = session_points(s["session_key"])
        points += p
        laps_xy += l
        starts += st
    print(f"  {len(laps_xy)} laps, {len(points)} positions")

    # 1) reference: a lap of typical length (one with a jump in the positions would measure too long)
    def lap_len(lap):
        return sum(math.dist(lap[i], lap[i - 1]) for i in range(1, len(lap)))
    full = [l for l in laps_xy if len(l) > 150]
    lengths = sorted(lap_len(l) for l in full)
    typical = lengths[len(lengths) // 2]
    ref_lap = min(full, key=lambda l: abs(lap_len(l) - typical))
    line = smooth(resample(ref_lap, CELL), round(SMOOTH_LINE / CELL))

    # 2) edges per segment and the line in the middle, three times (each pass starts closer to the center)
    for it in range(3):
        proj, center, width, _, count = measure(line, points)
        nrm, total = normals(line), proj.s[-1]
        # drop the segments nobody drove through (a detour the reference had)
        moved = [(x + nrm[i][0] * at(center, proj.s[i], total), y + nrm[i][1] * at(center, proj.s[i], total))
                 for i, (x, y) in enumerate(line) if at(count, proj.s[i], total) >= 20]
        line = smooth(resample(moved, CELL), round(SMOOTH_LINE / CELL))
        shift = sum(abs(c) for c in center) / len(center)
        print(f"  pass {it + 1}: the line moved {shift:.2f} m on average · spread {sorted(width)[len(width) // 2]:.1f} m")

    # 3) the start line: where laps begin; from there, in the racing direction
    proj = Projector(line, MAX_SIDE)
    total = proj.s[-1]
    s0 = sorted(r[0] for r in (proj.project(x, y) for x, y in starts) if r)
    # circular median: centered around the first value so the start is not split in two (near s = 0)
    a = s0[len(s0) // 2]
    s0 = sorted(((v - a + total / 2) % total) - total / 2 for v in s0)
    start = (a + s0[len(s0) // 2]) % total
    k0 = min(range(len(line)), key=lambda i: abs(((proj.s[i] - start + total / 2) % total) - total / 2))
    line = line[k0:] + line[:k0]
    # the direction: that of the laps (the reference already has it, but it is checked against one lap's progress)
    proj = Projector(line, MAX_SIDE)
    ss = [r[0] for r in (proj.project(x, y) for x, y in ref_lap[: len(ref_lap) // 4]) if r]
    if sum(1 for i in range(1, len(ss)) if 0 < (ss[i] - ss[i - 1]) % proj.s[-1] < proj.s[-1] / 2) < len(ss) / 2:
        line = [line[0]] + line[1:][::-1]

    # 4) on the final line: the height at each point
    proj, _, _, zs, _ = measure(line, points)
    total = proj.s[-1]
    heights = smooth([at(zs, proj.s[i], total) for i in range(len(line))], round(30 / CELL))
    low = min(heights)

    # the map with y pointing down, like images (otherwise the track comes out mirrored)
    x0, y1 = min(x for x, _ in line), max(y for _, y in line)
    data = {
        "source": f"OpenF1 · {year} practice and qualifying at {circuit} · {len(laps_xy)} laps by all drivers",
        "lapLengthMeters": round(total, 1),
        "points": [[round(x - x0, 2), round(y1 - y, 2)] for x, y in line],
        "heightsMeters": [round(h - low, 2) for h in heights],
    }
    out.write_text(json.dumps(data, ensure_ascii=False))
    print(data["source"])
    print(f"Lap length: {total:.0f} m · elevation change: {max(heights) - low:.1f} m · {len(line)} points")


if __name__ == "__main__":
    circuit, year, out = sys.argv[1:4]
    main(circuit, int(year), Path(out))
