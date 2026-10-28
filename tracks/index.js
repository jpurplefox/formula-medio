// Definición de circuitos.
// Las coordenadas (start, towards) están en píxeles de la imagen original.
//   image      → imagen del trazado: línea oscura sobre fondo claro
//   scale      → cuántos píxeles de la imagen forman una celda del mapa
//   threshold  → luminancia (0-255) por debajo de la cual un píxel es pista
//   widen      → celdas extra para ensanchar la pista
//   runoff     → celdas de pasto entre la pista y los muros
//   start      → un punto sobre la línea de largada
//   towards    → un punto hacia donde se corre desde la largada
//   elevation  → (opcional) perfil de alturas generado con tools/elevation.py
//   elevationScale → (opcional) exagera o suaviza las alturas; 1 = pendientes reales
//   widthMeters → (opcional) ancho de la pista en metros; si no, el del dibujo
//   lengthMeters → (opcional) largo de la vuelta en metros, si no hay perfil de alturas (que ya lo trae)
export const TRACKS = [
  {
    id: 'interlagos',
    name: 'Interlagos',
    image: 'tracks/interlagos.webp',
    elevation: 'tracks/interlagos.elevation.json',
    elevationScale: 1,
    widthMeters: 15,
    scale: 3,
    threshold: 90,
    widen: 1,
    runoff: 3,
    start: { x: 707, y: 335 },
    towards: { x: 600, y: 397 },
  },
];
