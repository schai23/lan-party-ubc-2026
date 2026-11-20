// Lanternfall village (Phaser 3, WebGL). Spec 9.1.
// The tile map is rendered ONCE into a 1-pixel-per-tile canvas texture and scaled up (nearest filtering);
// villagers are Blitter bobs. The heavy parts (flow fields, area generation, simulation) go through the router.
import Phaser from 'phaser';
import type { AreagenInput, AreagenOutput, NpcId, PathfindInput, PathfindOutput, SimtickInput, SimtickOutput } from '@sidekick/shared';
import { DIR_DX, DIR_DY, TILE, b64ToBytes, bytesToB64, mulberry32, valueNoise2D } from '@sidekick/jobs';
import type { PlayParams } from '../env';
import { router } from '../sidekick/router';
import { recordFrame, store } from '../sidekick/store';
import { DEFAULT_DISPATCH, NPCS, startListening, stopListening } from './dialogue';
import { startAmbience } from './audio';

export const TILE_PX = 8;
const TARGET_NAMES = ['well', 'market', 'tavern', 'forge', 'temple', 'gate', 'farm', 'dock'];
const TARGET_POS: Record<string, [number, number]> = {
  well: [0.5, 0.5], market: [0.38, 0.38], tavern: [0.3, 0.66], forge: [0.62, 0.3],
  temple: [0.7, 0.72], farm: [0.14, 0.2], dock: [0.16, 0.84],
};
const AGENT_COLORS = [0xf2d16b, 0x8fd3ff, 0xff9f80, 0xb4f08c, 0xe7a6ff, 0xffffff, 0xffc56b, 0x7fe0c4];

// Palette (RGB) for map tiles, index = TILE value.
const PALETTE: [number, number, number][] = [
  [58, 102, 52], // GRASS
  [38, 84, 140], // WATER
  [104, 104, 112], // ROCK
  [28, 64, 34], // TREE
  [160, 132, 92], // PATH
  [120, 96, 72], // FLOOR
  [66, 48, 40], // WALL
  [240, 200, 90], // GATE
];
const THEME_TINT: [string, [number, number, number]][] = [
  ['snow', [1.5, 1.6, 1.8]], ['frost', [1.4, 1.5, 1.8]], ['desert', [1.6, 1.3, 0.8]], ['sand', [1.6, 1.3, 0.8]],
  ['swamp', [0.8, 1.0, 0.7]], ['ash', [0.9, 0.8, 0.8]], ['volcan', [1.4, 0.7, 0.5]], ['mist', [1.0, 1.1, 1.25]],
  ['night', [0.6, 0.65, 1.0]],
];

const isWalkableTile = (t: number) => t !== TILE.WATER && t !== TILE.TREE && t !== TILE.WALL && t !== TILE.ROCK;

interface Village {
  W: number;
  H: number;
  tiles: Uint8Array;
  walkable: Uint8Array;
  targets: { id: string; x: number; y: number }[];
  gate: { x: number; y: number };
}

