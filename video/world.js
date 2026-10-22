// The film's 3D world (three.js), drawn under the 2D layers of film.html and, like them, a pure function of
// time: a physically lit split-flap departure board (the hero of the opening and the close, and the room every
// other act plays in), an Echo Show that swings in and hands over, pixel for pixel, to the real board, and the
// architecture as slabs in space with data moving between them.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const { TL, L, W, E, prog, lerp, clamp, sp, HEAVY, PREMIUM, SNAPPY, mulberry } = window.FILM;
await Promise.all(['700 120px "Barlow Condensed"', '500 40px "Barlow"', 'italic 400 80px "Instrument Serif"'].map((f) => document.fonts.load(f)));

const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(1920, 1080, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#090807');
scene.fog = new THREE.Fog('#090807', 18, 70);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;
const camera = new THREE.PerspectiveCamera(35, 1920 / 1080, 0.05, 200);
// Light: one warm key from the top left (the board's amber spotlight), a cool rim, a little fill.
const key = new THREE.SpotLight('#ffd9a0', 520, 80, 0.55, 0.6, 1.6);
key.position.set(-14, 16, 22);
scene.add(key, key.target, new THREE.HemisphereLight('#3a3226', '#050404', 0.6));
const rim = new THREE.DirectionalLight('#9fc4ff', 0.6);
rim.position.set(18, 6, -10);
scene.add(rim);

// ---------- the flap font: one atlas of glyphs, each module half shows a slice of it ----------
const CH = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:?-';
const AC = 8, AR = Math.ceil(CH.length / AC), GW = 128, GH = 192;
const atlasCanvas = Object.assign(document.createElement('canvas'), { width: AC * GW, height: AR * GH });
{
  const g = atlasCanvas.getContext('2d');
  [...CH].forEach((c, i) => {
    const x = (i % AC) * GW, y = Math.floor(i / AC) * GH;
    const grad = g.createLinearGradient(0, y, 0, y + GH);
    grad.addColorStop(0, '#171512'); grad.addColorStop(0.5, '#100f0d'); grad.addColorStop(1, '#0b0a09');
    g.fillStyle = grad; g.fillRect(x + 2, y + 2, GW - 4, GH - 4);
    g.fillStyle = '#f3ede2'; g.font = '700 150px "Barlow Condensed"'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(c, x + GW / 2, y + GH / 2 + 8);
  });
}
const atlas = new THREE.CanvasTexture(atlasCanvas);
atlas.colorSpace = THREE.SRGBColorSpace;
atlas.anisotropy = 8;
const half = (top) => { const t = atlas.clone(); t.repeat.set(1 / AC, 0.5 / AR); t.userData.top = top; return t; };
function show(tex, c) {
  const i = Math.max(0, CH.indexOf(c));
  tex.offset.set((i % AC) / AC, 1 - (Math.floor(i / AC) + 1) / AR + (tex.userData.top ? 0.5 / AR : 0));
}

// ---------- a split-flap module: two halves, and a flap that falls from one character to the next ----------
const MW = 0.9, MH = 1.3;
const topGeo = new THREE.PlaneGeometry(MW, MH / 2).translate(0, MH / 4, 0);
const botGeo = new THREE.PlaneGeometry(MW, MH / 2).translate(0, -MH / 4, 0);
const backGeo = new THREE.PlaneGeometry(MW, MH / 2).translate(0, -MH / 4, 0).rotateX(Math.PI);
const houseGeo = new RoundedBoxGeometry(MW + 0.08, MH + 0.08, 0.22, 3, 0.035).translate(0, 0, -0.12);
const lineGeo = new THREE.BoxGeometry(MW, 0.014, 0.02);
const houseMat = new THREE.MeshStandardMaterial({ color: '#0d0c0a', roughness: 0.55, metalness: 0.2 });
const lineMat = new THREE.MeshBasicMaterial({ color: '#030303' });
const faceMat = (tex) => new THREE.MeshStandardMaterial({ map: tex, roughness: 0.42, metalness: 0.05 });
const STEP = 0.06; // one flip: 60 ms, the same as the board
class Module {
  constructor(parent, seed) {
    this.g = new THREE.Group();
    this.rnd = mulberry(seed);
    this.tex = { tS: half(true), bS: half(false), fT: half(true), fB: half(false) };
    this.mat = Object.fromEntries(Object.entries(this.tex).map(([k, t]) => [k, faceMat(t)]));
    this.g.add(new THREE.Mesh(houseGeo, houseMat), new THREE.Mesh(topGeo, this.mat.tS), new THREE.Mesh(botGeo, this.mat.bS));
    this.pivot = new THREE.Group();
    this.pivot.position.z = 0.006;
    this.pivot.add(new THREE.Mesh(topGeo, this.mat.fT), new THREE.Mesh(backGeo, this.mat.fB));
    const line = new THREE.Mesh(lineGeo, lineMat);
    line.position.z = 0.012;
    this.g.add(this.pivot, line);
    this.changes = [{ at: -1, seq: [' '], tone: '#f3ede2' }];
    parent.add(this.g);
  }
  /** From time `at`, riffle through a few letters and land on `c`. */
  to(at, c, tone = '#f3ede2', riffle = true) {
    const last = this.changes[this.changes.length - 1];
    if (at < last.at) throw new Error(`flap changes must be written in time order (${at} < ${last.at})`);
    const prev = last.seq.at(-1);
    if (prev === c && at > 0) return;
    if (!riffle) return void this.changes.push({ at, seq: [c], tone });
    const n = c === ' ' ? 2 : 4 + Math.floor(this.rnd() * 6);
    const seq = [prev, ...Array.from({ length: n - 1 }, () => CH[1 + Math.floor(this.rnd() * 36)]), c];
    this.changes.push({ at: at + this.rnd() * 0.06, seq, tone });
  }
  draw(t) {
    let k = this.changes.length - 1;
    while (k > 0 && this.changes[k].at > t) k--;
    const { at, seq, tone } = this.changes[k];
    const local = (t - at) / STEP, n = seq.length - 1;
    const i = clamp(Math.floor(local), 0, n), flipping = local >= 0 && local < n;
    const cur = seq[local < 0 ? 0 : i], next = seq[Math.min(n, i + 1)];
    show(this.tex.tS, flipping ? next : cur); show(this.tex.bS, cur); show(this.tex.fT, cur); show(this.tex.fB, next);
    this.pivot.visible = flipping;
    this.pivot.rotation.x = flipping ? -Math.PI * (local - Math.floor(local)) : 0;
    for (const m of Object.values(this.mat)) m.color.set(tone);
  }
}

// ---------- the wall: seven rows of a household's departures ----------
const COLS = 27, ROWS = 7, PX = 1.0, PY = 1.5;
const wall = new THREE.Group();
scene.add(wall);
const grid = Array.from({ length: ROWS }, (_, r) => Array.from({ length: COLS }, (_, c) => { const m = new Module(wall, 1000 + r * 100 + c); m.g.position.set((c - (COLS - 1) / 2) * PX, (3 - r) * PY, 0); return m; }));
const T = { amber: '#ffb547', go: '#8fdcaa', late: '#ff6b4a', ink: '#f3ede2', dim: '#8f887c' };
/** Write a row from time `at`: destination, time and status in their columns, everything else blank. */
function row(r, at, dest = '', time = '', status = '', tone = T.ink, stagger = 0.03) {
  const line = dest.padEnd(11).slice(0, 11) + ' ' + time.padStart(5).slice(0, 5) + ' ' + status.padEnd(9).slice(0, 9);
  [...line.padEnd(COLS)].forEach((ch, c) => grid[r][c].to(at + c * stagger, ch, c >= 18 ? tone : c >= 12 && c < 17 ? T.amber : T.ink));
}
function centred(r, at, text, tone = T.ink) {
  const s = Math.floor((COLS - text.length) / 2);
  for (let c = 0; c < COLS; c++) grid[r][c].to(at + Math.abs(c - COLS / 2) * 0.025, c >= s && c < s + text.length ? text[c - s] : ' ', tone);
}
// The departures, row by row, as the narration names them; then a household board that keeps living.
const school = W('h2', 'school'), work = W('h2', 'work'), bus = W('h2', 'bus');
row(2, school + 0.35, 'SCHOOL RUN', '', 'BOARDING', T.amber);
// As each giant module lands in its slot, the wall's own module takes over the character, without a riffle.
[...'7:52'].forEach((ch, i) => grid[2][13 + i].to(school + 0.35 + i * 0.07, ch, T.amber, false));
row(3, work, 'WORK', '8:10', 'ON TIME', T.go);
row(4, bus, 'THE BUS', '7:35', 'LAST CALL', T.late);
const amb = L.p1.start - 0.3;
row(0, amb, 'GYM', '6:20', 'DEPARTED', T.dim, 0.02);
row(1, amb + 0.4, 'GRANDMA', '11:00', 'ON TIME', T.go, 0.02);
row(5, amb + 0.8, 'PIANO', '16:15', 'ON TIME', T.go, 0.02);
row(6, amb + 1.2, 'SWIM CLASS', '17:30', 'ON TIME', T.go, 0.02);
row(2, L.p2.start + 1.2, 'SCHOOL RUN', '7:52', 'DELAYED', T.late, 0.02); // the long shower, on the big board too
row(2, L.w1.start + 3, 'SCHOOL RUN', '7:52', 'TIGHT', T.amber, 0.02);
for (let r = 0; r < ROWS; r++) if (r !== 3) row(r, W('s1', 'doorbound') + r * 0.05, '', '', '', T.ink, 0.015);
centred(3, W('s1', 'doorbound') + 0.05, 'DOORBOUND', T.ink);
row(2, L.d2.start, 'SCHOOL RUN', '7:52', 'ON TIME', T.go, 0.02);
row(2, L.d9.start + 0.3, 'SCHOOL RUN', '7:52', 'REROUTED', T.amber, 0.02);
row(2, L.d13.start, 'SCHOOL RUN', '7:49', 'DEPARTED', T.go, 0.02);
for (let r = 0; r < ROWS; r++) if (r !== 2 && r !== 4) row(r, L.c1.start - 0.4 + r * 0.04, '', '', '', T.ink, 0.012);
centred(2, L.c1.start - 0.35, 'DOORBOUND', T.ink);
centred(4, W('c1', 'time') - 0.1, 'ON TIME', T.go);

// The giant 7:52 of the opening: four modules three times the size, who later take their place in the wall.
const giant = [...'7:52'].map((ch, i) => { const m = new Module(scene, 77 + i); m.g.scale.setScalar(3); m.home = new THREE.Vector3((i - 1.5) * 3.1, 0.4, 6); m.slot = grid[2][13 + i].g.position.clone(); m.to(0.25 + i * 0.12, ch, T.amber); return m; });

// ---------- the Echo Show: it swings in, then hands over to the 2D board at exactly the same pixels ----------
const SW = 1.36, SH = 0.765, DEV = new THREE.Vector3(0, 0, 34);
const device = new THREE.Group();
const body = new THREE.Mesh(new RoundedBoxGeometry(1.408, 0.813, 0.14, 6, 0.045).translate(0, 0, -0.072), new THREE.MeshPhysicalMaterial({ color: '#1a1815', roughness: 0.38, metalness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.25 }));
const homeCanvas = Object.assign(document.createElement('canvas'), { width: 1360, height: 765 });
{
  const g = homeCanvas.getContext('2d');
  const grad = g.createRadialGradient(204, 76, 0, 204, 76, 1300);
  grad.addColorStop(0, '#2a2216'); grad.addColorStop(0.7, '#090807'); g.fillStyle = grad; g.fillRect(0, 0, 1360, 765);
  g.fillStyle = '#f3ede2'; g.font = '700 170px "Barlow Condensed"'; g.textBaseline = 'alphabetic'; g.fillText('7:12', 70, 380);
  g.fillStyle = '#8f887c'; g.font = '500 30px "Barlow"'; g.fillText('Thursday, October 22', 70, 440);
  g.fillStyle = '#f3ede2'; g.fillText('Try', 70, 510); g.fillStyle = '#ffb547'; g.fillText('"Alexa, start the school run."', 124, 510);
}
const homeTex = new THREE.CanvasTexture(homeCanvas);
homeTex.colorSpace = THREE.SRGBColorSpace;
const screen = new THREE.Mesh(new THREE.PlaneGeometry(SW, SH), new THREE.MeshBasicMaterial({ map: homeTex, toneMapped: false }));
screen.position.z = 0.001;
device.add(body, screen);
scene.add(device);
// Where the camera stands so the screen covers the 2D board's screen exactly: 1360 px wide, its centre at (960, 476.5).
const PXU = 1360 / SW, HAND = 1080 / (2 * Math.tan(THREE.MathUtils.degToRad(17.5)) * PXU);
const handPos = DEV.clone().add(new THREE.Vector3(0, -63.5 / PXU, HAND)), handLook = DEV.clone().add(new THREE.Vector3(0, -63.5 / PXU, 0));
const enter = L.s1.end - 0.55;
export const HANDOFF = L.d1.start - 0.3;

// ---------- the architecture: four slabs in space, data running between them ----------
const ARCH = new THREE.Vector3(0, 0, -70);
function labelTex(title, sub, color) {
  const c = Object.assign(document.createElement('canvas'), { width: 900, height: 510 });
  const g = c.getContext('2d');
  g.fillStyle = '#14120f'; g.fillRect(0, 0, 900, 510);
  g.strokeStyle = '#3a352d'; g.lineWidth = 6; g.strokeRect(3, 3, 894, 504);
  g.fillStyle = color; g.font = '700 150px "Barlow Condensed"'; g.fillText(title, 60, 230);
  g.fillStyle = '#8f887c'; g.font = '500 46px "Barlow"'; g.fillText(sub, 64, 330);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
const SLABS = [['Alexa+', 'The customer speaks', '#31c6f4'], ['MCP', 'Streamable HTTP · OAuth 2.1', '#f3ede2'], ['Doorbound', '17 tools, one per thing said', '#ffb547'], ['MCP App', 'ui://doorbound/board', '#8fdcaa']];
const slabGeo = new RoundedBoxGeometry(3.0, 1.7, 0.16, 4, 0.06);
const slabs = SLABS.map(([a, b, c], i) => {
  const g = new THREE.Group();
  const front = new THREE.Mesh(new THREE.PlaneGeometry(2.88, 1.63), new THREE.MeshStandardMaterial({ map: labelTex(a, b, c), roughness: 0.5, emissive: '#ffffff', emissiveIntensity: 0.18, emissiveMap: null }));
  front.material.emissiveMap = front.material.map;
  front.position.z = 0.081;
  g.add(new THREE.Mesh(slabGeo, new THREE.MeshPhysicalMaterial({ color: '#1b1814', roughness: 0.3, metalness: 0.4, clearcoat: 1 })), front);
  g.position.copy(ARCH).add(new THREE.Vector3((i - 1.5) * 3.7, Math.sin(i * 1.3) * 0.25, -Math.abs(i - 1.5) * 0.6));
  g.rotation.y = (1.5 - i) * 0.08;
  scene.add(g);
  return g;
});
const wireMat = new THREE.MeshStandardMaterial({ color: '#ffb547', emissive: '#ffb547', emissiveIntensity: 1.6 });
const wires = [0, 1, 2].map((i) => {
  const a = slabs[i].position.clone().add(new THREE.Vector3(1.5, 0, 0)), b = slabs[i + 1].position.clone().add(new THREE.Vector3(-1.5, 0, 0));
  const curve = new THREE.CatmullRomCurve3([a, a.clone().lerp(b, 0.5).add(new THREE.Vector3(0, 0.35, 0.4)), b]);
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.03, 8), wireMat);
  const packet = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), new THREE.MeshBasicMaterial({ color: '#ffe2b0', toneMapped: false }));
  scene.add(tube, packet);
  return { curve, tube, packet, count: tube.geometry.index.count };
});

