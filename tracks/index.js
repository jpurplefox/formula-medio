// Definición de circuitos.
// Los de F1 salen de la telemetría (tools/layout.py): línea central en metros, alturas y largo de vuelta.
//   layout     → trazado generado con tools/layout.py
//   circuit    → nombre corto del circuito en OpenF1 (tools/layout.py, tools/lapcompare.js)
//   altitude   → metros sobre el nivel del mar: más arriba el aire es menos denso (menos apoyo y menos resistencia)
//   tune       → puesta a punto por defecto (src/dynamics.js): alerones de 1 a 10 y balance mecánico de -5 a 5,
//                como la llevan los equipos ahí (poco alerón donde importa la recta, mucho donde hay curvas)
//   rotate     → (opcional) grados para girar el trazado (la telemetría viene en otra orientación que los dibujos)
//   widthMeters → ancho de la pista en metros
//   runoff     → celdas de pasto entre la pista y los muros
//   elevationScale → (opcional) exagera o suaviza las alturas; 1 = pendientes reales
// Un circuito propio (o uno sin telemetría) sale de una imagen; las coordenadas (start, towards) están en píxeles
// de la imagen original.
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
    circuit: 'Interlagos',
    altitude: 785,
    tune: { front: 6, rear: 6, balance: 0 },
    layout: 'tracks/interlagos.layout.json',
    rotate: 76,
    widthMeters: 15,
    runoff: 3,
  },
  {
    id: 'monza',
    name: 'Monza',
    circuit: 'Monza',
    altitude: 160,
    tune: { front: 1, rear: 1, balance: 0 },
    layout: 'tracks/monza.layout.json',
    rotate: -87,
    widthMeters: 14,
    runoff: 3,
  },
  {
    id: 'albertpark',
    name: 'Albert Park',
    circuit: 'Melbourne',
    altitude: 10,
    tune: { front: 6, rear: 6, balance: 0 },
    layout: 'tracks/albertpark.layout.json',
    rotate: -48,
    widthMeters: 14,
    runoff: 3,
  },
  {
    id: 'barcelona',
    name: 'Barcelona',
    circuit: 'Catalunya',
    altitude: 110,
    tune: { front: 8, rear: 8, balance: 0 },
    layout: 'tracks/barcelona.layout.json',
    rotate: 5,
    widthMeters: 14,
    runoff: 3,
  },
  {
    id: 'montreal',
    name: 'Montreal',
    circuit: 'Montreal',
    altitude: 15,
    tune: { front: 4, rear: 4, balance: 0 },
    layout: 'tracks/montreal.layout.json',
    rotate: 102,
    widthMeters: 12,
    runoff: 3,
  },
  {
    id: 'spa',
    name: 'Spa',
    circuit: 'Spa-Francorchamps',
    altitude: 400,
    tune: { front: 3, rear: 3, balance: 0 },
    layout: 'tracks/spa.layout.json',
    rotate: -104,
    widthMeters: 13,
    runoff: 3,
  },
  {
    id: 'silverstone',
    name: 'Silverstone',
    circuit: 'Silverstone',
    altitude: 150,
    tune: { front: 5, rear: 5, balance: 0 },
    layout: 'tracks/silverstone.layout.json',
    rotate: -71,
    widthMeters: 15,
    runoff: 3,
  },
  {
    id: 'redbullring',
    name: 'Red Bull Ring',
    circuit: 'Spielberg',
    altitude: 680,
    tune: { front: 5, rear: 5, balance: 0 },
    layout: 'tracks/redbullring.layout.json',
    rotate: 9,
    widthMeters: 13,
    runoff: 3,
  },
];
