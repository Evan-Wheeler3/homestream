// "3, 2, 1" in the style of an old film leader: a sweeping hand, crosshairs and
// a big number, drawn on the screen before the movie starts.

export function drawLeader(canvas: HTMLCanvasElement, msLeft: number, title: string) {
  const w = (canvas.width = 320);
  const h = (canvas.height = 180);
  const g = canvas.getContext('2d')!;
  const n = Math.max(1, Math.ceil(msLeft / 1000) - 0);
  const sweep = 1 - (msLeft % 1000) / 1000;
  g.fillStyle = '#7d7468';
  g.fillRect(0, 0, w, h);
  // The hand sweeps round each second.
  g.fillStyle = '#5e564c';
  g.beginPath();
  g.moveTo(w / 2, h / 2);
  g.arc(w / 2, h / 2, 200, -Math.PI / 2, -Math.PI / 2 + sweep * Math.PI * 2);
  g.closePath();
  g.fill();
  g.strokeStyle = '#efe6d6';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, h / 2);
  g.lineTo(w, h / 2);
  g.moveTo(w / 2, 0);
  g.lineTo(w / 2, h);
  g.stroke();
  for (const r of [62, 74]) {
    g.beginPath();
    g.arc(w / 2, h / 2, r, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = '#111';
  g.font = 'bold 96px "Courier New", ui-monospace, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(Math.min(3, n)), w / 2, h / 2 + 4);
  g.font = 'bold 12px "Courier New", ui-monospace, monospace';
  g.fillStyle = '#efe6d6';
  g.fillText(title.toUpperCase().slice(0, 40), w / 2, h - 12);
  // Film grain and scratches.
  for (let i = 0; i < 70; i++) {
    g.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)';
    g.fillRect(Math.random() * w, Math.random() * h, 1, 1);
  }
  g.fillStyle = 'rgba(255,255,255,0.15)';
  g.fillRect(Math.random() * w, 0, 1, h);
}

/** "THE END" card after the credits, or the intermission card while paused. */
export function drawCard(canvas: HTMLCanvasElement, lines: string[]) {
  const w = (canvas.width = 320);
  const h = (canvas.height = 180);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#0b0610';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = '#ffd23f';
  g.lineWidth = 3;
  g.strokeRect(10, 10, w - 20, h - 20);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  lines.forEach((line, i) => {
    g.fillStyle = i === 0 ? '#ffd23f' : '#f4e9ff';
    g.font = `bold ${i === 0 ? 34 : 14}px "Courier New", ui-monospace, monospace`;
    g.fillText(line, w / 2, h / 2 - 14 + i * 34, w - 40);
  });
}
