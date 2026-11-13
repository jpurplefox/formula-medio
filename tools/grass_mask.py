#!/usr/bin/env python3
"""Genera textures/grass-mask.png: blanco = césped, negro = tierra.

La imagen se repite sobre todo el pasto del circuito (GRASS_MASK_CELLS celdas por lado, ver renderer.js), así que
el ruido se arma con FFT: sale periódico y los bordes empalman. Se puede editar a mano con cualquier programa de
dibujo; el juego sólo mira el canal rojo (más oscuro = más tierra).

Uso: python3 tools/grass_mask.py [--size 512] [--dirt 0.07] [--seed 7] [--min-px 60]
"""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage


def periodic_noise(size, rng, lo, hi, beta):
    """Ruido que se repite cada `size` píxeles, con frecuencias entre lo y hi (ciclos por imagen)."""
    f = np.fft.fftfreq(size) * size
    fx, fy = np.meshgrid(f, f)
    r = np.hypot(fx, fy)
    amp = np.where((r >= lo) & (r <= hi), 1.0 / np.maximum(r, 1.0) ** beta, 0.0)
    spec = np.fft.fft2(rng.standard_normal((size, size))) * amp
    n = np.real(np.fft.ifft2(spec))
    return (n - n.mean()) / n.std()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--size', type=int, default=512)
    ap.add_argument('--dirt', type=float, default=0.07, help='fracción de la imagen que es tierra')
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--min-px', type=int, default=60, help='manchas más chicas que esto se borran')
    ap.add_argument('--out', default=str(Path(__file__).resolve().parent.parent / 'textures' / 'grass-mask.png'))
    a = ap.parse_args()
    rng = np.random.default_rng(a.seed)
    # manchas medianas (calvas de unos metros) con bordes irregulares (frecuencias altas) y algunas zonas más
    # gastadas (frecuencias bajas) donde se juntan varias
    n = (periodic_noise(a.size, rng, 10, 40, 1.0)
         + 0.3 * periodic_noise(a.size, rng, 40, a.size / 4, 0.6)
         + 0.6 * periodic_noise(a.size, rng, 2, 8, 0.5))
    # sin puntitos sueltos (de lejos titilan): se borran las manchas de menos de --min-px píxeles, contando las
    # que cruzan el borde de la imagen como una sola (se repite); el umbral se ajusta para que quede --dirt de tierra
    def dirt_at(cut):
        d = n > cut
        tiled = np.tile(d, (3, 3))
        lab, k = ndimage.label(tiled)
        sizes = np.bincount(lab.ravel(), minlength=k + 1)
        keep = sizes >= a.min_px
        keep[0] = False
        return keep[lab][a.size:2 * a.size, a.size:2 * a.size]
    lo, hi = np.quantile(n, 1 - 3 * a.dirt), np.quantile(n, 1 - a.dirt)
    for _ in range(30):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if dirt_at(mid).mean() > a.dirt else (lo, mid)
    img = np.where(dirt_at(lo), 0, 255).astype(np.uint8)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(img, 'L').save(a.out, optimize=True)
    print(f'{a.out}: {a.size}x{a.size}, tierra {np.mean(img == 0):.1%}')


if __name__ == '__main__':
    main()
