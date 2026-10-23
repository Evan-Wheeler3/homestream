// The lobby's arcade games, drawn pixel by pixel on a 240 × 180 canvas:
// Snack Snake, Brick Breaker and Popcorn Catch. Each machine also shows an
// "attract" screen in the lobby until someone walks up to play.
import type { ArcadeGameId, HighScore } from '../../shared/theater';

export const ARCADE_W = 240;
export const ARCADE_H = 180;

export interface ArcadeInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  /** Where a finger or the mouse is across the screen (0–240), when dragging. */
  pointerX: number | null;
}

export interface ArcadeGame {
  score: number;
  lives: number;
  over: boolean;
  update(dt: number, input: ArcadeInput): void;
  draw(g: CanvasRenderingContext2D): void;
}

type Beep = (sound: 'blip' | 'coin' | 'over') => void;

const BG = '#0b0614';
const NEON = {
  pink: '#ff3fa4',
  teal: '#2ee6d6',
  yellow: '#ffd23f',
  orange: '#ff8a3d',
  white: '#f4e9ff',
};

function hud(g: CanvasRenderingContext2D, score: number, lives: number) {
  g.fillStyle = NEON.white;
  g.font = 'bold 9px "Courier New", ui-monospace, monospace';
  g.textAlign = 'left';
  g.textBaseline = 'top';
  g.fillText(`SCORE ${score}`, 4, 3);
  g.textAlign = 'right';
  g.fillText('♥'.repeat(Math.max(0, lives)), ARCADE_W - 4, 3);
}

// -----------------------------------------------------------------------------
// Snack Snake: eat the popcorn, don't hit the walls or yourself.

class Snake implements ArcadeGame {
  score = 0;
  lives = 1;
  over = false;
  private readonly cols = 24;
  private readonly rows = 17;
  private body = [
    { x: 6, y: 8 },
    { x: 5, y: 8 },
    { x: 4, y: 8 },
  ];
  private dir = { x: 1, y: 0 };
  private next = { x: 1, y: 0 };
  private food = { x: 15, y: 8 };
  private timer = 0;

  constructor(private readonly beep: Beep) {}

  private place() {
    do {
      this.food = {
        x: Math.floor(Math.random() * this.cols),
        y: Math.floor(Math.random() * this.rows),
      };
    } while (this.body.some((p) => p.x === this.food.x && p.y === this.food.y));
  }

  update(dt: number, input: ArcadeInput) {
    if (this.over) return;
    const want = input.left
      ? { x: -1, y: 0 }
      : input.right
        ? { x: 1, y: 0 }
        : input.up
          ? { x: 0, y: -1 }
          : input.down
            ? { x: 0, y: 1 }
            : null;
    if (want && (want.x !== -this.dir.x || want.y !== -this.dir.y)) this.next = want;
    this.timer += dt;
    const interval = Math.max(0.055, 0.13 - this.score / 3000);
    while (this.timer >= interval && !this.over) {
      this.timer -= interval;
      this.dir = this.next;
      const head = { x: this.body[0]!.x + this.dir.x, y: this.body[0]!.y + this.dir.y };
      if (
        head.x < 0 ||
        head.y < 0 ||
        head.x >= this.cols ||
        head.y >= this.rows ||
        this.body.some((p) => p.x === head.x && p.y === head.y)
      ) {
        this.over = true;
        this.lives = 0;
        this.beep('over');
        return;
      }
      this.body.unshift(head);
      if (head.x === this.food.x && head.y === this.food.y) {
        this.score += 10;
        this.beep('coin');
        this.place();
      } else {
        this.body.pop();
      }
    }
  }

  draw(g: CanvasRenderingContext2D) {
    g.fillStyle = BG;
    g.fillRect(0, 0, ARCADE_W, ARCADE_H);
    g.strokeStyle = NEON.teal;
    g.strokeRect(0.5, 12.5, ARCADE_W - 1, ARCADE_H - 13);
    const cell = 10;
    const oy = 13;
    g.fillStyle = NEON.yellow;
    g.fillRect(this.food.x * cell + 2, oy + this.food.y * cell + 2, 6, 6);
    g.fillStyle = '#ffffff';
    g.fillRect(this.food.x * cell + 3, oy + this.food.y * cell + 3, 2, 2);
    this.body.forEach((p, i) => {
      g.fillStyle = i === 0 ? NEON.pink : i % 2 ? '#c92a85' : '#e0369a';
      g.fillRect(p.x * cell + 1, oy + p.y * cell + 1, cell - 2, cell - 2);
    });
    hud(g, this.score, this.lives);
  }
}