function buildVillage(W: number, H: number, nTargets: number, seed: number): Village {
  const tiles = new Uint8Array(W * H);
  const set = (x: number, y: number, t: number) => {
    if (x >= 0 && y >= 0 && x < W && y < H) tiles[y * W + x] = t;
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const w = valueNoise2D(seed, x / 26, y / 26) * 0.7 + valueNoise2D(seed + 7, x / 9, y / 9) * 0.3;
      const t = valueNoise2D(seed + 3, x / 7, y / 7);
      tiles[y * W + x] = w > 0.7 ? TILE.WATER : t > 0.76 ? TILE.TREE : TILE.GRASS;
    }
  const gate = { x: W - 1, y: H >> 1 };
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const targets: Village['targets'] = [];
  for (let i = 0; i < nTargets; i++) {
    const name = TARGET_NAMES[i] ?? `poi${i}`;
    let x: number;
    let y: number;
    if (name === 'gate') [x, y] = [W - 6, gate.y];
    else if (TARGET_POS[name]) [x, y] = [Math.round(TARGET_POS[name][0] * W), Math.round(TARGET_POS[name][1] * H)];
    else [x, y] = [Math.round((0.1 + rng() * 0.8) * W), Math.round((0.1 + rng() * 0.8) * H)];
    targets.push({ id: name, x, y });
  }
  // Houses (walls with a floor and a door gap), avoiding targets and the gate approach.
  const houses = Math.floor((W * H) / 2600);
  for (let i = 0; i < houses; i++) {
    const w = 5 + Math.floor(rng() * 5);
    const h = 4 + Math.floor(rng() * 4);
    const x0 = 4 + Math.floor(rng() * (W - w - 8));
    const y0 = 4 + Math.floor(rng() * (H - h - 8));
    if (targets.some((t) => t.x > x0 - 7 && t.x < x0 + w + 7 && t.y > y0 - 7 && t.y < y0 + h + 7)) continue;
    if (Math.abs(y0 - gate.y) < 10 && x0 + w > W - 70) continue;
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++)
        set(x, y, x === x0 || y === y0 || x === x0 + w - 1 || y === y0 + h - 1 ? TILE.WALL : TILE.FLOOR);
    set(x0 + (w >> 1), y0 + h - 1, TILE.FLOOR); // door
  }
  // Roads: L-shaped paths from the well (first target) to every other target; bridges over water.
  const hub = targets[0];
  const road = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const i = (y + dy) * W + (x + dx);
        if (x + dx >= 0 && y + dy >= 0 && x + dx < W && y + dy < H && tiles[i] !== TILE.FLOOR) tiles[i] = TILE.PATH;
      }
  };
  for (const t of targets) {
    for (let x = Math.min(hub.x, t.x); x <= Math.max(hub.x, t.x); x++) road(x, hub.y);
    for (let y = Math.min(hub.y, t.y); y <= Math.max(hub.y, t.y); y++) road(t.x, y);
  }
  for (let x = W - 70; x < W; x++) road(x, gate.y);
  // Plazas around targets.
  for (const t of targets)
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) if (dx * dx + dy * dy <= 16) set(t.x + dx, t.y + dy, TILE.PATH);
  // Forest border with the gate on the east edge.
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) tiles[y * W + x] = TILE.TREE;
  for (let dy = -1; dy <= 1; dy++) {
    set(W - 1, gate.y + dy, TILE.GATE);
    set(W - 2, gate.y + dy, TILE.PATH);
  }
  const walkable = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) walkable[i] = isWalkableTile(tiles[i]) ? 1 : 0;
  return { W, H, tiles, walkable, targets, gate };
}

function paintTiles(W: number, H: number, tiles: ArrayLike<number>, seed: number, tint?: [number, number, number]) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const rng = mulberry32(seed);
  for (let i = 0; i < W * H; i++) {
    const c = PALETTE[tiles[i]] ?? PALETTE[0];
    const v = 0.9 + rng() * 0.2;
    const k = tint ?? [1, 1, 1];
    d[i * 4] = Math.min(255, c[0] * v * k[0]);
    d[i * 4 + 1] = Math.min(255, c[1] * v * k[1]);
    d[i * 4 + 2] = Math.min(255, c[2] * v * k[2]);
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, ctx };
}

export class VillageScene extends Phaser.Scene {
  private p!: PlayParams;
  private v!: Village;
  private n = 0;
  private ax!: Float32Array;
  private ay!: Float32Array;
  private speed!: Float32Array;
  private tgt!: Uint8Array;
  private bobs: Phaser.GameObjects.Bob[] = [];
  private blitter!: Phaser.GameObjects.Blitter;
  private villageImage!: Phaser.GameObjects.Image;
  private fields: (Uint8Array | null)[] = [];
  private density!: Uint8Array;
  private walkableB64 = '';
  private gridSeq = 0;
  private recomputeAcc = 0;
  private simAcc = 0;
  private rng = mulberry32(42);
  private player!: Phaser.GameObjects.Rectangle;
  private px = 0;
  private py = 0;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private npcSpots: { id: NpcId; name: string; x: number; y: number }[] = [];
  private npcObjs: Phaser.GameObjects.GameObject[] = [];
  private lastFrame = 0;
  // Second area
  private area: AreagenOutput | null = null;
  private areaKey = '';
  private areaPending = false;
  private areaImage: Phaser.GameObjects.Image | null = null;
  private areaWalk: Uint8Array | null = null;
  private areaSeq = 0;

  constructor() {
    super('village');
  }

  init(data: { params: PlayParams }) {
    this.p = data.params;
  }

