// Worker que arma las mallas de los árboles (trees.js) sin trabar el juego: tarda casi un segundo. Recibe la lista
// de especies y de niveles de detalle, y devuelve cada malla apenas está (los arreglos se transfieren, no se copian)
import { treeMesh } from './trees.js';

onmessage = ({ data: { kinds, cells } }) => {
  kinds.forEach(({ kind, seed }, k) => cells.forEach((cell, l) => {
    const m = treeMesh(kind, cell, seed);
    postMessage({ k, l, data: m.data, index: m.index }, [m.data.buffer, m.index.buffer]);
  }));
};
