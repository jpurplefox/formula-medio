"""Arma el trazado de un circuito a partir de la telemetría de F1: línea central, largo de vuelta y alturas.

Usa la API abierta de OpenF1 (https://openf1.org), que tiene las posiciones X, Y, Z de los autos unas 4 veces por
segundo. Ojo: no son posiciones de GPS. El sistema de tiempos ubica a cada auto según cuánto avanzó en la vuelta,
sobre el dibujo oficial del circuito, así que todos pasan por la misma línea (apenas ±0,4 m entre 1.300 vueltas
de todos los pilotos en Montreal). De ahí no salen los bordes ni el ancho, pero sí la forma del circuito, suave y
en metros reales: mucho mejor que sacar la línea central de una imagen.

Junta todas las vueltas de todos los pilotos en las prácticas y la clasificación, sin las de entrada y salida de
boxes (así no aparece la calle de boxes).
  1. Una línea de referencia: una vuelta del largo típico, suavizada.
  2. Cada posición se proyecta sobre la referencia; por tramos se toma la mediana de lo medido (así unas pocas
     posiciones lejanas, como las de la calle de boxes, no la corren) y la referencia se corre ahí. Se repite tres veces y se sacan los tramos por donde no pasó nadie
     (un salto en las posiciones de la vuelta de referencia).
  3. Se suaviza y se vuelve a muestrear cada CELL metros, desde la línea de largada (donde empiezan las vueltas)
     en el sentido de carrera.

Guarda tracks/<id>.layout.json: puntos de la línea central (m, con y hacia abajo como en una imagen), largo de
vuelta y la altura en cada punto. Lo descargado queda en tools/.cache/ para no volver a pedirlo. Sólo usa la
biblioteca estándar.

Uso:
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
CELL = 2.0  # m entre puntos de la línea central (una celda del mapa)
BIN = 4.0  # m de pista por tramo al medir los bordes
EDGE = 0.02  # percentil de cada borde (descarta las salidas de pista y el ruido de la posición)
MAX_SIDE = 30.0  # m: más lejos de la referencia no es esta pista (calle de boxes, otro tramo cercano)
SMOOTH_CENTER = 40.0  # m: ventana para suavizar el corrimiento del centro y el ancho a lo largo de la pista
SMOOTH_LINE = 12.0  # m: ventana para suavizar la línea final (saca el ruido sin redondear las curvas)


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
            if e.code == 404:  # así contesta OpenF1 cuando no hay resultados
                data = []
                break
            # 429: pedimos demasiado rápido; esperamos cada vez más y reintentamos
            if e.code != 429 or attempt == 5:
                sys.exit(f"OpenF1 respondió {e.code}: {e.read().decode(errors='replace')[:300]}")
            time.sleep(5 * 2**attempt)
        except (http.client.IncompleteRead, urllib.error.URLError, TimeoutError):
            # la conexión se cortó a mitad de camino: se vuelve a pedir
            if attempt == 5:
                raise
            time.sleep(5)
    time.sleep(0.4)  # respetamos el límite de pedidos de la API
    if not isinstance(data, list):
        sys.exit(f"OpenF1 respondió: {data}")
    CACHE.mkdir(exist_ok=True)
    key.write_text(json.dumps(data))
    return data


def when(s: str) -> float:
    return datetime.fromisoformat(s).timestamp()


def valid_laps(laps: list[dict]) -> list[tuple[float, float]]:
    """Intervalos (inicio, fin) de las vueltas en pista: sin la de salida de boxes ni la que termina entrando."""
    laps = sorted((l for l in laps if l.get("date_start")), key=lambda l: l["lap_number"])
    out = []
    for i, lap in enumerate(laps):
        if lap.get("is_pit_out_lap") or not lap.get("lap_duration"):
            continue
        nxt = laps[i + 1] if i + 1 < len(laps) else None
        if nxt is None or nxt.get("is_pit_out_lap"):
            continue  # la última de cada tanda termina en boxes
        start = when(lap["date_start"])
        out.append((start, start + lap["lap_duration"]))
    return out


def session_points(session_key: int) -> tuple[list[tuple[float, float, float]], list[list[tuple[float, float]]], list[tuple[float, float]]]:
    """Posiciones (x, y, z en m) de todas las vueltas válidas, las vueltas como polilíneas y dónde empezó cada una."""
    points, laps_xy, starts = [], [], []
    drivers = sorted({d["driver_number"] for d in get("drivers", session_key=session_key)})
    for number in drivers:
        intervals = valid_laps(get("laps", session_key=session_key, driver_number=number))
        if not intervals:
            continue
        loc = get("location", session_key=session_key, driver_number=number)
        times = [when(p["date"]) for p in loc]
        print(f"    auto {number:>2}: {len(intervals)} vueltas, {len(loc)} posiciones")
        for a, b in intervals:
            i, j = bisect.bisect_left(times, a), bisect.bisect_right(times, b)
            lap = [(p["x"] / 10, p["y"] / 10, p["z"] / 10) for p in loc[i:j]]
            # quieto en pista (bandera roja, cámara de la API trabada) no aporta: fuera los puntos repetidos
            lap = [p for k, p in enumerate(lap) if k == 0 or p[:2] != lap[k - 1][:2]]
            if len(lap) < 20:
                continue
            points.extend(lap)
            laps_xy.append([(x, y) for x, y, _ in lap])
            # la largada: interpolada entre las dos posiciones de alrededor del comienzo de la vuelta
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
    """Promedio móvil circular (sirve para números y para puntos)."""
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
    """Proyecta puntos sobre una línea cerrada: distancia desde el primer punto y corrimiento (+ a la izquierda)."""

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
        out.append((-(by - ay) / l, (bx - ax) / l))  # hacia la izquierda del sentido de carrera
    return out


def fill(arr: list) -> list:
    """Los tramos sin datos toman el valor del siguiente que tenga."""
    return [v if v is not None else next(arr[(k + j) % len(arr)] for j in range(1, len(arr)) if arr[(k + j) % len(arr)] is not None)
            for k, v in enumerate(arr)]


def at(per_bin: list[float], s: float, total: float) -> float:
    return per_bin[min(len(per_bin) - 1, int(s / total * len(per_bin)))]


def measure(line: list[tuple[float, float]], points: list[tuple[float, float, float]]):
    """Por tramos de BIN metros sobre la línea: corrimiento del centro, dispersión, altura y cantidad de posiciones."""
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
        # el centro es la mediana: unas pocas posiciones lejanas (la calle de boxes al lado de la recta) no lo corren
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
        sys.exit(f"No encontré prácticas ni clasificación de {year} en {circuit}")
    points, laps_xy, starts = [], [], []
    for s in sessions:
        print(f"  {s['session_name']} ({s['date_start'][:10]})")
        p, l, st = session_points(s["session_key"])
        points += p
        laps_xy += l
        starts += st
    print(f"  {len(laps_xy)} vueltas, {len(points)} posiciones")

    # 1) referencia: una vuelta del largo típico (una con un salto en las posiciones mediría de más)
    def lap_len(lap):
        return sum(math.dist(lap[i], lap[i - 1]) for i in range(1, len(lap)))
    full = [l for l in laps_xy if len(l) > 150]
    lengths = sorted(lap_len(l) for l in full)
    typical = lengths[len(lengths) // 2]
    ref_lap = min(full, key=lambda l: abs(lap_len(l) - typical))
    line = smooth(resample(ref_lap, CELL), round(SMOOTH_LINE / CELL))

    # 2) bordes por tramo y la línea al medio, tres veces (cada una parte más cerca del centro)
    for it in range(3):
        proj, center, width, _, count = measure(line, points)
        nrm, total = normals(line), proj.s[-1]
        # fuera los tramos por donde no pasó nadie (un desvío que traía la referencia)
        moved = [(x + nrm[i][0] * at(center, proj.s[i], total), y + nrm[i][1] * at(center, proj.s[i], total))
                 for i, (x, y) in enumerate(line) if at(count, proj.s[i], total) >= 20]
        line = smooth(resample(moved, CELL), round(SMOOTH_LINE / CELL))
        shift = sum(abs(c) for c in center) / len(center)
        print(f"  pasada {it + 1}: la línea se movió {shift:.2f} m en promedio · dispersión {sorted(width)[len(width) // 2]:.1f} m")

    # 3) la línea de largada: donde empiezan las vueltas; desde ahí, en el sentido de carrera
    proj = Projector(line, MAX_SIDE)
    total = proj.s[-1]
    s0 = sorted(r[0] for r in (proj.project(x, y) for x, y in starts) if r)
    # mediana circular: se centra alrededor del primero para no partir la largada en dos (cerca de s = 0)
    a = s0[len(s0) // 2]
    s0 = sorted(((v - a + total / 2) % total) - total / 2 for v in s0)
    start = (a + s0[len(s0) // 2]) % total
    k0 = min(range(len(line)), key=lambda i: abs(((proj.s[i] - start + total / 2) % total) - total / 2))
    line = line[k0:] + line[:k0]
    # el sentido: el de las vueltas (la referencia ya lo trae, pero se verifica con el avance de una vuelta)
    proj = Projector(line, MAX_SIDE)
    ss = [r[0] for r in (proj.project(x, y) for x, y in ref_lap[: len(ref_lap) // 4]) if r]
    if sum(1 for i in range(1, len(ss)) if 0 < (ss[i] - ss[i - 1]) % proj.s[-1] < proj.s[-1] / 2) < len(ss) / 2:
        line = [line[0]] + line[1:][::-1]

    # 4) sobre la línea final: la altura en cada punto
    proj, _, _, zs, _ = measure(line, points)
    total = proj.s[-1]
    heights = smooth([at(zs, proj.s[i], total) for i in range(len(line))], round(30 / CELL))
    low = min(heights)

    # el mapa con y hacia abajo, como las imágenes (si no, el circuito queda espejado)
    x0, y1 = min(x for x, _ in line), max(y for _, y in line)
    data = {
        "source": f"OpenF1 · prácticas y clasificación {year} en {circuit} · {len(laps_xy)} vueltas de todos los pilotos",
        "lapLengthMeters": round(total, 1),
        "points": [[round(x - x0, 2), round(y1 - y, 2)] for x, y in line],
        "heightsMeters": [round(h - low, 2) for h in heights],
    }
    out.write_text(json.dumps(data, ensure_ascii=False))
    print(data["source"])
    print(f"Largo de vuelta: {total:.0f} m · desnivel: {max(heights) - low:.1f} m · {len(line)} puntos")


if __name__ == "__main__":
    circuit, year, out = sys.argv[1:4]
    main(circuit, int(year), Path(out))