  create() {
    const { gridW: W, gridH: H } = this.p;
    const seed = (store.dispatch ?? DEFAULT_DISPATCH).area.seed;
    this.v = buildVillage(W, H, this.p.targets, 20261121);
    this.walkableB64 = bytesToB64(this.v.walkable);
    this.density = new Uint8Array(W * H);
    this.fields = this.v.targets.map(() => null);
    void seed;

    const { canvas } = paintTiles(W, H, this.v.tiles, 7);
    this.textures.addCanvas('village', canvas);
    this.villageImage = this.add.image(0, 0, 'village').setOrigin(0).setScale(TILE_PX);

    // Target markers
    for (const t of this.v.targets) {
      this.add.circle((t.x + 0.5) * TILE_PX, (t.y + 0.5) * TILE_PX, TILE_PX * 1.2, 0xffe08a, 0.35).setDepth(1);
      this.add
        .text((t.x + 0.5) * TILE_PX, (t.y - 3) * TILE_PX, t.id.toUpperCase(), { fontFamily: 'system-ui', fontSize: '14px', color: '#ffe9b0' })
        .setOrigin(0.5)
        .setDepth(5);
    }

    // Villager dots: a Blitter with one frame per color.
    const dots = this.textures.createCanvas('dots', AGENT_COLORS.length * 4, 4)!;
    const dctx = dots.getContext();
    AGENT_COLORS.forEach((c, i) => {
      dctx.fillStyle = `#${c.toString(16).padStart(6, '0')}`;
      dctx.fillRect(i * 4, 0, 3, 3);
      dots.add(i, 0, i * 4, 0, 3, 3);
    });
    dots.refresh();
    this.blitter = this.add.blitter(0, 0, 'dots').setDepth(2);
    this.spawnAgents();

    // NPCs next to tavern, forge, temple (or spread around the well if fewer targets).
    const near = ['tavern', 'forge', 'temple'];
    NPCS.forEach((npc, i) => {
      const t = this.v.targets.find((x) => x.id === near[i]) ?? this.v.targets[0];
      const x = t.x + 3 + (t === this.v.targets[0] ? i * 3 : 0);
      const y = t.y + 2;
      this.npcSpots.push({ id: npc.id, name: npc.name, x, y });
      const r = this.add.rectangle((x + 0.5) * TILE_PX, (y + 0.5) * TILE_PX, 12, 12, npc.color).setStrokeStyle(2, 0x000000).setDepth(3);
      const label = this.add
        .text((x + 0.5) * TILE_PX, (y - 1.5) * TILE_PX, npc.name, {
          fontFamily: 'system-ui', fontSize: '13px', color: '#ffffff', backgroundColor: '#000000a0', padding: { x: 4, y: 2 },
        })
        .setOrigin(0.5, 1)
        .setDepth(6);
      this.npcObjs.push(r, label);
    });

    // Player
    const hub = this.v.targets[0];
    this.px = hub.x + 0.5;
    this.py = hub.y + 6.5;
    this.player = this.add.rectangle(0, 0, 9, 9, 0x5ce1e6).setStrokeStyle(2, 0xffffff).setDepth(4);
    this.cameras.main.setZoom(1.5);
    this.cameras.main.startFollow(this.player, true, 0.2, 0.2);
    this.setWorldBounds(W, H);
    this.cameras.main.setBackgroundColor('#0b0d12');

    // Input: keys are NOT captured so text inputs in the React shell keep working.
    const kb = this.input.keyboard!;
    const k = (c: number) => kb.addKey(c, false);
    const KC = Phaser.Input.Keyboard.KeyCodes;
    this.keys = {
      W: k(KC.W), A: k(KC.A), S: k(KC.S), D: k(KC.D), UP: k(KC.UP), DOWN: k(KC.DOWN), LEFT: k(KC.LEFT), RIGHT: k(KC.RIGHT),
    };
    kb.on('keydown', (e: KeyboardEvent) => this.onKeyDown(e));
    kb.on('keyup', (e: KeyboardEvent) => this.onKeyUp(e));

    // First flow fields + simtick right away.
    this.recomputeAcc = this.p.recomputeMs;
    this.simAcc = 5000;
    this.lastFrame = performance.now();
  }

  private setWorldBounds(W: number, H: number) {
    this.cameras.main.setBounds(0, 0, W * TILE_PX, H * TILE_PX);
  }

