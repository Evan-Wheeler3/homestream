// Runs the 3D cinema: the camera you walk with, bumping into walls, the
// people around you, what you're close enough to use, and what each screen
// shows. The page (TheaterPage.tsx) tells it who's where; it tells the page
// when you've moved or what you could do next.
import * as THREE from 'three';
import { SEAT_COUNT, type Showing, type TheaterPlayer } from '../../shared/theater';
import { Avatar } from './avatars';
import {
  EYE_HEIGHT,
  floorHeight,
  HALL,
  placeAt,
  ROW_WALKWAY,
  rowU,
  SCREEN,
  SEATED_EYE_HEIGHT,
  seatPose,
  THEATERS,
  toLocal,
  toWorld,
  type Place,
} from './layout';
import { canvasTexture } from './textures';
import { buildWorld, paintDoorSign, type GalleryMovie, type Hotspot, type World } from './world';

export type Prompt =
  | { kind: Hotspot['kind']; label: string }
  | { kind: 'seat'; label: string; theater: number; seat: number }
  | { kind: 'poster'; label: string; movieId: string }
  | { kind: 'stand'; label: string };

export interface EngineEvents {
  onPrompt(prompt: Prompt | null): void;
  onMove(x: number, z: number, yaw: number): void;
  onPlace(place: Place): void;
  /** Walked into a theater door without a ticket for it. */
  onBlocked(theater: number): void;
  /** E, Enter or Space: use whatever you're next to. */
  onInteract(): void;
}

const WALK_SPEED = 4.2;
const TURN_SPEED = 2.2;
const LOOK_SENSITIVITY = 0.0042;

