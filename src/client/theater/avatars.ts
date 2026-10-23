// Blocky people: everyone in the building (in their profile colour, with their
// emoji or photo as a pixel face), and the staff behind the counters.
import * as THREE from 'three';
import type { Hands } from '../../shared/theater';
import { snackModel } from './models';
import { canvasTexture, emojiCanvas } from './textures';

export interface AvatarLook {
  name: string;
  color: string;
  emoji: string | null;
  image?: string | null;
  /** Staff wear a uniform and no name tag. */
  staff?: boolean;
}

const lambert = (color: THREE.ColorRepresentation) => new THREE.MeshLambertMaterial({ color });

function box(w: number, h: number, d: number, material: THREE.Material, y: number) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.y = y;
  return mesh;
}

function labelSprite(text: string, color: string) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 48;
  const g = c.getContext('2d')!;
  g.font = 'bold 26px "Courier New", ui-monospace, monospace';
  const w = Math.min(250, g.measureText(text).width + 24);
  g.fillStyle = 'rgba(10, 4, 18, 0.78)';
  g.fillRect((256 - w) / 2, 4, w, 40);
  g.fillStyle = color;
  g.fillRect((256 - w) / 2, 40, w, 4);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 24, 240);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: canvasTexture(c), depthTest: true, transparent: true }),
  );
  sprite.scale.set(1.6, 0.3, 1);
  return sprite;
}

function emojiSprite(emoji: string, size = 0.45) {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: canvasTexture(emojiCanvas(emoji, null, 64)),
      transparent: true,
    }),
  );
  sprite.scale.set(size, size, 1);
  return sprite;
}

/** A photo shrunk to 12 × 12 pixels: a face that fits the blocks. */
function pixelPhoto(url: string, onReady: (canvas: HTMLCanvasElement) => void) {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = c.height = 12;
    const g = c.getContext('2d')!;
    const s = Math.min(img.width, img.height);
    g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 12, 12);
    onReady(c);
  };
  img.src = url;
}

export class Avatar {
  readonly group = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly legs: THREE.Mesh[] = [];
  private readonly arms: THREE.Mesh[] = [];
  private readonly face: THREE.MeshLambertMaterial;
  private readonly held: (THREE.Mesh | null)[] = [null, null];
  private down = [false, false];
  private handsKey = '';
  /** Raised-arm animation after a bite (per hand: seconds left). */
  private readonly biting = [0, 0];
  private readonly floating: { sprite: THREE.Sprite; born: number; life: number }[] = [];
  private walk = 0;
  private seated = false;
  /** Where it's heading (other people move smoothly between updates). */
  readonly target = new THREE.Vector3();
  targetYaw = 0;

