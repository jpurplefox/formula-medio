// Definición de circuitos.
// Los de F1 salen de la telemetría (tools/layout.py): línea central en metros, alturas y largo de vuelta.
//   layout     → trazado generado con tools/layout.py
//   circuit    → nombre corto del circuito en OpenF1 (tools/layout.py, tools/lapcompare.js)
//   altitude   → metros sobre el nivel del mar: más arriba el aire es menos denso (menos apoyo y menos resistencia)
//   tune       → puesta a punto por defecto (src/dynamics.js): alerones de 1 a 10 y balance mecánico de -5 a 5,
//                como la llevan los equipos ahí (poco alerón donde importa la recta, mucho donde hay curvas)
//   rotate     → (opcional) grados para girar el trazado (la telemetría viene en otra orientación que los dibujos)
//   widthMeters → ancho de la pista en metros
//   runoff     → celdas de escapatoria entre la pista y los muros
//   elevationScale → (opcional) exagera o suaviza las alturas; 1 = pendientes reales
//   surfaces   → (opcional, también en los de imagen) qué hay en la escapatoria, pisando lo que sale solo (asfalto
//                por fuera de las curvas lentas, leca por fuera de las rápidas, pasto en el resto; ver track.js):
//                [[desde, hasta, lado, material], ...], en metros desde la largada; lado 'left', 'right' o 'both';
//                material 'grass', 'gravel' (leca) o 'asphalt'
//   kerb       → (opcional) colores [r, g, b] de las franjas de los pianos, que se repiten en orden (hasta 4);
//                si no, blanco y rojo
//   kerbStyle  → (opcional) cómo son los pianos (KERB_STYLE de src/track.js): stripe (largo de cada franja, celdas),
//                width (ancho del piano, celdas), line (línea blanca entre la pista y el piano), green (ancho de la
//                franja verde abrasiva detrás del piano, 0 = sin verde), sausage (salchichas en las curvas más cerradas)
// Un circuito propio (o uno sin telemetría) sale de una imagen; las coordenadas (start, towards) están en píxeles
// de la imagen original.
//   image      → imagen del trazado: línea oscura sobre fondo claro
//   scale      → cuántos píxeles de la imagen forman una celda del mapa
//   threshold  → luminancia (0-255) por debajo de la cual un píxel es pista
//   widen      → celdas extra para ensanchar la pista
//   runoff     → celdas de escapatoria entre la pista y los muros
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
    kerb: [
      [0, 156, 59],
      [255, 214, 0],
      [0, 56, 150],
    ], // Brasil: verde, amarillo y azul
    kerbStyle: { stripe: 1.6, width: 0.9, green: 0.8 },
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
    kerb: [
      [0, 140, 69],
      [240, 240, 240],
      [205, 33, 42],
    ], // Italia: verde, blanco y rojo
    kerbStyle: { stripe: 2.4, width: 1.0, green: 0.6 }, // franjas largas
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
    kerb: [
      [0, 132, 61],
      [255, 205, 0],
    ], // Australia: verde y dorado
    kerbStyle: { stripe: 1.4, width: 0.8, green: 0, sausage: false }, // circuito callejero en un parque: sin verde
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
    kerb: [
      [200, 16, 46],
      [255, 196, 0],
    ], // España: rojo y amarillo
    kerbStyle: { stripe: 1.6, width: 0.9, green: 1.0 },
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
    kerb: [
      [216, 6, 33],
      [240, 240, 240],
    ], // Canadá: rojo y blanco
    kerbStyle: { stripe: 1.2, width: 0.7, green: 0, line: false }, // pianos angostos pegados al asfalto
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
    kerb: [
      [30, 30, 30],
      [253, 218, 36],
      [239, 51, 64],
    ], // Bélgica: negro, amarillo y rojo
    kerbStyle: { stripe: 2.0, width: 1.0, green: 0.8 },
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
    kerb: [
      [1, 33, 105],
      [240, 240, 240],
      [200, 16, 46],
    ], // Reino Unido: azul, blanco y rojo
    kerbStyle: { stripe: 1.6, width: 0.9, green: 1.0 },
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
    kerb: [
      [237, 41, 57],
      [240, 240, 240],
    ], // Austria: rojo y blanco
    kerbStyle: { stripe: 1.6, width: 0.9, green: 1.2 }, // mucho verde abrasivo detrás de los pianos
  },
];
