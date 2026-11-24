// VR mode (WebXR), made for hand tracking first: no controllers needed.
//
//   Point and pinch at the floor  → teleport there (a ring shows where; red means you can't).
//   Point and pinch at the menu   → press a button.
//   Pinch at anything else        → the menu comes back in front of you.
//
// Controllers work too if you have them: the trigger is a pinch, the left
// stick walks and the right stick turns. The engine owns where you are (the
// "rig" that carries your headset through the building); this draws your hands
// and rays, the teleport ring and the menu, and says what you pointed at.
import * as THREE from 'three';
import { XRHandModelFactory } from 'three/examples/jsm/webxr/XRHandModelFactory.js';
import type { VoxelGrid } from './grid';
import {
  buttonAt,
  castTeleport,
  drawPanel,
  layoutPanel,
  type PanelLayout,
  type VrPanelModel,
} from './xr';

export interface VrHooks {
  grid(): VoxelGrid;
  ticket(): number | null;
  seated(): boolean;
  teleport(x: number, y: number, z: number): void;
  /** Turns you by 45° (-1 left, 1 right). */
  turn(dir: -1 | 1): void;
  /** A thumbstick (controllers only): -1..1 each way, y up = forward. */
  stick(x: number, y: number): void;
  press(id: string): void;
  blocked(theater: number): void;
  started(): void;
  ended(): void;
}

/** The menu's width in metres. */
const PANEL_METRES = 0.56;
const RAY_COLOR = 0xffffff;
const OK_COLOR = 0x5cf08a;
const NO_COLOR = 0xff5a5a;

type Target =
  | { kind: 'button'; id: string; distance: number }
  | {
      kind: 'teleport';
      x: number;
      y: number;
      z: number;
      ok: boolean;
      blockedBy: number | null;
      distance: number;
    }
  | { kind: 'none' };

interface Pointer {
  index: number;
  ray: THREE.XRTargetRaySpace;
  line: THREE.Line;
  ring: THREE.Mesh;
  target: Target;
  /** What it was pointing at when the pinch began. */
  pinched: Target | null;
  source: XRInputSource | null;
}

export class VrMode {
  private session: XRSession | null = null;
  private readonly pointers: Pointer[] = [];
  private readonly panelCanvas = document.createElement('canvas');
  private readonly panelTexture = new THREE.CanvasTexture(this.panelCanvas);
  readonly panel: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private model: VrPanelModel = { title: '', lines: [], buttons: [] };
  private layout: PanelLayout = layoutPanel(this.model);
  private modelKey = '';
  private hover: string | null = null;
  private pressed: string | null = null;
  private turned = false;
  private readonly raycaster = new THREE.Raycaster();
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly origin = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();