  private spawnAgents() {
    const { W, H, walkable, targets } = this.v;
    const n = this.p.villagers;
    this.n = n;
    this.ax = new Float32Array(n);
    this.ay = new Float32Array(n);
    this.speed = new Float32Array(n);
    this.tgt = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let x = 0;
      let y = 0;
      for (let tries = 0; tries < 50; tries++) {
        x = 2 + Math.floor(this.rng() * (W - 4));
        y = 2 + Math.floor(this.rng() * (H - 4));
        if (walkable[y * W + x]) break;
      }
      this.ax[i] = x + 0.5;
      this.ay[i] = y + 0.5;
      this.speed[i] = 3 + this.rng() * 4;
      this.tgt[i] = Math.floor(this.rng() * targets.length);
      this.bobs.push(this.blitter.create(x * TILE_PX, y * TILE_PX, i % AGENT_COLORS.length));
    }
  }

  private isTyping() {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
  }

  private onKeyDown(e: KeyboardEvent) {
    if (this.isTyping()) return;
    void startAmbience();
    switch (e.code) {
      case 'KeyL':
        store.forceLocal = !store.forceLocal;
        break;
      case 'KeyP':
        store.panelVisible = !store.panelVisible;
        break;
      case 'KeyG':
        if (store.inArea) this.exitArea();
        this.px = this.v.W - 46.5;
        this.py = this.v.gate.y + 0.5;
        break;
      case 'KeyR':
        this.resetArea();
        break;
      case 'Digit1':
      case 'Digit2':
      case 'Digit3': {
        const s = this.npcSpots[Number(e.code.slice(5)) - 1];
        if (s) {
          if (store.inArea) this.exitArea();
          this.px = s.x - 1.5;
          this.py = s.y + 0.5;
        }
        break;
      }
      case 'Space':
        e.preventDefault();
        if (!e.repeat && store.nearNpc) void startListening();
        break;
    }
  }

  private onKeyUp(e: KeyboardEvent) {
    if (e.code === 'Space' && store.listening) void stopListening((store.nearNpc?.id as NpcId) ?? null, this.p.model);
  }

  // ---------------- Crowd: density + flow fields ----------------
  private requestFlowFields() {
    const { W, H, targets } = this.v;
    const den = this.density;
    den.fill(0);
    for (let i = 0; i < this.n; i++) {
      const c = (this.ay[i] | 0) * W + (this.ax[i] | 0);
      const d = den[c] + 24;
      den[c] = d > 255 ? 255 : d;
    }
    const input: PathfindInput = {
      gridId: `village-${++this.gridSeq}`,
      width: W,
      height: H,
      walkableB64: this.walkableB64,
      densityB64: bytesToB64(den),
      targets,
    };
    if (router.canRemote('pathfind')) {
      router.pathfindInFlight = true;
      router
        .submitRemote('pathfind', input)
        .then((r) => this.applyFields(r.output as PathfindOutput))
        .catch(() => this.applyFields(router.runLocal<PathfindOutput>('pathfind', input).output))
        .finally(() => (router.pathfindInFlight = false));
    } else {
      this.applyFields(router.runLocal<PathfindOutput>('pathfind', input).output);
    }
  }

  private applyFields(out: PathfindOutput | undefined) {
    if (!out?.fields) return;
    for (const f of out.fields) {
      const idx = this.v.targets.findIndex((t) => t.id === f.targetId);
      if (idx >= 0) this.fields[idx] = b64ToBytes(f.dirsB64);
    }
  }

  private steerAgents(dt: number) {
    const { W, walkable, targets } = this.v;
    const nT = targets.length;
    const ax = this.ax;
    const ay = this.ay;
    for (let i = 0; i < this.n; i++) {
      const ti = this.tgt[i];
      const f = this.fields[ti];
      let x = ax[i];
      let y = ay[i];
      const t = targets[ti];
      const ddx = t.x + 0.5 - x;
      const ddy = t.y + 0.5 - y;
      if (ddx * ddx + ddy * ddy < 6) {
        this.tgt[i] = (ti + 1 + Math.floor(this.rng() * (nT - 1 || 1))) % nT;
      } else if (f) {
        const dir = f[(y | 0) * W + (x | 0)];
        if (dir) {
          let vx = DIR_DX[dir];
          let vy = DIR_DY[dir];
          if (vx && vy) {
            vx *= 0.7071;
            vy *= 0.7071;
          }
          const s = this.speed[i] * dt;
          const nx = x + vx * s;
          const ny = y + vy * s;
          if (walkable[(ny | 0) * W + (nx | 0)]) {
            x = nx;
            y = ny;
          } else if (walkable[(y | 0) * W + (nx | 0)]) x = nx;
          else if (walkable[(ny | 0) * W + (x | 0)]) y = ny;
          // keep agents inside their cell lane when steering diagonally around corners
          ax[i] = x;
          ay[i] = y;
        }
      }
      const b = this.bobs[i];
      b.x = x * TILE_PX - 1.5;
      b.y = y * TILE_PX - 1.5;
    }
  }

  // ---------------- Second area ----------------
  private areaInput(): AreagenInput {
    const d = store.dispatch ?? DEFAULT_DISPATCH;
    return { seed: d.area.seed, theme: d.area.theme, width: this.p.areaW, height: this.p.areaH, buildingTypes: d.area.buildingTypes };
  }

  private requestArea() {
    const input = this.areaInput();
    const key = `${input.seed}|${input.theme}|${input.width}x${input.height}`;
    if (this.areaKey === key && (this.area || this.areaPending)) return;
    if (!router.canRemote('areagen')) return; // local mode: generated at the crossing (main thread)
    this.areaKey = key;
    this.areaPending = true;
    const seq = ++this.areaSeq;
    store.areaStatus = 'generating on helper…';
    const t0 = performance.now();
    router
      .submitRemote('areagen', input)
      .then((r) => {
        if (seq !== this.areaSeq) return;
        this.area = r.output as AreagenOutput;
        store.areaStatus = `ready (helper, ${Math.round(performance.now() - t0)} ms)`;
      })
      .catch(() => {
        if (seq === this.areaSeq) store.areaStatus = 'helper failed, will generate locally at the gate';
      })
      .finally(() => {
        if (seq === this.areaSeq) this.areaPending = false;
      });
  }

  private enterArea() {
    const input = this.areaInput();
    const key = `${input.seed}|${input.theme}|${input.width}x${input.height}`;
    if (!this.area || this.areaKey !== key) {
      // Not ready: generate synchronously on the main thread right now (this is the visible pause).
      this.areaSeq++;
      this.areaPending = false;
      const r = router.runLocal<AreagenOutput>('areagen', input);
      this.area = r.output;
      this.areaKey = key;
      store.areaStatus = `generated locally at the gate (${Math.round(r.ms)} ms main thread)`;
    }
    const a = this.area;
    const { areaW: W, areaH: H } = this.p;
    if (this.areaImage) {
      this.areaImage.destroy();
      this.areaImage = null;
    }
    if (this.textures.exists('area')) this.textures.remove('area');
    const theme = input.theme.toLowerCase();
    const tint = THEME_TINT.find(([k]) => theme.includes(k))?.[1];
    const { canvas, ctx } = paintTiles(W, H, a.tiles, input.seed, tint);
    ctx.fillStyle = '#ffd84a';
    for (const l of a.loot) ctx.fillRect(l.x, l.y, 1, 1);
    this.textures.addCanvas('area', canvas);
    this.areaImage = this.add.image(0, 0, 'area').setOrigin(0).setScale(TILE_PX).setDepth(0);
    const walk = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) walk[i] = isWalkableTile(a.tiles[i]) ? 1 : 0;
    this.areaWalk = walk;
    let gy = H >> 1;
    const gi = a.tiles.indexOf(TILE.GATE);
    if (gi >= 0) gy = Math.floor(gi / W);
    this.px = 3.5;
    this.py = gy + 0.5;
    this.setAreaVisible(true);
    this.setWorldBounds(W, H);
  }

  private exitArea() {
    this.setAreaVisible(false);
    this.setWorldBounds(this.v.W, this.v.H);
    this.px = this.v.W - 5.5;
    this.py = this.v.gate.y + 0.5;
  }

  private setAreaVisible(inArea: boolean) {
    store.inArea = inArea;
    this.villageImage.setVisible(!inArea);
    this.blitter.setVisible(!inArea);
    for (const o of this.npcObjs) (o as unknown as Phaser.GameObjects.Components.Visible).setVisible(!inArea);
    this.children.list.forEach((c) => {
      if (c instanceof Phaser.GameObjects.Text || c instanceof Phaser.GameObjects.Arc)
        (c as unknown as Phaser.GameObjects.Components.Visible).setVisible(!inArea);
    });
    this.areaImage?.setVisible(inArea);
  }

  resetArea() {
    if (store.inArea) this.exitArea();
    this.areaSeq++;
    this.area = null;
    this.areaKey = '';
    this.areaPending = false;
    store.areaStatus = 'not requested';
  }

  // ---------------- Simulation ----------------
  private requestSim() {
    const d = store.dispatch ?? DEFAULT_DISPATCH;
    const input: SimtickInput = { seed: d.area.seed, tick: ++store.simTick, npcCount: this.n, areaIds: ['village', 'beyond-gate'] };
    router
      .run<SimtickOutput>('simtick', input)
      .then((r) => (store.sim = r.output))
      .catch(() => undefined);
  }

  // ---------------- Frame ----------------
  update() {
    const now = performance.now();
    const frameMs = now - this.lastFrame;
    this.lastFrame = now;
    recordFrame(frameMs);
    const dt = Math.min(frameMs, 100) / 1000;

    // Player movement
    if (!this.isTyping()) {
      const k = this.keys;
      let mx = (k.D.isDown || k.RIGHT.isDown ? 1 : 0) - (k.A.isDown || k.LEFT.isDown ? 1 : 0);
      let my = (k.S.isDown || k.DOWN.isDown ? 1 : 0) - (k.W.isDown || k.UP.isDown ? 1 : 0);
      if (mx && my) {
        mx *= 0.7071;
        my *= 0.7071;
      }
      const W = store.inArea ? this.p.areaW : this.v.W;
      const H = store.inArea ? this.p.areaH : this.v.H;
      const walk = store.inArea ? this.areaWalk! : this.v.walkable;
      const sp = 14 * dt;
      const nx = Math.max(0, Math.min(W - 0.01, this.px + mx * sp));
      const ny = Math.max(0, Math.min(H - 0.01, this.py + my * sp));
      if (walk[(this.py | 0) * W + (nx | 0)]) this.px = nx;
      if (walk[(ny | 0) * W + (this.px | 0)]) this.py = ny;
    }
    this.player.setPosition(this.px * TILE_PX, this.py * TILE_PX);

    if (!store.inArea) {
      // Gate logic
      const gdx = this.v.gate.x - this.px;
      const gdy = this.v.gate.y - this.py;
      if (gdx * gdx + gdy * gdy < 40 * 40) this.requestArea();
      if (this.px >= this.v.W - 1) this.enterArea();
      // NPC proximity
      let near: { id: string; name: string } | null = null;
      for (const s of this.npcSpots) {
        const dx = s.x + 0.5 - this.px;
        const dy = s.y + 0.5 - this.py;
        if (dx * dx + dy * dy < 25) near = { id: s.id, name: s.name };
      }
      if (near?.id !== store.nearNpc?.id) store.nearNpc = near;
    } else {
      if (store.nearNpc) store.nearNpc = null;
      if (this.px < 1.2) this.exitArea();
    }

    // Crowd: recompute fields every recomputeMs (skip while a remote pathfind is outstanding).
    this.recomputeAcc += frameMs;
    if (this.recomputeAcc >= this.p.recomputeMs) {
      if (!router.pathfindInFlight) {
        this.recomputeAcc = 0;
        this.requestFlowFields();
      }
    }
    this.steerAgents(dt);

    this.simAcc += frameMs;
    if (this.simAcc >= 5000) {
      this.simAcc = 0;
      this.requestSim();
    }
  }
}

export function createGame(parent: HTMLElement, params: PlayParams): Phaser.Game {
  const game = new Phaser.Game({
    type: Phaser.WEBGL,
    parent,
    backgroundColor: '#0b0d12',
    pixelArt: true,
    scale: { mode: Phaser.Scale.RESIZE, width: parent.clientWidth || window.innerWidth, height: parent.clientHeight || window.innerHeight },
    fps: { smoothStep: false },
    banner: false,
  });
  game.scene.add('village', VillageScene, true, { params });
  return game;
}

/** For the mic button in the React shell. */
export function micDown() {
  void startAmbience();
  if (store.nearNpc) void startListening();
}
export function micUp(model: string) {
  if (store.listening) void stopListening((store.nearNpc?.id as NpcId) ?? null, model);
}