export class TheaterEngine {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 120);
  private readonly world: World;
  private readonly hemi = new THREE.HemisphereLight(0xffe7c4, 0x2a1440, 1.5);
  private readonly ambient = new THREE.AmbientLight(0xffffff, 0.55);
  private readonly screenLight = new THREE.PointLight(0xbfd4ff, 0, 30, 1.2);
  private readonly avatars = new Map<string, Avatar>();
  private readonly keys = new Set<string>();
  private readonly clock = new THREE.Clock();
  private readonly screenSources = new Map<number, THREE.Texture>();
  private readonly glowSample = document.createElement('canvas');
  private frame = 0;
  private disposed = false;

  // You.
  x = 0;
  z = 4;
  yaw = 0;
  pitch = 0;
  private y = 0;
  private seat: { theater: number; seat: number } | null = null;
  private ticket: number | null = null;
  private joystick = { x: 0, y: 0, strafe: false };
  private dragging: { id: number; x: number; y: number } | null = null;
  private lastSent = { x: Infinity, z: Infinity, yaw: Infinity, at: 0 };
  private prompt: Prompt | null = null;
  private place: Place = { kind: 'lobby' };
  private blockedAt = 0;
  private dimmed = 0;
  private wantDim = false;
  private showings = new Map<number, Showing>();
  private posters = new Map<number, THREE.CanvasTexture>();
  /** Keyboard input is off while a dialog or text box is open. */
  inputEnabled = true;

  constructor(
    private readonly container: HTMLElement,
    private readonly events: EngineEvents,
    movies: GalleryMovie[],
    private readonly meId: () => string | null,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
    });
    // A little under full resolution: faster on phones, and it suits the blocks.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'theater__canvas';
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x070512);
    this.scene.fog = new THREE.Fog(0x070512, 40, 140);
    this.world = buildWorld(movies);
    this.scene.add(this.world.root, this.hemi, this.ambient, this.screenLight);
    this.world.showFrom(this.place, this.z);
    this.addSky();
    this.glowSample.width = this.glowSample.height = 4;
    this.resize();
    window.addEventListener('resize', this.resize);
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
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this.onKeyDown, { capture: true });
    window.removeEventListener('keyup', this.onKeyUp, { capture: true });
    window.removeEventListener('blur', this.onBlur);
    for (const a of this.avatars.values()) a.dispose();
    for (const t of this.posters.values()) t.dispose();
    this.world.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private addSky() {
    const stars = new THREE.BufferGeometry();
    const points: number[] = [];
    for (let i = 0; i < 400; i++) {
      const a = (i * 2.399) % (Math.PI * 2);
      const r = 120 + ((i * 37) % 60);
      points.push(Math.cos(a) * r, 20 + ((i * 53) % 80), 30 + Math.sin(a) * r);
    }
    stars.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.scene.add(
      new THREE.Points(stars, new THREE.PointsMaterial({ color: 0xffffff, size: 0.9, fog: false })),
    );
  }

  private readonly resize = () => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    // Narrow phone screens: widen the view a little so the screen fits.
    this.camera.fov = w < h ? 82 : 70;
    this.camera.updateProjectionMatrix();
  };

  // ---------------------------------------------------------------------------
  // Input

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (!this.inputEnabled || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, dialog, [role="dialog"]')) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const movement = ['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (movement.includes(key)) {
      this.keys.add(key);
      e.preventDefault();
      e.stopPropagation();
    }
    // E, Enter or Space: use whatever you're next to (Enter on a focused button is the button's).
    const onButton = target?.closest('button, a, [tabindex]') && target !== document.body;
    if (key === 'e' || ((key === 'Enter' || key === ' ') && !onButton)) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) this.events.onInteract();
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    this.keys.delete(key);
  };

  private readonly onBlur = () => this.keys.clear();

  private readonly onPointerDown = (e: PointerEvent) => {
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
  look(dx: number, dy: number) {
    this.yaw -= dx * LOOK_SENSITIVITY;
    this.pitch = Math.max(-1.1, Math.min(1.1, this.pitch - dy * LOOK_SENSITIVITY));
    if (this.seat) {
      // Seated: you can look around, but not turn your back on the screen.
      const facing = seatPose(THEATERS[this.seat.theater - 1]!, this.seat.seat).yaw;
      let d = this.yaw - facing;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw = facing + Math.max(-1.3, Math.min(1.3, d));
    }
  }

  /** The on-screen thumbstick, -1..1 each way (y up = forward). */
  setJoystick(x: number, y: number) {
    // A little dead zone so walking straight doesn't drift into a turn.
    this.joystick = { x: Math.abs(x) < 0.15 ? 0 : x, y: Math.abs(y) < 0.15 ? 0 : y, strafe: false };
  }

  // ---------------------------------------------------------------------------
  // State from the page

  setTicket(theater: number | null) {
    this.ticket = theater;
  }

  setPlayers(players: TheaterPlayer[]) {
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
  }

  private readonly looks = new Map<string, string>();
  private taken = new Set<string>();

  private placeAvatar(a: Avatar, p: TheaterPlayer) {
    const sitting = p.seat !== null && p.ticket !== null;
    if (sitting) {
      const pose = seatPose(THEATERS[p.ticket! - 1]!, p.seat!);
      a.target.set(pose.x, pose.y, pose.z);
      a.targetYaw = pose.yaw;
    } else {
      a.target.set(p.x, floorHeight(p.x, p.z), p.z);
      a.targetYaw = p.yaw;
    }
    a.setSeated(sitting);
    const key = `${p.snack}`;
    if (this.looks.get(p.id) !== key) {
      this.looks.set(p.id, key);
      a.setSnack(p.snack);
    }
  }

  movePlayer(id: string, x: number, z: number, yaw: number) {
    const a = this.avatars.get(id);
    if (!a) return;
    a.target.set(x, floorHeight(x, z), z);
    a.targetYaw = yaw;
  }

  pop(id: string, content: string, isText = false) {
    this.avatars.get(id)?.pop(content, isText);
  }

  setShowings(showings: Showing[]) {
    this.showings = new Map(showings.map((s) => [s.theater, s]));
    for (const view of this.world.theaters) {
      const s = this.showings.get(view.plan.number);
      if (!s) {
        paintDoorSign(view, [`THEATER ${view.plan.number}`, 'OPEN'], true);
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
        paintDoorSign(view, [`THEATER ${view.plan.number}`, s.title.toUpperCase(), status], false);
      }
      view.beam.visible = s?.status === 'playing';
      if (!this.screenSources.has(view.plan.number)) this.showIdleScreen(view.plan.number);
    }
  }

  /** The screen shows the showing's poster, big and pixelated, until the movie starts. */
  private showIdleScreen(theater: number) {
    const view = this.world.theaters[theater - 1]!;
    const s = this.showings.get(theater);
    const material = view.screen.material;
    if (!s) {
      material.map = null;
      material.color.set(0x55556a);
      view.screen.scale.set(SCREEN.width, SCREEN.top - SCREEN.bottom, 1);
      material.needsUpdate = true;
      return;
    }
    let texture = this.posters.get(theater);
    const canvas = this.world.atlas.posterCanvas(s.movieId);
    if (canvas) {
      texture?.dispose();
      texture = canvasTexture(canvas);
      this.posters.set(theater, texture);
    }
    material.map = texture ?? null;
    material.color.set(0xffffff);
    const h = SCREEN.top - SCREEN.bottom;
    view.screen.scale.set(h * (2 / 3), h, 1);
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
    const maxW = SCREEN.width;
    const maxH = SCREEN.top - SCREEN.bottom;
    const aspect = w && h ? w / h : 16 / 9;
    const sw = Math.min(maxW, maxH * aspect);
    view.screen.scale.set(sw, sw / aspect, 1);
  }

  /** Marks a canvas screen as changed (the countdown redraws each second). */
  refreshScreen(theater: number) {
    const t = this.screenSources.get(theater);
    if (t && !(t instanceof THREE.VideoTexture)) t.needsUpdate = true;
  }

  /** House lights down while a movie plays. */
  setDimmed(dimmed: boolean) {
    this.wantDim = dimmed;
  }

  sitAt(theater: number, seat: number) {
    const pose = seatPose(THEATERS[theater - 1]!, seat);
    this.seat = { theater, seat };
    this.x = pose.x;
    this.z = pose.z;
    this.yaw = pose.yaw;
    // Look at the middle of the screen.
    const sc = toWorld(THEATERS[theater - 1]!, SCREEN.u, 0);
    const dist = Math.hypot(sc.x - pose.x, sc.z - pose.z);
    this.pitch = Math.atan2((SCREEN.bottom + SCREEN.top) / 2 - (pose.y + SEATED_EYE_HEIGHT), dist);
    this.updatePrompt(true);
  }

  standUp() {
    if (!this.seat) return;
    const t = THEATERS[this.seat.theater - 1]!;
    const pose = seatPose(t, this.seat.seat);
    this.seat = null;
    // Step out into the gap in front of the seat.
    const out = toWorld(t, rowU(pose.row) - ROW_WALKWAY, -4.5 + pose.col);
    this.x = out.x;
    this.z = out.z;
    this.pitch = 0;
    this.updatePrompt(true);
  }

  /** A good free seat: the middle of the third row, or as close to it as is free. */
  freeSeat(theater: number): number {
    const seats = Array.from({ length: SEAT_COUNT }, (_, i) => i).filter(
      (i) => !this.taken.has(`${theater}:${i}`),
    );
    const score = (i: number) => Math.abs((i % 10) - 4.5) + Math.abs(Math.floor(i / 10) - 2) * 1.5;
    return seats.sort((a, b) => score(a) - score(b))[0] ?? 0;
  }

  get isSeated() {
    return this.seat !== null;
  }

  /** Jumps somewhere (the quick-travel menu, and tests). */
  goTo(
    place: 'lobby' | 'boxoffice' | 'concessions' | 'gallery' | { theater: number; seat?: number },
  ) {
    if (this.seat) this.standUp();
    if (typeof place === 'object' && place.seat !== undefined && this.ticket === place.theater) {
      // In front of the seat, ready to sit.
      const t = THEATERS[place.theater - 1]!;
      const pose = seatPose(t, place.seat);
      const p = toWorld(t, rowU(pose.row) - ROW_WALKWAY, -4.5 + pose.col);
      Object.assign(this, { x: p.x, z: p.z, yaw: pose.yaw + Math.PI });
    } else if (typeof place === 'object') {
      const t = THEATERS[place.theater - 1]!;
      // Just inside the door, if you have a ticket; outside it in the hall if not.
      const inside = this.ticket === place.theater;
      const p = inside
        ? toWorld(t, 3, 6.4)
        : { x: t.side === -1 ? HALL.x0 + 1.2 : HALL.x1 - 1.2, z: (t.door.z0 + t.door.z1) / 2 };
      this.x = p.x;
      this.z = p.z;
      this.yaw = inside
        ? t.side === -1
          ? Math.PI * 0.75
          : -Math.PI * 0.75
        : t.side === -1
          ? Math.PI / 2
          : -Math.PI / 2;
    } else if (place === 'boxoffice') {
      Object.assign(this, { x: -8.5, z: -4.2, yaw: 0 });
    } else if (place === 'concessions') {
      Object.assign(this, { x: 8.5, z: -4.2, yaw: 0 });
    } else if (place === 'gallery') {
      Object.assign(this, { x: 0, z: HALL.z0 - 1.5, yaw: 0 });
    } else {
      Object.assign(this, { x: 0, z: 4, yaw: 0 });
    }
    this.pitch = 0;
    this.y = floorHeight(this.x, this.z);
    this.updatePrompt(true);
  }

  // ---------------------------------------------------------------------------
  // Each frame

  private readonly tick = () => {
    if (this.disposed) return;
    const dt = Math.min(0.05, this.clock.getDelta());
    const time = this.clock.elapsedTime;
    if (!this.seat) this.walk(dt);
    const floor = this.seat
      ? seatPose(THEATERS[this.seat.theater - 1]!, this.seat.seat).y
      : floorHeight(this.x, this.z);
    // Smooth over the steps.
    this.y += (floor - this.y) * Math.min(1, dt * 12);
    const eye = this.seat ? SEATED_EYE_HEIGHT : EYE_HEIGHT;
    this.camera.position.set(this.x, this.y + eye, this.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    for (const a of this.avatars.values()) a.update(dt);
    this.world.animate(time);
    // Lights.
    this.dimmed += ((this.wantDim ? 1 : 0) - this.dimmed) * Math.min(1, dt * 1.5);
    this.hemi.intensity = 1.5 - this.dimmed * 1.25;
    this.ambient.intensity = 0.55 - this.dimmed * 0.45;
    this.updateScreenLight();
    if (++this.frame % 6 === 0) this.updatePrompt();
    this.sendMove();
    this.renderer.render(this.scene, this.camera);
  };

  private walk(dt: number) {
    if (!this.inputEnabled) return;
    const k = this.keys;
    // The thumbstick: up and down walk, left and right turn (easy with one thumb).
    let forward = this.joystick.y;
    let strafe = this.joystick.strafe ? this.joystick.x : 0;
    let turn = this.joystick.strafe ? 0 : -this.joystick.x * 0.8;
    if (k.has('w') || k.has('ArrowUp')) forward += 1;
    if (k.has('s') || k.has('ArrowDown')) forward -= 1;
    if (k.has('a')) strafe -= 1;
    if (k.has('d')) strafe += 1;
    if (k.has('ArrowLeft')) turn += 1;
    if (k.has('ArrowRight')) turn -= 1;
    this.yaw += turn * TURN_SPEED * dt;
    const len = Math.hypot(forward, strafe);
    if (len < 0.05) return;
    const scale = (Math.min(1, len) / len) * WALK_SPEED * dt;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const dx = (-sin * forward + cos * strafe) * scale;
    const dz = (-cos * forward - sin * strafe) * scale;
    // Slide along walls: try each direction on its own, the second from wherever
    // the first left you.
    this.step(this.x + dx, this.z);
    this.step(this.x, this.z + dz);
  }

  /**
   * Walks for `seconds` at a steady 60 frames a second, with the same walls as
   * the real thing (tests use it to check routes without waiting on rendering).
   */
  simulate(input: { forward?: number; strafe?: number }, seconds: number) {
    const saved = this.joystick;
    this.joystick = { x: input.strafe ?? 0, y: input.forward ?? 0, strafe: true };
    for (let t = 0; t < seconds; t += 1 / 60) this.walk(1 / 60);
    this.joystick = saved;
  }

  private step(nx: number, nz: number) {
    const hit = this.world.solid.blocked(nx, nz, this.ticket);
    if (hit === null) {
      this.x = nx;
      this.z = nz;
    } else if (typeof hit === 'number' && performance.now() - this.blockedAt > 2500) {
      this.blockedAt = performance.now();
      this.events.onBlocked(hit);
    }
  }

  private sendMove() {
    const now = performance.now();
    const s = this.lastSent;
    const moved =
      Math.abs(s.x - this.x) + Math.abs(s.z - this.z) > 0.05 || Math.abs(s.yaw - this.yaw) > 0.05;
    if (!moved || now - s.at < 100) return;
    this.lastSent = { x: this.x, z: this.z, yaw: this.yaw, at: now };
    this.events.onMove(this.x, this.z, this.yaw);
    const place = placeAt(this.x, this.z, this.world.gallery);
    if (JSON.stringify(place) !== JSON.stringify(this.place)) {
      this.place = place;
      this.events.onPlace(place);
    }
    this.world.showFrom(place, this.z);
  }

  /** Lights the auditorium with the colour of what's on screen. */
  private updateScreenLight() {
    const theater = this.place.kind === 'theater' ? this.place.number : null;
    const source = theater ? this.screenSources.get(theater) : undefined;
    if (!theater || !source || !(source instanceof THREE.VideoTexture)) {
      this.screenLight.intensity *= 0.9;
      return;
    }
    const t = THEATERS[theater - 1]!;
    const p = toWorld(t, 4, 0);
    this.screenLight.position.set(p.x, 4.5, p.z);
    if (this.frame % 15 === 0) {
      const video = source.image as HTMLVideoElement;
      try {
        const g = this.glowSample.getContext('2d', { willReadFrequently: true })!;
        g.drawImage(video, 0, 0, 4, 4);
        const d = g.getImageData(0, 0, 4, 4).data;
        let r = 0;
        let gr = 0;
        let b = 0;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i]!;
          gr += d[i + 1]!;
          b += d[i + 2]!;
        }
        const n = d.length / 4;
        this.screenLight.color.setRGB(r / n / 255, gr / n / 255, b / n / 255);
      } catch {
        // Not ready yet.
      }
    }
    this.screenLight.intensity += (12 * this.dimmed - this.screenLight.intensity) * 0.1;
  }

  /** What you could do from here: the nearest thing in front of you. */
  private updatePrompt(force = false) {
    let next: Prompt | null = null;
    if (this.seat) {
      next = { kind: 'stand', label: 'Stand up' };
    } else {
      const fx = -Math.sin(this.yaw);
      const fz = -Math.cos(this.yaw);
      // Seats: the nearest free one within reach, in a theater you hold a ticket for.
      if (this.place.kind === 'theater' && this.ticket === this.place.number) {
        const t = THEATERS[this.ticket - 1]!;
        // The row in front of you as you stand in its walkway (not the back of the
        // row behind), the seat nearest across.
        const me = toLocal(t, this.x, this.z);
        let best: { seat: number; d: number } | null = null;
        for (let seat = 0; seat < SEAT_COUNT; seat++) {
          if (this.taken.has(`${t.number}:${seat}`)) continue;
          const row = Math.floor(seat / 10);
          const du = rowU(row) - me.u;
          const dv = Math.abs(-4.5 + (seat % 10) - me.v);
          if (du < 0 || du > 1.4 || dv > 0.8) continue;
          const d = du + dv;
          if (!best || d < best.d) best = { seat, d };
        }
        if (best) {
          const row = String.fromCharCode(65 + Math.floor(best.seat / 10));
          next = {
            kind: 'seat',
            label: `Sit in seat ${row}${(best.seat % 10) + 1}`,
            theater: t.number,
            seat: best.seat,
          };
        }
      }
      if (!next) {
        for (const h of this.world.hotspots) {
          const dx = h.x - this.x;
          const dz = h.z - this.z;
          const d = Math.hypot(dx, dz);
          if (d < h.radius && (d < 0.8 || (dx * fx + dz * fz) / d > 0.2)) {
            next = { kind: h.kind, label: h.label };
            break;
          }
        }
      }
      if (!next && this.place.kind !== 'theater') {
        // The poster you're looking at.
        const movieId = this.world.posterInView(this.x, this.z, this.yaw);
        if (movieId) next = { kind: 'poster', label: 'Get a ticket', movieId };
      }
    }
    const same = JSON.stringify(next) === JSON.stringify(this.prompt);
    if (same && !force) return;
    this.prompt = next;
    this.events.onPrompt(next);
  }
}
