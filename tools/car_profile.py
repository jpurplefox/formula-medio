"""Arma el perfil de un auto de F1 a partir de la telemetría de OpenF1 (https://openf1.org).

Toma las vueltas más rápidas de una carrera y, con la velocidad, las RPM, la marcha, el acelerador,
el freno y la posición de los autos, calcula:
  - la relación de cada marcha (km/h por cada rpm) y las RPM máximas y de cambio,
  - cuánto acelera el auto a fondo y cuánto frena, según la velocidad,
  - cuánto desacelera al soltar todo (resistencia del aire y freno motor),
  - cuánto agarre lateral tiene según la velocidad (con la curvatura de la trayectoria).
Sólo usa la biblioteca estándar.

Uso:
    python3 tools/car_profile.py Interlagos 2023 cars/f1-2023.json
"""

import json
import math
import statistics
import sys
import time
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
            time.sleep(0.4)  # respetamos el límite de pedidos de la API
            return data
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("OpenF1 no respondió (demasiados pedidos)")


def seconds(date: str) -> float:
    return datetime.fromisoformat(date).timestamp()


def percentile(values: list[float], p: float) -> float:
    values = sorted(values)
    k = (len(values) - 1) * p
    lo = math.floor(k)
    hi = min(lo + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (k - lo)


def table(samples: list[tuple[float, float]], p: float, min_count: int = 6) -> list[list[float]]:
    """Agrupa (velocidad km/h, valor) por franjas de velocidad y devuelve [velocidad m/s, percentil p]."""
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
    """Ajusta a + b·v² (cuadrados mínimos) a las filas [v, a] con vmin ≤ v ≤ vmax.
    Es la forma física de la carga aerodinámica: más velocidad, más apoyo, más agarre y más frenada."""
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
    """Aceleración lateral v²·curvatura, con la curvatura del círculo que pasa por 3 posiciones."""
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
        # velocidad en ese instante (la telemetría del auto tiene otra frecuencia)
        t = seconds(b["date"])
        j = min(range(len(ct)), key=lambda k: abs(ct[k] - t))
        kmh = car[j]["speed"]
        v = kmh / 3.6
        out.append((kmh, v * v / radius))
    return out


def main(circuit: str, year: int, out: Path) -> None:
    sessions = get("sessions", circuit_short_name=circuit, session_name="Race", year=year)
    if not sessions:
        sys.exit(f"No encontré la carrera de {year} en {circuit}")
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
        print(f"  auto {lap['driver_number']:>2} vuelta {lap['lap_number']:>2}: {lap['lap_duration']:.3f}s, {len(car)} muestras")
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

    # relación de cada marcha; las que casi no se usan a fondo se estiman siguiendo la progresión
    known = {g: statistics.median(r) for g, r in ratios.items() if len(r) >= 10}
    top = max(known)
    for g in range(top - 1, 0, -1):
        if g not in known:
            known[g] = known[g + 1] * known[g + 1] / known[g + 2]
    brake_rows = table(brake, 0.9)
    grip_rows = table(lateral, 0.9)
    data = {
        "source": f"OpenF1 · carrera {year} en {circuit} · {len(best)} vueltas más rápidas",
        "maxRpm": round(percentile(rpms, 0.995)),
        "upshiftRpm": round(statistics.median(upshift)),
        "downshiftRpm": round(statistics.median(downshift)),
        "topSpeed": round(max(speeds) / 3.6, 1),
        # km/h por rpm de cada marcha, de 1ª en adelante (las que no aparecían a fondo, estimadas)
        "gearKmhPerRpm": [round(known[g], 5) for g in range(1, top + 1)],
        "estimatedGears": [g for g in range(1, top + 1) if g not in ratios or len(ratios[g]) < 10],
        # [velocidad m/s, m/s²]: aceleración a fondo y desaceleración sin pedales, por velocidad
        "accel": table(accel, 0.75),
        "coast": table(coast, 0.5, 3),
        # frenada y agarre lateral como base + perV2·v² (m/s²), ajustados a lo medido
        "brake": fit_v2(brake_rows, 40, 100),
        "lateralGrip": fit_v2(grip_rows, 20, 70),
        "measured": {"brake": brake_rows, "lateralGrip": grip_rows},
        "realLapSeconds": best[0]["lap_duration"],
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    print(data["source"])
    print(f"RPM máx {data['maxRpm']} · cambio arriba {data['upshiftRpm']} · abajo {data['downshiftRpm']} · punta {data['topSpeed'] * 3.6:.0f} km/h")
    print("marchas (km/h a 10.000 rpm):", [round(r * 10000) for r in data["gearKmhPerRpm"]])
    for name in ("accel", "coast"):
        print(f"{name:12}", " ".join(f"{v * 3.6:.0f}:{a / 9.81:.1f}g" for v, a in data[name]))
    for name in ("brake", "lateralGrip"):
        m = data[name]
        print(f"{name:12}", " ".join(f"{k}:{(m['base'] + m['perV2'] * (k / 3.6) ** 2) / 9.81:.1f}g" for k in (100, 200, 300)))


if __name__ == "__main__":
    circuit, year, out = sys.argv[1:4]
    main(circuit, int(year), Path(out))