// -----------------------------------------------------------------------------
// Brick Breaker

class Breakout implements ArcadeGame {
  score = 0;
  lives = 3;
  over = false;
  private paddle = ARCADE_W / 2;
  private ball = { x: ARCADE_W / 2, y: 140, vx: 70, vy: -110, stuck: true };
  private bricks: { x: number; y: number; alive: boolean; color: string }[] = [];
  private level = 1;

  constructor(private readonly beep: Beep) {
    this.layout();
  }

  private layout() {
    const colors = [NEON.pink, NEON.orange, NEON.yellow, NEON.teal, '#7b2cbf'];
    this.bricks = [];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 10; c++)
        this.bricks.push({ x: 6 + c * 23, y: 24 + r * 10, alive: true, color: colors[r]! });
    }
  }

  update(dt: number, input: ArcadeInput) {
    if (this.over) return;
    if (input.pointerX !== null) this.paddle = input.pointerX;
    else this.paddle += ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * 190 * dt;
    this.paddle = Math.max(20, Math.min(ARCADE_W - 20, this.paddle));
    const b = this.ball;
    if (b.stuck) {
      b.x = this.paddle;
      b.y = 160;
      if (input.up || input.left || input.right || input.pointerX !== null) b.stuck = false;
      return;
    }
    const speed = 1 + (this.level - 1) * 0.2;
    b.x += b.vx * dt * speed;
    b.y += b.vy * dt * speed;
    if (b.x < 2 || b.x > ARCADE_W - 2) {
      b.vx = -b.vx;
      b.x = Math.max(2, Math.min(ARCADE_W - 2, b.x));
      this.beep('blip');
    }
    if (b.y < 14) {
      b.vy = Math.abs(b.vy);
      this.beep('blip');
    }
    if (b.vy > 0 && b.y > 163 && b.y < 170 && Math.abs(b.x - this.paddle) < 22) {
      b.vy = -Math.abs(b.vy);
      b.vx = (b.x - this.paddle) * 6;
      this.beep('blip');
    }
    for (const k of this.bricks) {
      if (k.alive && b.x > k.x && b.x < k.x + 21 && b.y > k.y && b.y < k.y + 8) {
        k.alive = false;
        b.vy = -b.vy;
        this.score += 10 * this.level;
        this.beep('coin');
        break;
      }
    }
    if (this.bricks.every((k) => !k.alive)) {
      this.level++;
      this.layout();
      b.stuck = true;
    }
    if (b.y > ARCADE_H) {
      this.lives--;
      b.stuck = true;
      b.vx = 70;
      b.vy = -110;
      if (this.lives <= 0) {
        this.over = true;
        this.beep('over');
      }
    }
  }

  draw(g: CanvasRenderingContext2D) {
    g.fillStyle = BG;
    g.fillRect(0, 0, ARCADE_W, ARCADE_H);
    for (const k of this.bricks) {
      if (!k.alive) continue;
      g.fillStyle = k.color;
      g.fillRect(k.x, k.y, 21, 8);
    }
    g.fillStyle = NEON.teal;
    g.fillRect(this.paddle - 20, 166, 40, 5);
    g.fillStyle = '#ffffff';
    g.fillRect(this.ball.x - 2, this.ball.y - 2, 4, 4);
    hud(g, this.score, this.lives);
    if (this.ball.stuck) {
      g.fillStyle = NEON.yellow;
      g.textAlign = 'center';
      g.fillText('MOVE TO LAUNCH', ARCADE_W / 2, 110);
    }
  }
}

// -----------------------------------------------------------------------------
// Popcorn Catch: catch the popcorn, dodge the burnt kernels.

class Catch implements ArcadeGame {
  score = 0;
  lives = 3;
  over = false;
  private bucket = ARCADE_W / 2;
  private drops: { x: number; y: number; kind: 'pop' | 'gold' | 'burnt'; vy: number }[] = [];
  private spawn = 0;
  private time = 0;

  constructor(private readonly beep: Beep) {}

