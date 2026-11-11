// La decoración de cada equipo, inspirada en la del auto de verdad: los colores y cómo se reparten (side: de
// costado, top: desde arriba, en metros del auto; ver zone() en livery.js) y los sponsors (inventados) de cada
// lugar (SIDE_SLOTS y TOP_SLOTS). Cada sponsor: { t: texto, c: color, font, bg: pastilla detrás, line: borde,
// shield: escudo en vez de pastilla, size: más grande o más chico que lo normal en ese lugar }.

import { LINES, shift } from './livery.js';

const FLOOR = [
  [3, 0.19],
  [-3, 0.19],
];
// una línea de adelante hacia atrás por los puntos dados, estirada hasta las puntas del atlas
const line = (pts) => [[3, pts[0][1]], ...pts, [-3, pts[pts.length - 1][1]]];
const ALL = [-3, 0, 3, 1.2]; // todo el costado
const TOP_ALL = [-3, -1.1, 3, 1.1]; // todo lo de arriba

export const DESIGNS = {
  // rojo, con una franja blanca que sube del pontón a la cubierta, negro abajo y en la cola, escudo amarillo
  hierrari: {
    side(z) {
      z.band(
        line([
          [0.6, 0.19],
          [-0.5, 0.21],
          [-1.9, 0.24],
        ]),
        line([
          [0.6, 0.27],
          [-0.5, 0.3],
          [-1.9, 0.33],
        ]),
        '#141414',
      );
      z.band(
        [
          [0.62, 0.38],
          [0, 0.4],
          [-0.6, 0.47],
          [-1.2, 0.58],
          [-1.7, 0.6],
          [-2.05, 0.5],
        ],
        [
          [0.62, 0.42],
          [0, 0.46],
          [-0.6, 0.55],
          [-1.2, 0.67],
          [-1.7, 0.68],
          [-2.05, 0.56],
        ],
        '#ffffff',
      );
      z.rect(-1.95, 0.19, -3, 0.62, '#141414');
    },
    top(z) {
      z.both((k) =>
        z.band(
          [
            [1.2, k * 0.05],
            [-0.4, k * 0.07],
            [-1.9, k * 0.05],
          ],
          [
            [1.2, k * 0.065],
            [-0.4, k * 0.09],
            [-1.9, k * 0.07],
          ],
          '#ffffff',
        ),
      );
      z.rect(-1.95, -1.1, -3, 1.1, '#141414');
      z.poly(
        [
          [2.18, -0.04],
          [2.18, 0.04],
          [2.04, 0.04],
          [1.98, 0],
          [2.04, -0.04],
        ],
        '#ffd500',
      );
    },
    sponsors: {
      side: {
        pod: { t: 'SHELLY', c: '#d40000', bg: '#ffd500', font: 'wide' },
        cover: { t: 'HB', c: '#ffffff', font: 'serif' },
        nose: { t: 'UNIKREDIT', c: '#ffffff', font: 'narrow' },
        cockpit: { t: 'RICHARD', c: '#ffffff', font: 'thin' },
        podLow: { t: 'SANTANDEROS', c: '#ffffff', font: 'narrow' },
        plate: { t: 'SHELLY', c: '#d40000', bg: '#ffd500', font: 'wide' },
        plateLow: { t: 'PUMMA', c: '#ffffff', font: 'round' },
      },
      top: {
        cover: { t: 'HB', c: '#ffffff', font: 'serif' },
        flap: { t: 'SHELLY', c: '#ffd500', font: 'wide' },
        nose: { t: 'UNIKREDIT', c: '#ffffff', font: 'narrow' },
        wing: { t: 'HB', c: '#ffffff', font: 'serif' },
        front: { t: 'VERIZUM', c: '#ffffff', font: 'narrow' },
      },
    },
  },

  // plateado adelante que se oscurece hasta el negro atrás, con filetes verde agua
  merchoedes: {
    side(z) {
      z.rect(...ALL, z.along(0.7, -0.8, ['#c3c8cd', '#5d6268', '#111214']));
      z.band(shift(LINES.pod, -0.06), shift(LINES.pod, -0.04), '#00b5a5');
      z.band(shift(LINES.shoulder, 0.03), shift(LINES.shoulder, 0.045), '#00b5a5');
    },
    top(z) {
      z.rect(...TOP_ALL, z.along(0.9, -0.5, ['#c3c8cd', '#5d6268', '#111214']));
      z.both((k) => z.rect(2.6, k * 0.035, -2.2, k * 0.05, '#00b5a5'));
    },
    sponsors: {
      side: {
        pod: { t: 'PETRONAZ', c: '#00b5a5', font: 'wide' },
        cover: { t: 'INEOZ', c: '#ffffff' },
        nose: { t: 'QUALCON', c: '#111214', font: 'round' },
        cockpit: { t: 'ADIDOS', c: '#111214' },
        podLow: { t: 'TOMMY H.', c: '#ffffff', font: 'serif' },
        plate: { t: 'PETRONAZ', c: '#00b5a5', font: 'wide' },
        plateLow: { t: 'CROWDSTRAIK', c: '#ffffff', font: 'narrow' },
      },
      top: {
        cover: { t: 'INEOZ', c: '#ffffff' },
        flap: { t: 'PETRONAZ', c: '#00b5a5', font: 'wide' },
        nose: { t: 'QUALCON', c: '#111214', font: 'round' },
        front: { t: 'AMG', c: '#111214' },
      },
    },
  },

  // azul noche mate, rojo abajo, la punta de la trompa amarilla y el toro rojo con el sol amarillo en la cubierta
  redtoro: {
    side(z) {
      z.band(
        FLOOR,
        line([
          [2.0, 0.25],
          [0.6, 0.3],
          [-0.5, 0.33],
          [-2.0, 0.3],
        ]),
        '#e8002d',
      );
      z.rect(2.55, 0, 3, 1.2, '#ffc906');
      z.circle(-1.25, 0.66, 0.11, '#ffc906');
      for (const d of [-1, 1]) {
        const x = -1.25 + d * 0.12; // un toro a cada lado del sol, de frente uno al otro
        z.poly(
          [
            [x, 0.6],
            [x + d * 0.22, 0.58],
            [x + d * 0.26, 0.66],
            [x + d * 0.2, 0.72],
            [x + d * 0.05, 0.74],
            [x - d * 0.04, 0.7],
          ],
          '#e8002d',
        );
      }
    },
    top(z) {
      z.rect(2.55, -1.1, 3, 1.1, '#ffc906');
      z.both((k) =>
        z.poly(
          [
            [0.45, k * 0.28],
            [0.15, k * 0.28],
            [-0.85, k * 0.62],
            [-0.55, k * 0.62],
          ],
          '#e8002d',
        ),
      );
    },
    sponsors: {
      side: {
        pod: { t: 'ORÁCULO', c: '#ffffff' },
        nose: { t: 'MOVIL 1', c: '#ffffff', font: 'wide' },
        cockpit: { t: 'BYBIT', c: '#ffc906', font: 'mono' },
        podLow: { t: 'HONDITA', c: '#ffffff', font: 'narrow' },
        plate: { t: 'ORÁCULO', c: '#ffffff', bg: '#e8002d' },
        plateLow: { t: 'TAG HAUER', c: '#ffffff', font: 'serif' },
      },
      top: {
        cover: { t: 'ORÁCULO', c: '#ffffff' },
        flap: { t: 'ORÁCULO', c: '#e8002d' },
        nose: { t: 'BYBIT', c: '#ffc906', font: 'mono' },
        wing: { t: 'RB', c: '#ffc906' },
      },
    },
  },

  // naranja papaya arriba y gris antracita abajo y en la cola, separados por un filete azul
  mclarron: {
    side(z) {
      const cut = line([
        [2.4, 0.19],
        [1.2, 0.32],
        [0.55, 0.4],
        [-0.4, 0.52],
        [-1.2, 0.57],
        [-2.3, 0.57],
      ]);
      z.band(FLOOR, cut, '#1c1d21');
      z.band(cut, shift(cut, 0.018), '#2a73d6');
      z.rect(-1.95, 0.19, -3, 1.2, '#1c1d21');
    },
    top(z) {
      z.rect(-1.75, -1.1, -3, 1.1, '#1c1d21');
      z.both((k) =>
        z.band(
          [
            [0.55, k * 0.62],
            [-0.6, k * 0.66],
            [-1.75, k * 0.4],
          ],
          [
            [0.55, k * 1.1],
            [-1.75, k * 1.1],
          ],
          '#1c1d21',
        ),
      );
    },
    sponsors: {
      side: {
        pod: { t: 'Mcrolio', c: '#d8352a', bg: '#ffe53a', shield: '#d8352a', font: 'impact', size: 1.35 },
        cover: { t: 'GOOGOL', c: '#1c1d21', font: 'round' },
        nose: { t: 'DELLO', c: '#1c1d21', font: 'wide' },
        cockpit: { t: 'KO-KO', c: '#1c1d21' },
        podLow: { t: 'ALL1', c: '#ff8000', font: 'mono' },
        plate: { t: 'OKX-PRESS', c: '#ff8000', font: 'wide' },
        plateLow: { t: 'MASTERCAR', c: '#ffffff', font: 'serif' },
      },
      top: {
        cover: { t: 'MASTERCAR', c: '#1c1d21', font: 'serif' },
        flap: { t: 'OKX-PRESS', c: '#ff8000', font: 'wide' },
        nose: { t: 'DELLO', c: '#1c1d21', font: 'wide' },
        wing: { t: 'KO-KO', c: '#1c1d21' },
      },
    },
  },

  // verde inglés que se oscurece hacia atrás, filetes lima y negro abajo
  austin: {
    side(z) {
      z.rect(...ALL, z.along(0.5, -2.3, ['#00594f', '#003b34']));
      z.band(
        FLOOR,
        line([
          [2.4, 0.19],
          [0.5, 0.26],
          [-2.3, 0.3],
        ]),
        '#0b0f0e',
      );
      z.band(shift(LINES.pod, -0.07), shift(LINES.pod, -0.05), '#cedc00');
      z.band(shift(LINES.shoulder, 0.03), shift(LINES.shoulder, 0.05), '#cedc00');
    },
    top(z) {
      z.rect(...TOP_ALL, z.along(0.5, -2.3, ['#00594f', '#003b34']));
      z.both((k) => z.rect(1.3, k * 0.075, -2.0, k * 0.09, '#cedc00'));
    },
    sponsors: {
      side: {
        pod: { t: 'ARAMCOSA', c: '#ffffff', font: 'wide' },
        cover: { t: 'COGNIZANTE', c: '#cedc00', font: 'narrow' },
        nose: { t: 'VALVOLINA', c: '#ffffff', font: 'serif' },
        cockpit: { t: 'CRYPTOMAT', c: '#cedc00', font: 'mono' },
        podLow: { t: 'WALKERS', c: '#cedc00', font: 'serif' },
        plate: { t: 'ARAMCOSA', c: '#00594f', bg: '#cedc00', font: 'wide' },
        plateLow: { t: 'BOMBARDINO', c: '#ffffff', font: 'narrow' },
      },
      top: {
        cover: { t: 'COGNIZANTE', c: '#cedc00', font: 'narrow' },
        flap: { t: 'ARAMCOSA', c: '#cedc00', font: 'wide' },
        nose: { t: 'VALVOLINA', c: '#ffffff', font: 'serif' },
        front: { t: 'AMR', c: '#cedc00' },
      },
    },
  },

  // azul adelante y rosa atrás, separados por un tajo negro en diagonal
  allpain: {
    side(z) {
      z.poly(
        [
          [-0.1, 0],
          [-0.6, 1.2],
          [-3, 1.2],
          [-3, 0],
        ],
        '#f363b9',
      );
      z.poly(
        [
          [0.05, 0],
          [-0.1, 0],
          [-0.6, 1.2],
          [-0.45, 1.2],
        ],
        '#111214',
      );
      z.poly(
        [
          [1.05, 0],
          [0.97, 0],
          [0.47, 1.2],
          [0.55, 1.2],
        ],
        '#f363b9',
      );
    },
    top(z) {
      z.both((k) => {
        z.poly(
          [
            [-0.25, 0],
            [-3, 0],
            [-3, k * 1.1],
            [-0.6, k * 1.1],
          ],
          '#f363b9',
        );
        z.poly(
          [
            [-0.1, 0],
            [-0.25, 0],
            [-0.6, k * 1.1],
            [-0.45, k * 1.1],
          ],
          '#111214',
        );
      });
    },
    sponsors: {
      side: {
        pod: { t: 'BWT-AGUA', c: '#ffffff', line: '#111214', font: 'wide' },
        cover: { t: 'MOTTOLA', c: '#ffffff' },
        nose: { t: 'KAZOO', c: '#ffffff', font: 'round' },
        cockpit: { t: 'MAPEI-T', c: '#ffffff', font: 'narrow' },
        podLow: { t: 'BOOKING.YA', c: '#ffffff', font: 'round' },
        plate: { t: 'BWT-AGUA', c: '#0078c1', bg: '#ffffff', font: 'wide' },
        plateLow: { t: 'KAPPA', c: '#ffffff', font: 'mono' },
      },
      top: {
        cover: { t: 'MOTTOLA', c: '#ffffff' },
        flap: { t: 'BWT-AGUA', c: '#ffffff', font: 'wide' },
        nose: { t: 'KAZOO', c: '#ffffff', font: 'round' },
        wing: { t: 'BWT', c: '#ffffff' },
      },
    },
  },

  // azul marino arriba, celeste eléctrico abajo y dos rayas blancas en diagonal
  willyams: {
    side(z) {
      z.band(
        FLOOR,
        line([
          [2.6, 0.19],
          [1.4, 0.3],
          [0.6, 0.33],
          [-0.2, 0.36],
          [-1.0, 0.33],
          [-2.3, 0.3],
        ]),
        '#00a0ff',
      );
      for (const x of [0.35, 0.18])
        z.poly(
          [
            [x, 0.2],
            [x - 0.06, 0.2],
            [x - 0.42, 0.72],
            [x - 0.36, 0.72],
          ],
          '#ffffff',
        );
    },
    top(z) {
      z.both((k) => {
        z.band(
          [
            [0.5, k * 0.55],
            [-1.1, k * 0.5],
          ],
          [
            [0.5, k * 1.1],
            [-1.1, k * 1.1],
          ],
          '#00a0ff',
        );
        z.poly(
          [
            [-0.7, 0],
            [-0.78, 0],
            [-1.2, k * 0.7],
            [-1.12, k * 0.7],
          ],
          '#ffffff',
        );
      });
    },
    sponsors: {
      side: {
        pod: { t: 'ATLASIANO', c: '#ffffff', font: 'round' },
        cover: { t: 'KOMATZU', c: '#ffffff', font: 'wide' },
        nose: { t: 'GULFO', c: '#ff7a00' },
        cockpit: { t: 'DURACELDA', c: '#ffffff', font: 'narrow' },
        podLow: { t: 'MERCURIO', c: '#00205b', font: 'narrow' },
        plate: { t: 'ATLASIANO', c: '#00205b', bg: '#ffffff', font: 'round' },
        plateLow: { t: 'BARCLAY', c: '#ffffff', font: 'serif' },
      },
      top: {
        cover: { t: 'KOMATZU', c: '#ffffff', font: 'wide' },
        flap: { t: 'ATLASIANO', c: '#ffffff', font: 'round' },
        nose: { t: 'GULFO', c: '#ff7a00' },
        front: { t: 'WILLY', c: '#00a0ff' },
      },
    },
  },

  // titanio arriba, negro abajo, y rojo lava sobre la cubierta y la toma de aire
  audios: {
    side(z) {
      const cut = line([
        [2.6, 0.19],
        [1.2, 0.3],
        [0.4, 0.33],
        [-0.6, 0.36],
        [-2.3, 0.36],
      ]);
      z.band(FLOOR, cut, '#121214');
      z.band(cut, shift(cut, 0.015), '#ff2d2d');
      z.band(shift(LINES.cover, -0.08), shift(LINES.cover, 0.05), '#ff2d2d');
    },
    top(z) {
      z.rect(-0.35, -0.08, -2.3, 0.08, '#ff2d2d');
      z.both((k) =>
        z.band(
          [
            [0.55, k * 0.6],
            [-1.2, k * 0.5],
          ],
          [
            [0.55, k * 1.1],
            [-1.2, k * 1.1],
          ],
          '#121214',
        ),
      );
    },
    sponsors: {
      side: {
        pod: { t: 'REVOLUTO', c: '#121214', font: 'wide' },
        cover: { t: 'AUDIÓS', c: '#121214', font: 'thin' },
        nose: { t: 'BP-ULSE', c: '#121214', font: 'mono' },
        cockpit: { t: 'NEXOS', c: '#ff2d2d', font: 'narrow' },
        podLow: { t: 'GLASURIT', c: '#ffffff', font: 'narrow' },
        plate: { t: 'REVOLUTO', c: '#ffffff', bg: '#ff2d2d', font: 'wide' },
        plateLow: { t: 'TEMPUR', c: '#121214', font: 'serif' },
      },
      top: {
        cover: { t: 'AUDIÓS', c: '#ffffff', font: 'thin' },
        flap: { t: 'REVOLUTO', c: '#ff2d2d', font: 'wide' },
        nose: { t: 'BP-ULSE', c: '#121214', font: 'mono' },
        wing: { t: '4R', c: '#ff2d2d' },
      },
    },
  },

  // blanco adelante y negro atrás, cortados en diagonal por una franja roja
  haash: {
    side(z) {
      z.poly(
        [
          [0.3, 0],
          [-0.5, 1.2],
          [-3, 1.2],
          [-3, 0],
        ],
        '#111214',
      );
      z.poly(
        [
          [0.38, 0],
          [0.3, 0],
          [-0.5, 1.2],
          [-0.42, 1.2],
        ],
        '#d50000',
      );
    },
    top(z) {
      z.both((k) => {
        z.poly(
          [
            [-0.2, 0],
            [-3, 0],
            [-3, k * 1.1],
            [-0.9, k * 1.1],
          ],
          '#111214',
        );
        z.poly(
          [
            [-0.12, 0],
            [-0.2, 0],
            [-0.9, k * 1.1],
            [-0.82, k * 1.1],
          ],
          '#d50000',
        );
      });
    },
    sponsors: {
      side: {
        pod: { t: 'MONEYGRAMO', c: '#ffffff', font: 'wide' },
        cover: { t: 'TOYOTO', c: '#d50000' },
        nose: { t: 'HAASH', c: '#111214' },
        cockpit: { t: 'PALFINGO', c: '#111214', font: 'narrow' },
        podLow: { t: 'DOMINGO', c: '#d50000', font: 'round' },
        plate: { t: 'MONEYGRAMO', c: '#111214', bg: '#ffffff', font: 'wide' },
        plateLow: { t: 'TOYOTO', c: '#ffffff' },
      },
      top: {
        cover: { t: 'MONEYGRAMO', c: '#ffffff', font: 'wide' },
        flap: { t: 'TOYOTO', c: '#d50000' },
        nose: { t: 'HAASH', c: '#111214' },
      },
    },
  },

  // blanco adelante y azul atrás, con rayas que se van apretando hacia el azul y un filete rojo
  alfatorito: {
    side(z) {
      const bar = (x, w) =>
        z.poly(
          [
            [x, 0],
            [x - w, 0],
            [x - w - 0.3, 1.2],
            [x - 0.3, 1.2],
          ],
          '#1634cc',
        );
      z.poly(
        [
          [0.25, 0],
          [-0.05, 1.2],
          [-3, 1.2],
          [-3, 0],
        ],
        '#1634cc',
      );
      bar(0.42, 0.06);
      bar(0.56, 0.03);
      bar(0.66, 0.015);
      z.poly(
        [
          [0.3, 0],
          [0.25, 0],
          [-0.05, 1.2],
          [0, 1.2],
        ],
        '#e8002d',
      );
    },
    top(z) {
      z.rect(0.05, -1.1, -3, 1.1, '#1634cc');
      for (const [x, w] of [
        [0.22, 0.06],
        [0.36, 0.03],
        [0.46, 0.015],
      ])
        z.rect(x, -1.1, x - w, 1.1, '#1634cc');
      z.rect(0.1, -1.1, 0.05, 1.1, '#e8002d');
    },
    sponsors: {
      side: {
        pod: { t: 'VISAS', c: '#ffffff', font: 'wide' },
        cover: { t: 'CASH APPS', c: '#ffffff', font: 'round' },
        nose: { t: 'HUGO JEFE', c: '#1634cc', font: 'serif' },
        cockpit: { t: 'DYNA', c: '#1634cc', font: 'mono' },
        podLow: { t: 'PEPA JEANS', c: '#ffffff', font: 'narrow' },
        plate: { t: 'VISAS', c: '#1634cc', bg: '#ffffff', font: 'wide' },
        plateLow: { t: 'CASH APPS', c: '#ffffff', font: 'round' },
      },
      top: {
        cover: { t: 'CASH APPS', c: '#ffffff', font: 'round' },
        flap: { t: 'VISAS', c: '#ffffff', font: 'wide' },
        nose: { t: 'HUGO JEFE', c: '#1634cc', font: 'serif' },
        front: { t: 'ALFA', c: '#1634cc' },
      },
    },
  },

  // negro arriba y blanco abajo, con un filete dorado entre los dos y astillas doradas en la cubierta
  cadillaque: {
    side(z) {
      const cut = line([
        [2.6, 0.5],
        [1.2, 0.42],
        [0.2, 0.39],
        [-0.8, 0.35],
        [-1.6, 0.3],
        [-2.3, 0.28],
      ]);
      z.band(FLOOR, cut, '#e8e8e8');
      z.band(cut, shift(cut, 0.015), '#c9a54a');
      for (const [x, w] of [
        [-0.95, 0.05],
        [-1.1, 0.03],
        [-1.22, 0.015],
      ]) {
        z.poly(
          [
            [x, 0.5],
            [x - w, 0.5],
            [x - w - 0.18, 0.95],
            [x - 0.18, 0.95],
          ],
          '#c9a54a',
        );
      }
    },
    top(z) {
      z.both((k) => {
        z.rect(1.3, k * 0.1, -2.0, k * 0.112, '#c9a54a');
        z.rect(2.15, k * 0.45, 2.6, k * 0.97, '#e8e8e8');
      });
    },
    sponsors: {
      side: {
        pod: { t: 'CADENZA', c: '#c9a54a', font: 'serif' },
        cover: { t: 'IMPERIUM', c: '#ffffff', font: 'thin' },
        nose: { t: 'ALTAIR', c: '#141414', font: 'narrow' },
        cockpit: { t: 'GM-OTOR', c: '#ffffff', font: 'mono' },
        podLow: { t: 'TWG', c: '#141414' },
        plate: { t: 'CADENZA', c: '#141414', bg: '#c9a54a', font: 'serif' },
        plateLow: { t: 'IMPERIUM', c: '#ffffff', font: 'thin' },
      },
      top: {
        cover: { t: 'CADILLAQUE', c: '#c9a54a', font: 'serif' },
        flap: { t: 'CADENZA', c: '#c9a54a', font: 'serif' },
        nose: { t: 'ALTAIR', c: '#ffffff', font: 'narrow' },
        wing: { t: 'TWG', c: '#c9a54a' },
      },
    },
  },
};