  constructor(look: AvatarLook) {
    const shirt = lambert(look.staff ? '#b3202c' : look.color);
    const sleeve = lambert(
      new THREE.Color(look.staff ? '#b3202c' : look.color).multiplyScalar(0.8),
    );
    const pants = lambert(look.staff ? '#1a1a22' : '#26304f');
    const skin = lambert('#f0c39a');
    for (const side of [-1, 1]) {
      const leg = box(0.22, 0.75, 0.26, pants, -0.375);
      const hip = new THREE.Group();
      hip.position.set(side * 0.14, 0.78, 0);
      hip.add(leg);
      this.body.add(hip);
      this.legs.push(leg);
      const arm = box(0.18, 0.66, 0.2, sleeve, -0.3);
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.4, 1.42, 0);
      shoulder.add(arm);
      this.body.add(shoulder);
      this.arms.push(arm);
    }
    this.body.add(box(0.62, 0.7, 0.34, shirt, 1.13));
    if (look.staff) this.body.add(box(0.64, 0.12, 0.36, lambert('#ffd23f'), 1.3));
    // The head: a cube with the face on the front.
    this.face = new THREE.MeshLambertMaterial({ color: '#ffffff' });
    const faceCanvas = emojiCanvas(look.emoji || look.name.slice(0, 1).toUpperCase(), look.color);
    this.face.map = canvasTexture(faceCanvas);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), [
      skin,
      skin,
      skin,
      skin,
      skin,
      this.face,
    ]);
    // The face is the -z side: forward, as for the camera.
    head.position.y = 1.75;
    this.body.add(head);
    if (look.staff) this.body.add(box(0.54, 0.14, 0.54, lambert('#b3202c'), 2.04));
    if (look.image) {
      pixelPhoto(look.image, (c) => {
        this.face.map = canvasTexture(c);
        this.face.needsUpdate = true;
      });
    }
    this.group.add(this.body);
    if (!look.staff) {
      const label = labelSprite(look.name, look.color);
      label.position.y = 2.35;
      this.group.add(label);
    }
  }

  /** What they're carrying, in their hands (or set down in a cupholder while seated). */
  setHands(hands: Hands) {
    this.down = hands.map((h) => Boolean(h?.down));
    const key = JSON.stringify(hands.map((h) => h && [h.id, Math.round(h.level * 10)]));
    if (key === this.handsKey) return;
    this.handsKey = key;
    hands.forEach((h, i) => {
      const arm = this.arms[i]!;
      const old = this.held[i];
      if (old) {
        arm.remove(old);
        old.geometry.dispose();
      }
      this.held[i] = null;
      if (!h) return;
      const item = snackModel(h.id, h.level);
      item.position.set(0, -0.36, -0.12);
      arm.add(item);
      this.held[i] = item;
    });
  }

  /** Lifts a hand to eat or drink. */
  bite(hand: 0 | 1) {
    this.biting[hand] = 0.7;
  }

  setSeated(seated: boolean) {
    this.seated = seated;
    for (const leg of this.legs) leg.parent!.rotation.x = seated ? Math.PI / 2 : 0;
    this.body.position.y = seated ? -0.35 : 0;
  }

  /** An emoji or a few words floating up over their head. */
  pop(content: string, isText = false) {
    let sprite: THREE.Sprite;
    if (isText) {
      sprite = labelSprite(content.length > 28 ? `${content.slice(0, 27)}…` : content, '#2ee6d6');
      sprite.scale.set(2.4, 0.42, 1);
    } else {
      sprite = emojiSprite(content, 0.6);
    }
    sprite.position.y = 2.7;
    this.group.add(sprite);
    this.floating.push({ sprite, born: performance.now(), life: isText ? 5000 : 2200 });
  }

  /** Moves toward the target and animates the walk. `smooth` = 0 snaps. */
  update(dt: number, smooth = 10) {
    const before = this.group.position.clone();
    if (smooth) {
      this.group.position.lerp(this.target, Math.min(1, dt * smooth));
      let d = this.targetYaw - this.group.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.group.rotation.y += d * Math.min(1, dt * smooth);
    } else {
      this.group.position.copy(this.target);
      this.group.rotation.y = this.targetYaw;
    }
    const speed = before.distanceTo(this.group.position) / Math.max(dt, 1e-3);
    if (!this.seated && speed > 0.3) this.walk += dt * 9;
    else this.walk *= 0.8;
    const swing = this.seated ? 0 : Math.sin(this.walk) * Math.min(0.7, speed / 4);
    this.legs.forEach((leg, i) => {
      if (!this.seated) leg.parent!.rotation.x = i ? swing : -swing;
    });
    this.arms.forEach((arm, i) => {
      const lift = this.biting[i]! > 0 ? Math.sin((this.biting[i]! / 0.7) * Math.PI) * 2.2 : 0;
      this.biting[i] = Math.max(0, this.biting[i]! - dt);
      arm.parent!.rotation.x = (i ? -swing : swing) - lift;
    });
    this.held.forEach((item, i) => {
      if (item) item.visible = !(this.seated && this.down[i]) || this.biting[i]! > 0;
    });
    const now = performance.now();
    for (let i = this.floating.length - 1; i >= 0; i--) {
      const f = this.floating[i]!;
      const age = (now - f.born) / f.life;
      if (age >= 1) {
        this.group.remove(f.sprite);
        this.floating.splice(i, 1);
        continue;
      }
      f.sprite.position.y = 2.7 + age * 0.8;
      (f.sprite.material as THREE.SpriteMaterial).opacity = 1 - age * age;
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
        o.geometry?.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          // The block atlas is shared by the whole building.
          if (m.userData.shared) continue;
          (m as THREE.MeshBasicMaterial).map?.dispose();
          m.dispose();
        }
      }
    });
  }
}