  update(dt: number, input: ArcadeInput) {
    if (this.over) return;
    this.time += dt;
    if (input.pointerX !== null) this.bucket = input.pointerX;
    else this.bucket += ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * 200 * dt;
    this.bucket = Math.max(16, Math.min(ARCADE_W - 16, this.bucket));
    this.spawn -= dt;
    if (this.spawn <= 0) {
      this.spawn = Math.max(0.25, 0.9 - this.time / 60);
      const r = Math.random();
      this.drops.push({
        x: 10 + Math.random() * (ARCADE_W - 20),
        y: 14,
        kind: r < 0.12 ? 'gold' : r < 0.32 ? 'burnt' : 'pop',
        vy: 45 + Math.random() * 30 + this.time * 1.5,
      });
    }
    for (const d of this.drops) d.y += d.vy * dt;
    this.drops = this.drops.filter((d) => {
      if (d.y > 156 && d.y < 172 && Math.abs(d.x - this.bucket) < 16) {
        if (d.kind === 'burnt') {
          this.lives--;
          this.beep('over');
        } else {
          this.score += d.kind === 'gold' ? 5 : 1;
          this.beep('coin');
        }
        return false;
      }
      if (d.y > ARCADE_H) {
        if (d.kind !== 'burnt') {
          this.lives--;
          this.beep('blip');
        }
        return false;
      }
      return true;
    });
    if (this.lives <= 0) this.over = true;
  }

  draw(g: CanvasRenderingContext2D) {
    g.fillStyle = BG;
    g.fillRect(0, 0, ARCADE_W, ARCADE_H);
    for (const d of this.drops) {
      g.fillStyle = d.kind === 'gold' ? NEON.yellow : d.kind === 'burnt' ? '#3b2a1a' : '#fff6d0';
      g.fillRect(d.x - 3, d.y - 3, 6, 6);
      if (d.kind === 'burnt') {
        g.fillStyle = NEON.orange;
        g.fillRect(d.x - 1, d.y - 1, 2, 2);
      }
    }
    // The bucket: red and white stripes.
    for (let i = 0; i < 6; i++) {
      g.fillStyle = i % 2 ? '#f4f0e6' : '#d62a2a';
      g.fillRect(this.bucket - 15 + i * 5, 158, 5, 14);
    }
    hud(g, this.score, this.lives);
  }
}

export function createGame(id: ArcadeGameId, beep: Beep): ArcadeGame {
  return id === 'snake'
    ? new Snake(beep)
    : id === 'breakout'
      ? new Breakout(beep)
      : new Catch(beep);
}

const TITLES: Record<ArcadeGameId, [string, string]> = {
  snake: ['SNACK', 'SNAKE'],
  breakout: ['BRICK', 'BREAKER'],
  catch: ['POPCORN', 'CATCH'],
};

/** The lobby screen of a machine nobody is playing (a small canvas, any size). */
export function drawAttract(
  canvas: HTMLCanvasElement,
  id: ArcadeGameId,
  time: number,
  best: HighScore | undefined,
) {
  const g = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  g.fillStyle = BG;
  g.fillRect(0, 0, w, h);
  // Something moving, so it looks switched on.
  const colors = [NEON.pink, NEON.teal, NEON.yellow, NEON.orange];
  for (let i = 0; i < 14; i++) {
    const x = (i * 23 + time * (20 + i * 3)) % w;
    const y = (i * 37) % h;
    g.fillStyle = colors[i % 4]!;
    g.fillRect(Math.floor(x), y, 2, 2);
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 13px "Courier New", ui-monospace, monospace';
  g.fillStyle = NEON.yellow;
  const [a, b] = TITLES[id];
  g.fillText(a, w / 2, h * 0.24);
  g.fillStyle = NEON.pink;
  g.fillText(b, w / 2, h * 0.42);
  g.font = 'bold 8px "Courier New", ui-monospace, monospace';
  if (Math.floor(time * 2) % 2 === 0) {
    g.fillStyle = NEON.white;
    g.fillText('PRESS E TO PLAY', w / 2, h * 0.64);
  }
  g.fillStyle = NEON.teal;
  g.fillText(
    best ? `HI ${best.score} ${best.name.slice(0, 8).toUpperCase()}` : 'NO HIGH SCORE YET',
    w / 2,
    h * 0.84,
  );
}
