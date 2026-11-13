// Lo que necesita el navegador para armar un circuito desde una imagen: cargarla y reducirla a una máscara de
// píxeles oscuros (imageMask). El resto (buildTrackFromMask, en track.js) corre también en Node.
import { buildTrackFromMask } from '../sim/track.js';

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    img.src = src;
  });
}

// elevation (opcional): perfil de alturas generado por tools/elevation.py
export function buildTrack(img, def, elevation = null) {
  return buildTrackFromMask(imageMask(img, def), def, elevation);
}

// Píxeles oscuros de la imagen reducida (1 = puede ser pista): la única parte que necesita el navegador
export function imageMask(img, def) {
  const scale = def.scale ?? 3;
  const W = Math.ceil(img.width / scale);
  const H = Math.ceil(img.height / scale);
  const threshold = def.threshold ?? 90;
  // Reducimos la imagen: cada píxel resultante es el promedio de scale×scale píxeles
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, W, H);
  // retoques a mano, en píxeles de la imagen: `paint` repasa en negro tramos de pista que el dibujo tapa
  // (p. ej. con la bandera a cuadros): [[x0, y0, x1, y1, ancho], ...]
  ctx.save();
  ctx.scale(W / img.width, H / img.height);
  ctx.strokeStyle = '#000';
  ctx.lineCap = 'round';
  for (const [x0, y0, x1, y1, width] of def.paint ?? []) {
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  ctx.restore();
  const px = ctx.getImageData(0, 0, W, H).data;

  const road = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const lum = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    road[i] = lum < threshold ? 1 : 0;
  }
  return { W, H, road };
}