// ---------- the camera, act by act ----------
const v = (x, y, z) => new THREE.Vector3(x, y, z);
const G0 = giant[0].home;
/** A camera key: where it stands and what it looks at, from time `t`. Between keys: quart in-out. */
const SHOTS = [
  [0, v(G0.x + 0.9, G0.y + 1.1, G0.z + 4.2), v(G0.x, G0.y, G0.z)],               // macro on the 7, flaps riffling
  [1.6, v(G0.x + 0.9, G0.y + 1.1, G0.z + 4.2), v(G0.x, G0.y, G0.z)],
  [L.h1.end, v(0, 0.9, 20), v(0, 0.4, 5)],                                          // back: the giant 7:52
  [school - 0.3, v(0, 0.9, 20), v(0, 0.4, 5)],
  [bus + 0.9, v(1.6, 0.4, 28), v(0.3, 0.1, 0)],                                     // the whole board, a little off axis
  [L.h2.end + 0.3, v(1.0, 0.3, 26.5), v(0.2, 0.1, 0)],
  [L.p1.start + 0.6, v(-24, 5, 21), v(6, 0, -6)],                                   // the problem: the board becomes the room
  [L.s1.start - 0.36, v(-21, 3, 15), v(8, -0.5, -6)],
  [L.s1.start - 0.35, v(0, 0, 17), v(0, 0, 0)],                                     // the reveal: square on to DOORBOUND
  [enter - 0.1, v(0, -0.4, 15.5), v(0, -0.2, 0)],
  [enter, handPos.clone().add(v(0.5, 0.25, 0.7)), handLook],                        // the Echo Show swings in
  [HANDOFF - 0.04, handPos, handLook],
  [HANDOFF - 0.03, v(-9, 2, 16), v(2, 0, -2)],                                     // behind the demo: the room again, dim
  [L.b1.start - 0.56, v(-9, 2, 16), v(2, 0, -2)],
  [L.b1.start - 0.55, ARCH.clone().add(v(-4.4, 0.7, 7.2)), ARCH.clone().add(v(-5.0, 0, 0))], // the architecture, node by node
  [W('b1', 'mcp') + 0.4, ARCH.clone().add(v(-3.4, 0.8, 9)), ARCH.clone().add(v(-3.7, 0, 0))],
  [W('b1', 'seventeen') + 0.3, ARCH.clone().add(v(1.0, 1.0, 9.5)), ARCH.clone().add(v(0.4, 0, 0))],
  [W('b1', 'app') + 0.5, ARCH.clone().add(v(0, 1.4, 12.5)), ARCH.clone().add(v(0, 0, 0))],
  [L.b2.start + 0.6, ARCH.clone().add(v(0, -3.4, 13)), ARCH.clone().add(v(0, -2.3, 0))], // up out of the way of the maths
  [L.b3.start - 0.31, ARCH.clone().add(v(0, -3.5, 13.4)), ARCH.clone().add(v(0, -2.3, 0))],
  [L.b3.start - 0.3, v(20, -9, 14), v(-2, -4.5, -3)],                                // proof and honesty: the blank lower rows
  [L.c1.start - 0.46, v(16, -8, 10), v(-1, -4.5, -3)],
  [L.c1.start - 0.45, v(0, -0.58, 20.5), v(0, -0.58, 0)],                          // DOORBOUND high, ON TIME below, room for the words
  [TL.total, v(0, -0.58, 17.5), v(0, -0.58, 0)],
];
function shoot(t) {
  let i = 0;
  while (i < SHOTS.length - 1 && t >= SHOTS[i + 1][0]) i++;
  const [ta, pa, la] = SHOTS[i], [tb, pb, lb] = SHOTS[Math.min(i + 1, SHOTS.length - 1)];
  // A cut when two keys share a moment (they are 0.05 s apart or less); otherwise a camera move.
  const x = tb - ta > 0.051 ? E.quart(prog(t, ta, tb)) : t >= tb ? 1 : 0;
  camera.position.lerpVectors(pa, pb, x);
  camera.lookAt(new THREE.Vector3().lerpVectors(la, lb, x));
}
// How bright the room is in each act: the board leads in the opening and the close, recedes behind the rest.
function exposure(t) {
  const K = [[0, 1.15], [L.h2.end, 1.15], [L.p1.start + 0.5, 0.16], [L.s1.start - 0.4, 0.16], [L.s1.start, 1.0], [enter, 1.0], [HANDOFF + 0.4, 0.3], [L.b1.start - 0.6, 0.3], [L.b1.start - 0.4, 1.1], [L.b3.start - 0.6, 1.1], [L.b3.start - 0.2, 0.22], [L.c1.start - 0.6, 0.22], [L.c1.start - 0.3, 1.15]];
  let i = 0;
  while (i < K.length - 1 && t >= K[i + 1][0]) i++;
  const [ta, a] = K[i], [tb, b] = K[Math.min(i + 1, K.length - 1)];
  return lerp(a, b, tb > ta ? E.sine(prog(t, ta, tb)) : 1);
}

