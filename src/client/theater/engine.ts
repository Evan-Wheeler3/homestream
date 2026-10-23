// Runs the 3D cinema: the camera you walk with (through the same block grid
// that's drawn), the people around you, what's in your hands, what you're close
// enough to use, and what each screen shows. The page (TheaterPage.tsx) tells
// it who's where; it tells the page when you've moved or what you could do.
import * as THREE from 'three';
import {
  ARCADE_GAMES,
  SEAT_COUNT,
  SEATS_PER_ROW,
  type ArcadeGameId,
  type Hands,
  type Scores,
  type Showing,
  type TheaterPlayer,
} from '../../shared/theater';
import { drawAttract } from './arcade';
import { play } from './audio';
import { Avatar } from './avatars';
import { VOXEL } from './grid';
import {
  EYE_HEIGHT,
  HALL,
  placeAt,
  rowU,
  SCREEN,
  SEATED_EYE_HEIGHT,
  seatPose,
  seatWalkway,
  screenYaw,
  SPAWN,
  THEATERS,
  toLocal,
  toWorld,
  type Place,
} from './layout';
import { CUPHOLDER_HEIGHT, CUPHOLDERS, disposeMaterials, materials, snackModel } from './models';
import { step, SPRINT_SPEED, WALK_SPEED, type Body } from './physics';
import { canvasTexture } from './textures';
import { buildWorld, paintDoorSign, type GalleryMovie, type Hotspot, type World } from './world';

export type Prompt =
  | { kind: Hotspot['kind']; label: string; game?: ArcadeGameId }
  | { kind: 'seat'; label: string; theater: number; seat: number }
  | { kind: 'poster'; label: string; movieId: string }
  | { kind: 'stand'; label: string };

export interface EngineEvents {
  onPrompt(prompt: Prompt | null): void;
  onMove(x: number, z: number, yaw: number): void;
  onPlace(place: Place): void;
  /** Walked into a theater door without a ticket for it. */
  onBlocked(theater: number): void;
  /** E or Enter: use whatever you're next to. */
  onInteract(): void;
  /** 1 or 2: eat or drink from that hand. */
  onEat(hand: 0 | 1): void;
  /** Sat down or stood up (snacks go into the cupholders and back). */
  onSeated(seated: boolean): void;
}

