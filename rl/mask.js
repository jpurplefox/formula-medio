// Formato de las máscaras exportadas: ancho y alto (uint32) y después un bit por celda.

export function packMask({ W, H, road }) {
  const out = new Uint8Array(8 + Math.ceil((W * H) / 8));
  const view = new DataView(out.buffer);
  view.setUint32(0, W, true);
  view.setUint32(4, H, true);
  for (let i = 0; i < W * H; i++) if (road[i]) out[8 + (i >> 3)] |= 1 << (i & 7);
  return out;
}

export function unpackMask(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const W = view.getUint32(0, true),
    H = view.getUint32(4, true);
  const road = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) road[i] = (bytes[8 + (i >> 3)] >> (i & 7)) & 1;
  return { W, H, road };
}
