// Sprite textures drawn in code (no external assets).

function makeTexture(w, h, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  draw(g, w, h);
  const data = new Uint32Array(g.getImageData(0, 0, w, h).data.buffer.slice(0));
  return { w, h, data, canvas };
}

export function treeTexture() {
  return makeTexture(32, 64, (g) => {
    g.fillStyle = '#5a3a1e';
    g.fillRect(14, 50, 4, 14);
    const greens = ['#1d5226', '#256a30', '#2f7f3a', '#3a9446'];
    for (let i = 0; i < 4; i++) {
      const y = 2 + i * 11;
      const hw = 5 + i * 3.4;
      g.fillStyle = greens[i];
      g.beginPath();
      g.moveTo(16, y);
      g.lineTo(16 + hw, y + 18);
      g.lineTo(16 - hw, y + 18);
      g.closePath();
      g.fill();
    }
  });
}

// Corner distance board: white board with a red border and the number, on two legs
export function boardTexture(meters) {
  return makeTexture(48, 40, (g, w) => {
    g.fillStyle = '#3a3a3a';
    g.fillRect(10, 24, 3, 16);
    g.fillRect(35, 24, 3, 16);
    g.fillStyle = '#d81e1e';
    g.fillRect(0, 0, w, 26);
    g.fillStyle = '#f4f4f4';
    g.fillRect(3, 3, w - 6, 20);
    g.fillStyle = '#111';
    g.font = 'bold 17px Arial, Helvetica, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(meters), w / 2, 14);
  });
}