const TURN_SPEED = 2.4;
const LOOK_SENSITIVITY = 0.0042;
const TOUCH_LOOK_SENSITIVITY = 0.0068;
const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export class TheaterEngine {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(72, 1, 0.05, 140);
  private readonly world: World;
  private readonly hemi = new THREE.HemisphereLight(0xffe7c4, 0x2a1440, 1.6);
  private readonly ambient = new THREE.AmbientLight(0xffffff, 0.6);
  private readonly screenLight = new THREE.PointLight(0xbfd4ff, 0, 30, 1.2);
  private readonly avatars = new Map<string, Avatar>();
  private readonly keys = new Set<string>();
  private readonly clock = new THREE.Clock();
  private readonly screenSources = new Map<number, THREE.Texture>();
  private readonly posters = new Map<number, THREE.CanvasTexture>();
  private readonly glowSample = document.createElement('canvas');
  private readonly resizeObserver: ResizeObserver | null = null;
  private readonly viewModel = new THREE.Group();
  private readonly overlay = new THREE.Scene();
  private readonly holders = new THREE.Group();
  private holdersKey = '';
  private frame = 0;
  private disposed = false;

  // You.
  readonly body: Body = { x: SPAWN.x, y: 0, z: SPAWN.z, vy: 0, onGround: true };
  yaw = SPAWN.yaw;
  pitch = 0;
  private eyeY = EYE_HEIGHT;
  private bob = 0;
  private stepDistance = 0;
  private wasFalling = 0;
  private seat: { theater: number; seat: number } | null = null;
  private ticket: number | null = null;
  private stick = { x: 0, y: 0 };
  private sprintToggle = false;
  private jumpQueued = false;
  private dragging: { id: number; x: number; y: number } | null = null;
  private lastSent = { x: Infinity, z: Infinity, yaw: Infinity, at: 0 };
  private prompt: Prompt | null = null;
  private place: Place = { kind: 'lobby' };
  private blockedAt = 0;
  private dimmed = 0;
  private wantDim = false;
  private showings = new Map<number, Showing>();
  private players: TheaterPlayer[] = [];
  private taken = new Set<string>();
  private hands: Hands = [null, null];
  private handsKey = '';
  private readonly biting = [0, 0];
  private scores: Scores | null = null;
  /** Keyboard input is off while a dialog or text box is open. */
  inputEnabled = true;

  constructor(
    private readonly container: HTMLElement,
    private readonly events: EngineEvents,
    private readonly movies: GalleryMovie[],
    private readonly lineup: (string | null)[],
    private readonly meId: () => string | null,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'theater__canvas';
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x0a0716);
    this.scene.fog = new THREE.Fog(0x0a0716, 45, 120);
    this.world = buildWorld(movies, lineup);
    this.scene.add(this.world.root, this.hemi, this.ambient, this.screenLight, this.holders);
    // Your hands are drawn last, over everything (so they never poke into a wall).
    this.renderer.autoClear = false;
    this.overlay.add(this.viewModel);
    this.addSky();
    this.glowSample.width = this.glowSample.height = 4;
    this.world.showFrom(this.place, this.body.z);
    this.setShowings([]);
    this.resize();
    if ('ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(this.resize);
      this.resizeObserver.observe(container);
    }
    window.addEventListener('resize', this.resize);
    window.visualViewport?.addEventListener('resize', this.resize);
    window.addEventListener('orientationchange', this.resizeSoon);
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    window.addEventListener('keyup', this.onKeyUp, { capture: true });
    window.addEventListener('blur', this.onBlur);
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerUp);
    this.renderer.setAnimationLoop(this.tick);
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.resize);
    window.visualViewport?.removeEventListener('resize', this.resize);
    window.removeEventListener('orientationchange', this.resizeSoon);
    window.removeEventListener('keydown', this.onKeyDown, { capture: true });
    window.removeEventListener('keyup', this.onKeyUp, { capture: true });
    window.removeEventListener('blur', this.onBlur);
    for (const a of this.avatars.values()) a.dispose();
    for (const t of this.posters.values()) t.dispose();
    this.clearGroup(this.viewModel);
    this.clearGroup(this.holders);
    this.world.dispose();
    disposeMaterials();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private clearGroup(g: THREE.Group) {
    for (const child of [...g.children]) {
      g.remove(child);
      (child as THREE.Mesh).geometry?.dispose();
    }
  }

  private addSky() {
    const stars = new THREE.BufferGeometry();
    const points: number[] = [];
    for (let i = 0; i < 400; i++) {
      const a = (i * 2.399) % (Math.PI * 2);
      const r = 90 + ((i * 37) % 30);
      points.push(Math.cos(a) * r, 20 + ((i * 53) % 60), 30 + Math.sin(a) * r);
    }
    stars.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.scene.add(
      new THREE.Points(stars, new THREE.PointsMaterial({ color: 0xffffff, size: 0.9, fog: false })),
    );
  }

  // The canvas follows its box (rotating a phone, browser bars coming and going).
  private readonly resize = () => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    // Portrait phones: a wider view so the screen fits.
    this.camera.fov = w < h ? 84 : 72;
    this.camera.updateProjectionMatrix();
  };

  private readonly resizeSoon = () => {
    this.resize();
    window.setTimeout(this.resize, 250);
    window.setTimeout(this.resize, 700);
  };

  // ---------------------------------------------------------------------------
  // Input

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (!this.inputEnabled || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, dialog, [role="dialog"]')) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const movement = [
      'w',
      'a',
      's',
      'd',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Shift',
    ];
    if (movement.includes(key)) {
      this.keys.add(key);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const onButton = target?.closest('button, a, [tabindex]') && target !== document.body;
    if (key === ' ' && !onButton) {
      e.preventDefault();
      this.jump();
      return;
    }
    if (key === 'e' || (key === 'Enter' && !onButton)) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) this.events.onInteract();
      return;
    }
    if ((key === '1' || key === '2') && !e.repeat) {
      e.preventDefault();
      this.events.onEat(key === '1' ? 0 : 1);
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    this.keys.delete(key);
  };

  private readonly onBlur = () => this.keys.clear();

  private readonly onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return; // touch is handled by the page's controls
    this.dragging = { id: e.pointerId, x: e.clientX, y: e.clientY };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    if (!this.dragging || this.dragging.id !== e.pointerId) return;
    const dx = e.clientX - this.dragging.x;
    const dy = e.clientY - this.dragging.y;
    this.dragging.x = e.clientX;
    this.dragging.y = e.clientY;
    this.look(dx, dy);
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    if (this.dragging?.id === e.pointerId) this.dragging = null;
  };

  /** Turns the view (from a drag, in pixels). */
  look(dx: number, dy: number, touch = false) {
    const s = touch ? TOUCH_LOOK_SENSITIVITY : LOOK_SENSITIVITY;
    this.yaw -= dx * s;
    this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch - dy * s));
    if (this.seat) {
      // Seated: you can look around, but not turn your back on the screen.
      const facing = screenYaw(THEATERS[this.seat.theater - 1]!);
      let d = this.yaw - facing;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw = facing + Math.max(-1.4, Math.min(1.4, d));
    }
  }

  /** The thumbstick: -1..1 each way (y up = forward). Pushed all the way, you run. */
  setStick(x: number, y: number) {
    this.stick = { x, y };
  }

  setSprint(on: boolean) {
    this.sprintToggle = on;
  }

  jump() {
    if (this.seat || !this.inputEnabled) return;
    this.jumpQueued = true;
  }

  // ---------------------------------------------------------------------------
  // State from the page

  setTicket(theater: number | null) {
    this.ticket = theater;
  }

  setScores(scores: Scores) {
    this.scores = scores;
  }

  /** What you're carrying (drawn in front of you, or in your cupholders when seated). */
  setHands(hands: Hands) {
    this.hands = hands;
    const key = JSON.stringify(hands);
    if (key === this.handsKey) return;
    this.handsKey = key;
    this.clearGroup(this.viewModel);
    hands.forEach((h, i) => {
      if (!h) return;
      const item = snackModel(h.id, h.level);
      item.userData.hand = i;
      item.renderOrder = 10;
      this.viewModel.add(item);
    });
    this.updateHolders();
  }

  /** Lifts a snack to your mouth (in first person). */
  biteAnimation(hand: 0 | 1) {
    this.biting[hand] = 0.6;
  }

  get holding() {
    return this.hands.some(Boolean);
  }

  setPlayers(players: TheaterPlayer[]) {
    this.players = players;
    const me = this.meId();
    const seen = new Set<string>();
    this.taken = new Set(
      players.filter((p) => p.id !== me && p.seat !== null).map((p) => `${p.ticket}:${p.seat}`),
    );
    for (const p of players) {
      if (p.id === me) continue;
      seen.add(p.id);
      let a = this.avatars.get(p.id);
      if (!a) {
        a = new Avatar({ name: p.name, color: p.color, emoji: p.emoji, image: p.image });
        this.avatars.set(p.id, a);
        this.scene.add(a.group);
        this.placeAvatar(a, p);
        a.update(0, 0);
      }
      this.placeAvatar(a, p);
    }
    for (const [id, a] of this.avatars) {
      if (seen.has(id)) continue;
      this.scene.remove(a.group);
      a.dispose();
      this.avatars.delete(id);
    }
    this.updateHolders();
  }

  /** The top of whatever's under a spot (stairs, the stage...). */
  private groundAt(x: number, z: number, from = 4) {
    const grid = this.world.building.grid;
    const ix = grid.ix(x);
    const iz = grid.iz(z);
    for (let iy = grid.iy(from); iy >= 0; iy--) {
      if (grid.solidAt(ix, iy, iz)) return grid.bounds.y0 + (iy + 1) * VOXEL;
    }
    return 0;
  }

  private placeAvatar(a: Avatar, p: TheaterPlayer) {
    const sitting = p.seat !== null && p.ticket !== null;
    if (sitting) {
      const pose = seatPose(THEATERS[p.ticket! - 1]!, p.seat!);
      a.target.set(pose.x, pose.y + 0.05, pose.z);
      a.targetYaw = pose.yaw;
    } else {
      a.target.set(p.x, this.groundAt(p.x, p.z), p.z);
      a.targetYaw = p.yaw;
    }
    a.setSeated(sitting);
    a.setHands(p.hands);
  }

  movePlayer(id: string, x: number, z: number, yaw: number) {
    const a = this.avatars.get(id);
    if (!a) return;
    a.target.set(x, this.groundAt(x, z), z);
    a.targetYaw = yaw;
  }

  pop(id: string, content: string, isText = false) {
    this.avatars.get(id)?.pop(content, isText);
  }

  bite(id: string, hand: 0 | 1) {
    this.avatars.get(id)?.bite(hand);
  }

  /** Snacks in the cupholders of everyone sitting down (you too). */
  private updateHolders() {
    const me = this.meId();
    const seated = this.players
      .map((p) =>
        p.id === me
          ? {
              ...p,
              hands: this.hands,
              seat: this.seat?.seat ?? null,
              ticket: this.seat?.theater ?? p.ticket,
            }
          : p,
      )
      .filter((p) => p.seat !== null && p.ticket !== null && p.hands.some((h) => h?.down));
    if (me && this.seat && !seated.some((p) => p.id === me) && this.hands.some((h) => h?.down)) {
      seated.push({
        id: me,
        hands: this.hands,
        seat: this.seat.seat,
        ticket: this.seat.theater,
      } as TheaterPlayer);
    }
    const key = JSON.stringify(seated.map((p) => [p.ticket, p.seat, p.hands]));
    if (key === this.holdersKey) return;
    this.holdersKey = key;
    this.clearGroup(this.holders);
    for (const p of seated) {
      const t = THEATERS[p.ticket! - 1]!;
      const pose = seatPose(t, p.seat!);
      const across = t.side === -1 ? 1 : -1;
      p.hands.forEach((h, i) => {
        if (!h?.down) return;
        const [sx, sz] = CUPHOLDERS[i]!;
        const w = toWorld(t, pose.u + sz, pose.v + sx * across);
        const item = snackModel(h.id, h.level);
        item.position.set(w.x, pose.y + CUPHOLDER_HEIGHT, w.z);
        this.holders.add(item);
      });
    }
  }

  setShowings(showings: Showing[]) {
    this.showings = new Map(showings.map((s) => [s.theater, s]));
    const title = (id: string | null | undefined) =>
      this.movies.find((m) => m.id === id)?.title ?? '';
    for (const view of this.world.theaters) {
      const n = view.plan.number;
      const s = this.showings.get(n);
      if (!s) {
        const today = title(this.lineup[n - 1]).toUpperCase();
        paintDoorSign(
          view,
          [`THEATER ${n}`, today || 'COMING SOON', today ? 'NOW SHOWING' : ''],
          false,
        );
      } else {
        const status =
          s.status === 'seating'
            ? s.shared
              ? 'SEATING · JOIN IN'
              : 'PRIVATE · SEATING'
            : s.status === 'playing'
              ? s.shared
                ? 'NOW PLAYING · JOIN IN'
                : 'PRIVATE SCREENING'
              : s.status === 'paused'
                ? 'PAUSED'
                : 'THE END';
        paintDoorSign(view, [`THEATER ${n}`, s.title.toUpperCase(), status], true);
      }
      view.beam.visible = s?.status === 'playing';
      view.curtains.target = s && (s.status === 'playing' || s.status === 'paused') ? 1 : 0;
      if (!this.screenSources.has(n)) this.showIdleScreen(n);
    }
  }

  /** Until the movie starts, the screen shows its poster (or today's movie), big and pixelated. */
  private showIdleScreen(theater: number) {
    const view = this.world.theaters[theater - 1]!;
    const movieId = this.showings.get(theater)?.movieId ?? this.lineup[theater - 1];
    const material = view.screen.material;
    const canvas = movieId ? this.world.atlas.posterCanvas(movieId) : null;
    this.posters.get(theater)?.dispose();
    this.posters.delete(theater);
    if (!canvas) {
      material.map = null;
      material.color.set(0x55556a);
      view.screen.scale.set(SCREEN.width, SCREEN.top - SCREEN.bottom, 1);
    } else {
      const texture = canvasTexture(canvas);
      this.posters.set(theater, texture);
      material.map = texture;
      material.color.set(0xd8d8e0);
      const h = SCREEN.top - SCREEN.bottom;
      view.screen.scale.set(h * (2 / 3), h, 1);
    }
    material.needsUpdate = true;
  }

  /** What a screen shows: a video, a canvas (the countdown), or null for its poster. */
  setScreen(theater: number, source: HTMLVideoElement | HTMLCanvasElement | null) {
    const view = this.world.theaters[theater - 1];
    if (!view) return;
    this.screenSources.get(theater)?.dispose();
    this.screenSources.delete(theater);
    if (!source) {
      this.showIdleScreen(theater);
      return;
    }
    const texture =
      source instanceof HTMLVideoElement ? new THREE.VideoTexture(source) : canvasTexture(source);
    texture.colorSpace = THREE.SRGBColorSpace;
    if (source instanceof HTMLVideoElement) {
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
    }
    this.screenSources.set(theater, texture);
    view.screen.material.map = texture;
    view.screen.material.color.set(0xffffff);
    view.screen.material.needsUpdate = true;
    this.fitScreen(theater, source);
  }

  /** Scales a screen to its picture's shape (wide movies are letterboxed). */
  fitScreen(theater: number, source: HTMLVideoElement | HTMLCanvasElement) {
    const view = this.world.theaters[theater - 1];
    if (!view) return;
    const w = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
    const h = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
    const maxH = SCREEN.top - SCREEN.bottom;
    const aspect = w && h ? w / h : 16 / 9;
    const sw = Math.min(SCREEN.width, maxH * aspect);
    view.screen.scale.set(sw, sw / aspect, 1);
  }

  refreshScreen(theater: number) {
    const t = this.screenSources.get(theater);
    if (t && !(t instanceof THREE.VideoTexture)) t.needsUpdate = true;
  }

  setDimmed(dimmed: boolean) {
    this.wantDim = dimmed;
  }

  sitAt(theater: number, seat: number) {
    const pose = seatPose(THEATERS[theater - 1]!, seat);
    this.seat = { theater, seat };
    Object.assign(this.body, { x: pose.x, y: pose.y, z: pose.z, vy: 0, onGround: true });
    this.yaw = pose.yaw;
    const sc = toWorld(THEATERS[theater - 1]!, SCREEN.u, 0);
    const dist = Math.hypot(sc.x - pose.x, sc.z - pose.z);
    this.pitch = Math.atan2((SCREEN.bottom + SCREEN.top) / 2 - (pose.y + SEATED_EYE_HEIGHT), dist);
    this.updateHolders();
    this.updatePrompt(true);
    this.events.onSeated(true);
  }

  standUp() {
    if (!this.seat) return;
    const t = THEATERS[this.seat.theater - 1]!;
    const out = seatWalkway(t, this.seat.seat);
    this.seat = null;
    Object.assign(this.body, { x: out.x, y: out.y, z: out.z, vy: 0, onGround: true });
    this.pitch = 0;
    this.updateHolders();
    this.updatePrompt(true);
    this.events.onSeated(false);
  }

  get isSeated() {
    return this.seat !== null;
  }

  get x() {
    return this.body.x;
  }
  get z() {
    return this.body.z;
  }

  /** Jumps somewhere (the Go to… menu, and tests). */
  goTo(
    place:
      | 'lobby'
      | 'boxoffice'
      | 'concessions'
      | 'arcade'
      | 'gallery'
      | { theater: number; seat?: number },
  ) {
    if (this.seat) this.standUp();
    let x = SPAWN.x;
    let z = SPAWN.z;
    let yaw = SPAWN.yaw;
    if (typeof place === 'object') {
      const t = THEATERS[place.theater - 1]!;
      if (place.seat !== undefined && this.ticket === place.theater) {
        // In the walkway in front of the seat, facing it.
        ({ x, z } = seatWalkway(t, place.seat));
        yaw = screenYaw(t) + Math.PI;
      } else if (this.ticket === place.theater) {
        ({ x, z } = toWorld(t, 3, 6.5));
        yaw = screenYaw(t) + (t.side === -1 ? 0.6 : -0.6);
      } else {
        x = t.side === -1 ? HALL.x0 + 1.2 : HALL.x1 - 1.2;
        z = (t.door.z0 + t.door.z1) / 2;
        yaw = t.side === -1 ? Math.PI / 2 : -Math.PI / 2;
      }
    } else if (place === 'boxoffice') {
      [x, z, yaw] = [-9.5, -4.2, 0];
    } else if (place === 'concessions') {
      [x, z, yaw] = [9.5, -4.2, 0];
    } else if (place === 'arcade') {
      [x, z, yaw] = [12.2, 2.5, -Math.PI / 2];
    } else if (place === 'gallery') {
      [x, z, yaw] = [0, HALL.z0 - 2.2, 0];
    }
    Object.assign(this.body, { x, z, y: this.groundAt(x, z), vy: 0, onGround: true });
    this.eyeY = this.body.y + EYE_HEIGHT;
    this.yaw = yaw;
    this.pitch = 0;
    this.updatePrompt(true);
  }

  /** A good free seat: the middle of the third row, or as close to it as is free. */
  freeSeat(theater: number): number {
    const seats = Array.from({ length: SEAT_COUNT }, (_, i) => i).filter(
      (i) => !this.taken.has(`${theater}:${i}`),
    );
    const score = (i: number) =>
      Math.abs((i % SEATS_PER_ROW) - (SEATS_PER_ROW - 1) / 2) +
      Math.abs(Math.floor(i / SEATS_PER_ROW) - 2) * 1.5;
    return seats.sort((a, b) => score(a) - score(b))[0] ?? 0;
  }

  /**
   * Walks for `seconds` at a steady 60 frames a second, through the same walls
   * as the real thing (tests use it to check routes without waiting on rendering).
   */
  simulate(input: { forward?: number; strafe?: number; sprint?: boolean }, seconds: number) {
    for (let t = 0; t < seconds; t += 1 / 60) this.walk(1 / 60, input);
  }

  // ---------------------------------------------------------------------------
  // Each frame

  private readonly tick = () => {
    if (this.disposed) return;
    const dt = Math.min(0.05, this.clock.getDelta());
    const time = this.clock.elapsedTime;
    if (!this.seat) this.walk(dt);
    // The camera: smooth over steps, a little bob while walking.
    const b = this.body;
    const eyeHeight = this.seat ? SEATED_EYE_HEIGHT : EYE_HEIGHT;
    const target = b.y + eyeHeight;
    this.eyeY = b.onGround ? this.eyeY + (target - this.eyeY) * Math.min(1, dt * 14) : target;
    const bob = reducedMotion() ? 0 : Math.sin(this.bob) * 0.045 * Math.min(1, this.bobAmount);
    this.camera.position.set(b.x, this.eyeY + bob, b.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.updateViewModel(dt);
    for (const a of this.avatars.values()) a.update(dt);
    this.world.animate(time, dt);
    this.world.showFrom(this.place, b.z);
    // House lights down while a movie plays.
    this.dimmed += ((this.wantDim ? 1 : 0) - this.dimmed) * Math.min(1, dt * 1.5);
    materials().opaque.color.setScalar(1 - this.dimmed * 0.6);
    this.hemi.intensity = 1.6 - this.dimmed * 1.3;
    this.ambient.intensity = 0.6 - this.dimmed * 0.45;
    this.updateScreenLight();
    if (++this.frame % 6 === 0) this.updatePrompt();
    if (this.frame % 9 === 0 && this.place.kind === 'lobby') this.drawArcadeScreens(time);
    this.sendMove();
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.camera.updateMatrixWorld();
    this.viewModel.position.copy(this.camera.position);
    this.viewModel.quaternion.copy(this.camera.quaternion);
    this.renderer.clearDepth();
    this.renderer.render(this.overlay, this.camera);
  };

  private bobAmount = 0;

  private walk(dt: number, simulated?: { forward?: number; strafe?: number; sprint?: boolean }) {
    if (!this.inputEnabled && !simulated) return;
    const k = this.keys;
    let forward = simulated?.forward ?? this.stick.y;
    // The thumbstick only moves you (sideways steps sideways); looking is the other thumb's job.
    let strafe = simulated?.strafe ?? this.stick.x;
    let turn = 0;
    if (!simulated) {
      if (k.has('w') || k.has('ArrowUp')) forward += 1;
      if (k.has('s') || k.has('ArrowDown')) forward -= 1;
      if (k.has('a')) strafe -= 1;
      if (k.has('d')) strafe += 1;
      if (k.has('ArrowLeft')) turn += 1;
      if (k.has('ArrowRight')) turn -= 1;
    }
    this.yaw += turn * TURN_SPEED * dt;
    const stickPush = Math.hypot(this.stick.x, this.stick.y);
    const sprint = simulated?.sprint ?? (k.has('Shift') || this.sprintToggle || stickPush > 0.92);
    const len = Math.hypot(forward, strafe);
    let dx = 0;
    let dz = 0;
    if (len > 0.05) {
      const speed = (sprint ? SPRINT_SPEED : WALK_SPEED) * Math.min(1, len) * dt;
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      dx = ((-sin * forward + cos * strafe) / len) * speed;
      dz = ((-cos * forward - sin * strafe) / len) * speed;
    }
    const before = { x: this.body.x, z: this.body.z };
    const jumping = this.jumpQueued && this.body.onGround;
    const result = step(
      this.world.building.grid,
      this.body,
      dx,
      dz,
      dt,
      this.jumpQueued,
      this.ticket,
    );
    this.jumpQueued = false;
    if (simulated) return;
    if (jumping) play('jump');
    if (result.blockedBy !== null && performance.now() - this.blockedAt > 2500) {
      this.blockedAt = performance.now();
      this.events.onBlocked(result.blockedBy);
    }
    // Footsteps, and the camera's bob.
    const moved = Math.hypot(this.body.x - before.x, this.body.z - before.z);
    this.bobAmount +=
      ((moved > 0.001 && this.body.onGround ? 1 : 0) - this.bobAmount) * Math.min(1, dt * 8);
    this.bob += moved * (sprint ? 2.2 : 2.6);
    this.stepDistance += moved;
    if (this.body.onGround && this.stepDistance > (sprint ? 2.1 : 1.6)) {
      this.stepDistance = 0;
      play('step');
    }
    if (!this.body.onGround && this.body.vy < -4) this.wasFalling = 1;
    else if (this.body.onGround && this.wasFalling) {
      this.wasFalling = 0;
      play('land');
    }
  }

  /** Your snacks in front of you, swinging a little as you walk; up to your mouth for a bite. */
  private updateViewModel(dt: number) {
    const seated = Boolean(this.seat);
    for (const item of this.viewModel.children) {
      const hand = item.userData.hand as 0 | 1;
      const side = hand === 0 ? -1 : 1;
      const t = this.biting[hand]!;
      const lift = t > 0 ? Math.sin((t / 0.6) * Math.PI) : 0;
      // In the cupholder, it comes up only for a bite.
      const down = seated && Boolean(this.hands[hand]?.down);
      item.visible = !down || lift > 0.05;
      const sway = Math.sin(this.bob) * 0.012 * this.bobAmount;
      item.scale.setScalar(0.7);
      item.position.set(
        side * (0.36 - lift * 0.32),
        -0.44 + lift * 0.3 + sway - (down ? (1 - lift) * 0.3 : 0),
        -0.72 + lift * 0.34,
      );
      item.rotation.set(lift * 0.6, side * -0.25 * (1 - lift), 0);
    }
    for (const h of [0, 1] as const) this.biting[h] = Math.max(0, this.biting[h]! - dt);
  }

  private drawArcadeScreens(time: number) {
    ARCADE_GAMES.forEach((g, i) => {
      const screen = this.world.arcadeScreens[i]!;
      drawAttract(screen.canvas, g.id, time, this.scores?.[g.id][0]);
      screen.texture.needsUpdate = true;
    });
  }

  private sendMove() {
    const now = performance.now();
    const s = this.lastSent;
    const b = this.body;
    const moved =
      Math.abs(s.x - b.x) + Math.abs(s.z - b.z) > 0.05 || Math.abs(s.yaw - this.yaw) > 0.05;
    if (!moved || now - s.at < 100) return;
    this.lastSent = { x: b.x, z: b.z, yaw: this.yaw, at: now };
    this.events.onMove(b.x, b.z, this.yaw);
    const place = placeAt(b.x, b.z);
    if (JSON.stringify(place) !== JSON.stringify(this.place)) {
      this.place = place;
      this.events.onPlace(place);
    }
  }

  /** Lights the auditorium with the colour of what's on screen. */
  private updateScreenLight() {
    const theater = this.place.kind === 'theater' ? this.place.number : null;
    const source = theater ? this.screenSources.get(theater) : undefined;
    if (!theater || !source || !(source instanceof THREE.VideoTexture)) {
      this.screenLight.intensity *= 0.9;
      return;
    }
    const p = toWorld(THEATERS[theater - 1]!, 4, 0);
    this.screenLight.position.set(p.x, 4.5, p.z);
    if (this.frame % 15 === 0) {
      try {
        const g = this.glowSample.getContext('2d', { willReadFrequently: true })!;
        g.drawImage(source.image as HTMLVideoElement, 0, 0, 4, 4);
        const d = g.getImageData(0, 0, 4, 4).data;
        let r = 0;
        let gr = 0;
        let bl = 0;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i]!;
          gr += d[i + 1]!;
          bl += d[i + 2]!;
        }
        const n = d.length / 4;
        this.screenLight.color.setRGB(r / n / 255, gr / n / 255, bl / n / 255);
      } catch {
        // Not ready yet.
      }
    }
    this.screenLight.intensity += (12 * this.dimmed - this.screenLight.intensity) * 0.1;
  }

  /** What you could do from here: the nearest thing in front of you. */
  private updatePrompt(force = false) {
    let next: Prompt | null = null;
    const b = this.body;
    if (this.seat) {
      next = { kind: 'stand', label: 'Stand up' };
    } else {
      const fx = -Math.sin(this.yaw);
      const fz = -Math.cos(this.yaw);
      // A seat: in the walkway in front of a row, in a theater you hold a ticket for.
      if (this.place.kind === 'theater' && this.ticket === this.place.number) {
        const t = THEATERS[this.ticket - 1]!;
        const me = toLocal(t, b.x, b.z);
        let best: { seat: number; d: number } | null = null;
        for (let seat = 0; seat < SEAT_COUNT; seat++) {
          if (this.taken.has(`${t.number}:${seat}`)) continue;
          const row = Math.floor(seat / SEATS_PER_ROW);
          const du = Math.abs(rowU(row) + 0.5 - me.u);
          const dv = Math.abs(-(SEATS_PER_ROW - 1) / 2 + (seat % SEATS_PER_ROW) - me.v);
          if (du > 0.6 || dv > 0.65) continue;
          const d = du + dv;
          if (!best || d < best.d) best = { seat, d };
        }
        if (best) {
          const row = String.fromCharCode(65 + Math.floor(best.seat / SEATS_PER_ROW));
          next = {
            kind: 'seat',
            label: `Sit in seat ${row}${(best.seat % SEATS_PER_ROW) + 1}`,
            theater: t.number,
            seat: best.seat,
          };
        }
      }
      if (!next) {
        for (const h of this.world.hotspots) {
          if (h.kind === 'trash' && !this.holding) continue;
          const dx = h.x - b.x;
          const dz = h.z - b.z;
          const d = Math.hypot(dx, dz);
          if (d < h.radius && (d < 0.8 || (dx * fx + dz * fz) / d > 0.2)) {
            next = { kind: h.kind, label: h.label, game: h.game };
            break;
          }
        }
      }
      if (!next && this.place.kind !== 'theater') {
        const movieId = this.world.posterInView(b.x, b.z, this.yaw);
        if (movieId) next = { kind: 'poster', label: 'Get a ticket', movieId };
      }
    }
    const same = JSON.stringify(next) === JSON.stringify(this.prompt);
    if (same && !force) return;
    this.prompt = next;
    this.events.onPrompt(next);
  }
}
