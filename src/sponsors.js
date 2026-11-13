// Carteles de sponsors (inventados) que van sobre las barreras de bloques del costado de la pista (ver wallFace en
// glrenderer.js). Se dibujan una vez al arrancar, todos en una misma imagen: un cartel por fila.

export const SPONSORS = [
  { name: 'YERBA TURBO', bg: '#1f7a3a', fg: '#ffffff', accent: '#f2d53c' },
  { name: 'PAMPA NEUMÁTICOS', bg: '#141414', fg: '#ffd400', accent: '#ffd400' },
  { name: 'ALFAJOR GP', bg: '#1d2f6e', fg: '#ffffff', accent: '#e8b04a' },
  { name: 'TANGO TELECOM', bg: '#c4122f', fg: '#ffffff', accent: '#141414' },
  { name: 'DULCE MAX', bg: '#f08a24', fg: '#4a2410', accent: '#ffffff' },
  { name: 'MATE ENERGÍA', bg: '#f4f4f4', fg: '#127a6a', accent: '#127a6a' },
  { name: 'ÑANDÚ SEGUROS', bg: '#0b6fb8', fg: '#ffffff', accent: '#ffffff' },
  { name: 'ASADO RACING', bg: '#5a1a12', fg: '#ffcf8a', accent: '#ff7a1a' },
];

export const BANNER_W = 512,
  BANNER_H = 64;

// la imagen con todos los carteles, uno debajo del otro
export function sponsorBanners() {
  const c = document.createElement('canvas');
  c.width = BANNER_W;
  c.height = BANNER_H * SPONSORS.length;
  const g = c.getContext('2d');
  SPONSORS.forEach((s, i) => {
    const y = i * BANNER_H;
    g.fillStyle = s.bg;
    g.fillRect(0, y, BANNER_W, BANNER_H);
    // dos franjas finas arriba y abajo, y un rombo de cada lado del nombre
    g.fillStyle = s.accent;
    g.fillRect(0, y + 4, BANNER_W, 3);
    g.fillRect(0, y + BANNER_H - 7, BANNER_W, 3);
    g.font = 'bold 38px Arial, Helvetica, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const w = Math.min(BANNER_W - 90, g.measureText(s.name).width);
    for (const side of [-1, 1]) {
      const cx = BANNER_W / 2 + side * (w / 2 + 26),
        cy = y + BANNER_H / 2;
      g.beginPath();
      g.moveTo(cx, cy - 11);
      g.lineTo(cx + 11, cy);
      g.lineTo(cx, cy + 11);
      g.lineTo(cx - 11, cy);
      g.closePath();
      g.fill();
    }
    g.fillStyle = s.fg;
    g.fillText(s.name, BANNER_W / 2, y + BANNER_H / 2 + 2, BANNER_W - 90);
  });
  return c;
}