  static async supported(): Promise<boolean> {
    try {
      return Boolean(await navigator.xr?.isSessionSupported('immersive-vr'));
    } catch {
      return false;
    }
  }

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly rig: THREE.Group,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly hooks: VrHooks,
  ) {
    this.panelTexture.colorSpace = THREE.SRGBColorSpace;
    this.panelTexture.minFilter = THREE.LinearFilter;
    this.panelTexture.generateMipmaps = false;
    this.panel = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: this.panelTexture,
        transparent: true,
        // Always on top: a seat back or a wall never hides the menu.
        depthTest: false,
        depthWrite: false,
        fog: false,
      }),
    );
    this.panel.renderOrder = 1000;
    this.panel.visible = false;
    this.scene.add(this.panel);

    const hands = new XRHandModelFactory();
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1),
    ]);
    const ringGeometry = new THREE.RingGeometry(0.22, 0.3, 24).rotateX(-Math.PI / 2);
    for (const index of [0, 1]) {
      const ray = renderer.xr.getController(index);
      const line = new THREE.Line(
        lineGeometry,
        new THREE.LineBasicMaterial({
          color: RAY_COLOR,
          transparent: true,
          opacity: 0.7,
          depthTest: false,
          fog: false,
        }),
      );
      line.renderOrder = 999;
      ray.add(line);
      const ring = new THREE.Mesh(
        ringGeometry,
        new THREE.MeshBasicMaterial({
          color: OK_COLOR,
          transparent: true,
          opacity: 0.85,
          depthTest: false,
          fog: false,
        }),
      );
      ring.renderOrder = 998;
      ring.visible = false;
      this.scene.add(ring);
      const pointer: Pointer = {
        index,
        ray,
        line,
        ring,
        target: { kind: 'none' },
        pinched: null,
        source: null,
      };
      ray.addEventListener('connected', (e) => {
        pointer.source = (e as unknown as { data: XRInputSource }).data;
      });
      ray.addEventListener('disconnected', () => {
        pointer.source = null;
        ring.visible = false;
      });
      ray.addEventListener('selectstart', () => {
        pointer.pinched = pointer.target;
        if (pointer.target.kind === 'button') {
          this.pressed = pointer.target.id;
          this.redraw();
        }
      });
      // The action happens on letting go (the browser counts that as you
      // choosing to, so a movie may start with sound).
      ray.addEventListener('select', () => this.select(pointer));
      ray.addEventListener('selectend', () => {
        pointer.pinched = null;
        if (this.pressed) {
          this.pressed = null;
          this.redraw();
        }
      });
      rig.add(ray);
      // Blocky hands to match the building (drawn from the tracked joints; nothing to download).
      const hand = renderer.xr.getHand(index);
      hand.add(hands.createHandModel(hand, 'boxes'));
      rig.add(hand);
      // A controller, if one turns up: a small block where it is.
      const grip = renderer.xr.getControllerGrip(index);
      const block = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.05, 0.12),
        new THREE.MeshBasicMaterial({ color: 0x2c2350 }),
      );
      grip.addEventListener('connected', (e) => {
        block.visible = !(e as unknown as { data: XRInputSource }).data.hand;
      });
      grip.add(block);
      rig.add(grip);
      this.pointers.push(pointer);
    }
  }

  get active() {
    return this.session !== null;
  }

  async enter() {
    if (this.session || !navigator.xr) return;
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'hand-tracking'],
    });
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    // Sharp where you look, softer at the edges: easier on an older headset.
    this.renderer.xr.setFoveation(1);
    session.addEventListener('end', () => {
      this.session = null;
      this.panel.visible = false;
      for (const p of this.pointers) p.ring.visible = false;
      this.renderer.xr.enabled = false;
      this.hooks.ended();
    });
    await this.renderer.xr.setSession(session);
    this.session = session;
    this.hooks.started();
  }

  exit() {
    void this.session?.end();
  }

  setPanel(model: VrPanelModel) {
    const key = JSON.stringify(model);
    if (key === this.modelKey) return;
    this.modelKey = key;
    this.model = model;
    this.layout = layoutPanel(model);
    this.panel.scale.set(PANEL_METRES, (PANEL_METRES * this.layout.height) / this.layout.width, 1);
    if (this.hover && !model.buttons.some((b) => b.id === this.hover)) this.hover = null;
    this.redraw();
  }

  private redraw() {
    const { width, height } = this.panelCanvas;
    drawPanel(this.panelCanvas, this.model, this.layout, this.hover, this.pressed);
    // A texture's size is fixed once it's on the GPU: a taller or shorter menu needs a new one.
    if (this.panelCanvas.width !== width || this.panelCanvas.height !== height) {
      this.panelTexture.dispose();
    }
    this.panelTexture.needsUpdate = true;
  }

  /** Brings the menu up in front of you: a little below your eyes, tilted to face you (lower when seated). */
  showPanel() {
    const head = new THREE.Vector3();
    this.camera.getWorldPosition(head);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      this.camera.getWorldQuaternion(new THREE.Quaternion()),
    );
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const seated = this.hooks.seated();
    this.panel.position.copy(head).addScaledVector(forward, seated ? 0.5 : 0.6);
    this.panel.position.y -= seated ? 0.5 : 0.38;
    this.panel.lookAt(head);
    this.panel.visible = true;
  }

  hidePanel() {
    this.panel.visible = false;
  }

  /** Each frame: what each hand points at, the rays and rings, and controller sticks. */
  update() {
    if (!this.session) return;
    const grid = this.hooks.grid();
    const seated = this.hooks.seated();
    let hover: string | null = null;
    // Walked away from the menu: it follows.
    const head = new THREE.Vector3();
    this.camera.getWorldPosition(head);
    if (this.panel.visible && this.panel.position.distanceTo(head) > 2.5) this.showPanel();
    this.panel.updateMatrixWorld();
    for (const p of this.pointers) {
      const live = p.source !== null && p.ray.visible;
      p.line.visible = live;
      if (!live) {
        p.ring.visible = false;
        p.target = { kind: 'none' };
        continue;
      }
      this.tmpMatrix.identity().extractRotation(p.ray.matrixWorld);
      this.origin.setFromMatrixPosition(p.ray.matrixWorld);
      this.direction.set(0, 0, -1).applyMatrix4(this.tmpMatrix).normalize();
      let target: Target = { kind: 'none' };
      let panelDistance: number | null = null;
      if (this.panel.visible) {
        this.raycaster.set(this.origin, this.direction);
        const hit = this.raycaster.intersectObject(this.panel, false)[0];
        if (hit?.uv) {
          panelDistance = hit.distance;
          const id = buttonAt(this.layout, hit.uv.x, hit.uv.y);
          if (id) target = { kind: 'button', id, distance: hit.distance };
        }
      }
      if (panelDistance === null && !seated) {
        const hit = castTeleport(grid, this.origin, this.direction, this.hooks.ticket());
        if (hit) {
          target = {
            kind: 'teleport',
            x: hit.x,
            y: hit.y,
            z: hit.z,
            ok: hit.ok,
            blockedBy: hit.ok ? null : hit.blockedBy,
            distance: hit.distance,
          };
        }
      }
      p.target = target;
      if (target.kind === 'button') hover = hover ?? target.id;
      // The ring shows where you'd land (green) or a door you can't go through (red), not walls.
      const ring = target.kind === 'teleport' && (target.ok || target.blockedBy !== null);
      p.ring.visible = ring;
      if (target.kind === 'teleport') {
        p.ring.position.set(target.x, target.y + 0.02, target.z);
        (p.ring.material as THREE.MeshBasicMaterial).color.setHex(target.ok ? OK_COLOR : NO_COLOR);
      }
      const length = target.kind === 'none' ? (panelDistance ?? 3) : target.distance;
      p.line.scale.z = Math.max(0.05, length);
      (p.line.material as THREE.LineBasicMaterial).color.setHex(
        target.kind === 'teleport' ? (target.ok ? OK_COLOR : NO_COLOR) : RAY_COLOR,
      );
    }
    if (hover !== this.hover) {
      this.hover = hover;
      this.redraw();
    }
    this.readSticks();
  }

  private select(p: Pointer) {
    const t = p.pinched ?? p.target;
    p.pinched = null;
    if (t.kind === 'button') {
      this.hooks.press(t.id);
      return;
    }
    if (t.kind === 'teleport' && !this.hooks.seated()) {
      if (t.ok) {
        this.hooks.teleport(t.x, t.y, t.z);
        if (this.panel.visible) this.showPanel();
        return;
      }
      if (t.blockedBy !== null) {
        this.hooks.blocked(t.blockedBy);
        this.showPanel();
        return;
      }
    }
    // Pinched at nothing in particular: the menu, please.
    this.showPanel();
  }

  /** Controllers (not hands): left stick walks, right stick turns in 45° steps. */
  private readSticks() {
    let sx = 0;
    let sy = 0;
    let turn = 0;
    for (const source of this.session?.inputSources ?? []) {
      const pad = source.gamepad;
      if (!pad || source.hand) continue;
      const x = pad.axes[2] ?? 0;
      const y = pad.axes[3] ?? 0;
      if (source.handedness === 'right') turn = x;
      else {
        sx = Math.abs(x) > 0.15 ? x : 0;
        sy = Math.abs(y) > 0.15 ? -y : 0;
      }
    }
    this.hooks.stick(sx, sy);
    if (Math.abs(turn) > 0.7 && !this.turned) {
      this.turned = true;
      this.hooks.turn(turn > 0 ? 1 : -1);
    } else if (Math.abs(turn) < 0.3) {
      this.turned = false;
    }
  }

  dispose() {
    this.exit();
    this.scene.remove(this.panel);
    this.panel.geometry.dispose();
    this.panel.material.dispose();
    this.panelTexture.dispose();
    for (const p of this.pointers) this.scene.remove(p.ring);
  }
}
