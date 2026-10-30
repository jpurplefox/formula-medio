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
//   open       → (opcional) borra las líneas de menos de 2·open+1 celdas de ancho pegadas al trazado
//                (calle de boxes, variantes viejas, mástil de la bandera)
//   paint      → (opcional) tramos a repasar en negro, en píxeles de la imagen: [[x0, y0, x1, y1, ancho], ...]
//                (donde la bandera a cuadros corta la pista; un tramo de largo 0 es un punto)
//   smooth     → (opcional) pasadas de suavizado de la línea central; más en imágenes chicas, donde las
//                líneas quedan escalonadas y el auto frenaría en las rectas (por defecto 3)
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
  {
    id: 'monza',
    name: 'Monza',
    image: 'tracks/monza.webp',
    widthMeters: 14,
    elevation: 'tracks/monza.elevation.json',
    scale: 2, // más fino que Interlagos: con 3 las chicanas quedan muy suavizadas
    threshold: 90,
    widen: 1,
    runoff: 3,
    start: { x: 1220, y: 892 },
    towards: { x: 1100, y: 893 },
  },
  {
    id: 'albertpark',
    name: 'Albert Park',
    image: 'tracks/Australia.webp',
    widthMeters: 14,
    elevation: 'tracks/albertpark.elevation.json',
    scale: 4, // la imagen es casi el doble de grande que las otras
    threshold: 90,
    widen: 1,
    runoff: 3,
    start: { x: 2113, y: 1716 },
    towards: { x: 1890, y: 1716 },
  },
  {
    id: 'barcelona',
    name: 'Barcelona',
    image: 'tracks/barcelona.png',
    widthMeters: 14,
    elevation: 'tracks/barcelona.elevation.json',
    scale: 3,
    threshold: 90,
    widen: 1,
    runoff: 3,
    open: 1, // el mástil de la bandera toca la pista
    start: { x: 1555, y: 670 },
    towards: { x: 1476, y: 794 },
  },
  {
    id: 'montreal',
    name: 'Montreal',
    image: 'tracks/canada.jpeg',
    widthMeters: 12,
    elevation: 'tracks/montreal.elevation.json',
    scale: 0.4, // imagen chica: se agranda (con 0,5 la calle de boxes queda pegada a la recta)
    threshold: 100,
    widen: 1,
    runoff: 3,
    open: 4, // la calle de boxes, más finita, va pegada a la recta
    start: { x: 93, y: 179 },
    towards: { x: 60, y: 176 },
  },
  {
    id: 'spa',
    name: 'Spa',
    image: 'tracks/spa.png',
    widthMeters: 13,
    elevation: 'tracks/spa.elevation.json',
    scale: 0.6, // imagen chica: se agranda
    threshold: 90,
    widen: 1,
    runoff: 3,
    open: 2, // la calle de boxes va pegada a la recta
    paint: [[150, 351, 100, 408, 8]], // la bandera a cuadros corta la pista
    start: { x: 107, y: 400 },
    towards: { x: 88, y: 420 },
  },
  {
    id: 'silverstone',
    name: 'Silverstone',
    image: 'tracks/silverstone.svg',
    widthMeters: 15,
    elevation: 'tracks/silverstone.elevation.json',
    scale: 0.75,
    threshold: 90,
    widen: 1,
    runoff: 3,
    open: 3, // las líneas finas son variantes viejas del circuito
    paint: [[440, 457, 505, 531, 10]], // la bandera a cuadros corta la pista
    start: { x: 470, y: 490 },
    towards: { x: 450, y: 467 },
  },
  {
    id: 'redbullring',
    name: 'Red Bull Ring',
    image: 'tracks/austria.png',
    widthMeters: 13,
    elevation: 'tracks/redbullring.elevation.json',
    scale: 0.4, // imagen chica: se agranda
    threshold: 80, // las flechas rojas no son pista
    widen: 1,
    runoff: 3,
    open: 4, // la calle de boxes va pegada a la recta
    smooth: 25,
    paint: [
      [385, 284.5, 315, 302.5, 5], // la bandera a cuadros corta la pista
      // el dibujo marca cada curva con un punto blanco sobre la pista: se tapan
      [219, 327, 219.1, 327, 8],
      [48, 61, 48.1, 61, 8],
      [316, 86, 316.1, 86, 8],
      [171, 133, 171.1, 133, 8],
      [212, 222, 212.1, 222, 8],
      [262, 185, 262.1, 185, 8],
      [448, 186, 448.1, 186, 8],
      [466, 252, 466.1, 252, 8],
    ],
    start: { x: 320, y: 302 },
    towards: { x: 290, y: 309 },
  },
];