// Depth of field: when 2D words lead, the board goes soft behind them; when the 3D is the hero, it is sharp.
function focus(t) {
  const K = [[0, 0], [L.h2.end, 0], [L.p1.start + 0.5, 11], [L.s1.start - 0.36, 11], [L.s1.start - 0.35, 0], [HANDOFF - 0.04, 0], [HANDOFF + 0.4, 5], [L.b1.start - 0.56, 5], [L.b1.start - 0.55, 0], [L.b3.start - 0.31, 0], [L.b3.start - 0.1, 8], [L.c1.start - 0.46, 8], [L.c1.start - 0.45, 0]];
  let i = 0;
  while (i < K.length - 1 && t >= K[i + 1][0]) i++;
  const [ta, a] = K[i], [tb, b] = K[Math.min(i + 1, K.length - 1)];
  return lerp(a, b, tb - ta > 0.051 ? E.sine(prog(t, ta, tb)) : t >= tb ? 1 : 0);
}

export function draw(t) {
  for (const r of grid) for (const m of r) m.draw(t);
  giant.forEach((m, i) => {
    m.draw(t);
    const fly = sp(t, school - 0.25 + i * 0.07, HEAVY);
    m.g.position.lerpVectors(m.home, m.slot, fly);
    m.g.scale.setScalar(lerp(3, 1, fly));
    m.g.visible = fly < 0.995; // once landed, the wall's own module shows the time
  });
  const dIn = sp(t, enter, HEAVY);
  device.visible = t >= enter - 0.05 && t < HANDOFF + 0.25;
  device.position.copy(DEV).add(v(lerp(0.9, 0, dIn), lerp(-1.3, 0, dIn), lerp(-1.6, 0, dIn)));
  device.rotation.set(lerp(0.32, 0, dIn), lerp(-0.85, 0, dIn), lerp(0.06, 0, dIn));
  wires.forEach((w, i) => {
    const at = [W('b1', 'mcp'), W('b1', 'seventeen'), W('b1', 'app')][i];
    w.tube.geometry.setDrawRange(0, Math.floor(w.count * E.quart(prog(t, at - 0.2, at + 0.6)) / 3) * 3);
    const ph = (t * 0.7 + i * 0.37) % 1;
    w.packet.visible = t > at + 0.6 && t < L.b3.start;
    w.packet.position.copy(w.curve.getPointAt(E.sine(ph)));
    w.packet.scale.setScalar(0.4 + Math.sin(Math.PI * ph));
  });
  slabs.forEach((s, i) => {
    const at = [W('b1', 'under') - 0.2, W('b1', 'mcp') - 0.1, W('b1', 'seventeen') - 0.3, W('b1', 'app') - 0.3][i];
    const x = sp(t, at, PREMIUM);
    s.visible = t > at;
    s.scale.setScalar(0.85 + 0.15 * x);
  });
  shoot(t);
  renderer.toneMappingExposure = exposure(t);
  renderer.render(scene, camera);
  const blur = focus(t);
  canvas.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : '';
}
/** Where a point in the world lands on the 1920 x 1080 frame now (for 2D labels that follow 3D objects). */
export function project(p) {
  const q = p.clone().project(camera);
  return [(q.x + 1) * 960, (1 - q.y) * 540];
}
export const slabAt = (i) => slabs[i].position.clone();
window.WORLD = { draw, project, slabAt, HANDOFF };
