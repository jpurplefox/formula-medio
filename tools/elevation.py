"""Extrae el perfil de alturas de un circuito a partir de la telemetría de F1.

Usa la API abierta de OpenF1 (https://openf1.org), que tiene las posiciones X, Y, Z de los autos.
Promedia las vueltas más rápidas de una carrera y guarda la altura en función de la fracción
de vuelta (0 = línea de largada, 1 = vuelta completa). Sólo usa la biblioteca estándar.

Uso:
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
            # 429: pedimos demasiado rápido; esperamos cada vez más y reintentamos
            if e.code != 429 or attempt == 5:
                raise
            time.sleep(5 * 2**attempt)
    time.sleep(0.4)  # respetamos el límite de pedidos de la API
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
    # OpenF1 da las posiciones en décimas de metro
    xs = [p["x"] / 10 for p in points]
    ys = [p["y"] / 10 for p in points]
    zs = [p["z"] / 10 for p in points]
    dist = [0.0]
    for i in range(1, len(points)):
        dist.append(dist[-1] + ((xs[i] - xs[i - 1]) ** 2 + (ys[i] - ys[i - 1]) ** 2) ** 0.5)
    length = dist[-1]
    # La vuelta es cerrada: repartimos el pequeño error de cierre a lo largo de la vuelta
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
        sys.exit(f"No encontré la carrera de {year} en {circuit}")
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
        print(f"  auto {lap['driver_number']:>2} vuelta {lap['lap_number']:>2}: {lap['lap_duration']:.3f}s, {length:.0f} m")

    heights = [sum(p[k] for p in profiles) / len(profiles) for k in range(SAMPLES)]
    low = min(heights)
    heights = [h - low for h in heights]

    data = {
        "source": f"OpenF1 · carrera {year} en {circuit} · promedio de las {len(best)} vueltas más rápidas",
        "lapLengthMeters": round(sum(lengths) / len(lengths), 1),
        "heightsMeters": [round(h, 2) for h in heights],
    }
    out.write_text(json.dumps(data, ensure_ascii=False))
    print(data["source"])
    print(f"Largo de vuelta: {data['lapLengthMeters']:.0f} m · desnivel: {max(heights):.1f} m")


if __name__ == "__main__":
    circuit, year, out = sys.argv[1:4]
    main(circuit, int(year), Path(out))
