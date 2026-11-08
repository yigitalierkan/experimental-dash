// A320 FLAP — tiny 8-bit flappy-style game. Canvas is 384×216 and scaled up with pixelated rendering.
import { terminalHeader } from './common.js';

terminalHeader('game', null);

const cv = document.getElementById('game');
const ctx = cv.getContext('2d');
ctx.imageSmoothingEnabled = false;
const W = cv.width, H = cv.height, GROUND = H - 18;

// ---------------------------------------------------------------- palette + sprites
const PAL = {
  T: '#1d3f9a', W: '#eef0f2', B: '#28406e', K: '#0d1424', S: '#9aa3ad', H: '#6b7480',
  G: '#c3c9d0', E: '#5d6670', F: '#ffa028', R: '#ff4b3e',
};
// generic twin-engine narrow-body airliner, facing right (32×12)
const PLANE = [
  '...TT...........................',
  '...TTT..........................',
  '...TTTT.........................',
  '...TTTTT........................',
  '..WWWWWWWWWWWWWWWWWWWWWWWWWW....',
  '.WWBWBWBWBWBWBWBWBWBWBWBWBWWWKK.',
  'HHWWWWWWWWWWWWWWWWWWWWWWWWWWWWWK',
  '.HSSSSSSSSSSSSSSSSSSSSSSSSSSSSS.',
  '...........GGGGGGGGGG...........',
  '.........GGGGGG....EEEEEE.......',
  '.......GGGG........EEEEEF.......',
  '...................EEEEEE.......',
];
const BIRD = [['.K...K.', '..K.K..', '...K...'], ['.......', 'KK.K.KK', '...K...']];

function spriteCanvas(rows, pal = PAL) {
  const c = document.createElement('canvas');
  c.width = rows[0].length; c.height = rows.length;
  const x = c.getContext('2d');
  rows.forEach((r, j) => [...r].forEach((ch, i) => { if (ch !== '.') { x.fillStyle = pal[ch] || ch; x.fillRect(i, j, 1, 1); } }));
  return c;
}
const planeImg = spriteCanvas(PLANE);
const birdImgs = BIRD.map((b) => spriteCanvas(b, { K: '#1a1a1a' }));

// ---------------------------------------------------------------- sound (WebAudio square blips)
let actx = null, muted = localStorage.getItem('a320flap:muted') === '1';
function beep(f0, f1, dur, type = 'square', vol = 0.05) {
  if (muted) return;
  actx ||= new (window.AudioContext || window.webkitAudioContext)();
  const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
  o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur);
}
const sfx = { flap: () => beep(320, 640, 0.09), score: () => { beep(660, 660, 0.06); setTimeout(() => beep(990, 990, 0.08), 70); }, crash: () => beep(400, 40, 0.5, 'sawtooth', 0.07) };

// ---------------------------------------------------------------- world
const rnd = (a, b) => a + Math.random() * (b - a);
const stars = Array.from({ length: 70 }, () => ({ x: rnd(0, W), y: rnd(0, GROUND - 40), s: Math.random() < 0.15 ? 2 : 1, tw: rnd(0, 6) }));
const skyline = (() => { const a = []; let x = 0; while (x < W * 2) { const w = rnd(10, 26) | 0, h = rnd(14, 48) | 0; a.push({ x, w, h }); x += w + (rnd(0, 4) | 0); } return { blocks: a, width: x }; })();

let hi = Number(localStorage.getItem('a320flap:hi') || 0);
const hiEl = document.getElementById('hi');
const showHi = () => { hiEl.textContent = `HI ${String(hi).padStart(3, '0')}`; };
showHi();

let st;
function reset() {
  st = {
    mode: 'ready', t: 0,
    p: { x: 70, y: H / 2 - 20, vy: 0 },
    throttle: 0, // −1..+1 from ←/→
    speed: 1.6, dist: 0, score: 0,
    obs: [], birds: [], nextObs: 140, nextBird: 900,
    crashAt: 0, flash: 0, particles: [],
  };
}
reset();

const keys = new Set();
function up() {
  if (st.mode === 'ready') { st.mode = 'play'; }
  if (st.mode === 'over') { if (performance.now() - st.crashAt > 600) reset(); return; }
  if (st.mode === 'paused') return;
  st.p.vy = -3.1; sfx.flap();
}
addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
  if ((e.key === 'ArrowUp' || e.key === ' ') && !e.repeat) up();
  if (e.key === 'p' || e.key === 'P') st.mode = st.mode === 'paused' ? 'play' : st.mode === 'play' ? 'paused' : st.mode;
  if (e.key === 'm' || e.key === 'M') { muted = !muted; localStorage.setItem('a320flap:muted', muted ? '1' : '0'); }
  keys.add(e.key);
});
addEventListener('keyup', (e) => keys.delete(e.key));
cv.addEventListener('pointerdown', (e) => { e.preventDefault(); up(); });
addEventListener('blur', () => { if (st.mode === 'play') st.mode = 'paused'; });

// ---------------------------------------------------------------- obstacles
function spawnObstacle() {
  const diff = Math.min(1, st.score / 40);
  const gap = 82 - diff * 30;
  const top = rnd(26, GROUND - gap - 22);
  const kind = Math.random() < 0.5 ? 'tower' : 'building';
  st.obs.push({ x: W + 10, w: kind === 'tower' ? 18 : 24, top, gap, kind, passed: false, seed: Math.random() });
}
function spawnBirds() {
  const y = rnd(30, GROUND - 40), n = 3 + (Math.random() * 3 | 0);
  for (let i = 0; i < n; i++) st.birds.push({ x: W + 10 + i * 9, y: y + Math.sin(i) * 6 + i * 2, ph: Math.random() * 10, vy: rnd(-0.2, 0.2) });
}

// ---------------------------------------------------------------- update
function update() {
  st.t++;
  if (st.mode !== 'play') {
    if (st.mode === 'ready') st.p.y = H / 2 - 20 + Math.sin(st.t / 18) * 6;
    if (st.mode === 'over') { st.p.vy += 0.25; st.p.y = Math.min(GROUND - 10, st.p.y + st.p.vy); }
    stepParticles();
    return;
  }
  // throttle with ←/→
  st.throttle = (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0);
  const base = 1.6 + Math.min(1.2, st.score * 0.03);
  st.speed += ((base + st.throttle * 0.8) - st.speed) * 0.05;
  st.dist += st.speed;
  // vertical
  st.p.vy += 0.17 + (keys.has('ArrowDown') ? 0.3 : 0);
  st.p.vy = Math.max(-4, Math.min(5, st.p.vy));
  st.p.y += st.p.vy;
  if (st.p.y < 4) { st.p.y = 4; st.p.vy = 0; }
  // spawn
  st.nextObs -= st.speed;
  if (st.nextObs <= 0) { spawnObstacle(); st.nextObs = 132 - Math.min(30, st.score); }
  if (st.score >= 5) { st.nextBird -= st.speed; if (st.nextBird <= 0) { spawnBirds(); st.nextBird = rnd(500, 900); } }
  for (const o of st.obs) o.x -= st.speed;
  for (const b of st.birds) { b.x -= st.speed + 0.6; b.y += Math.sin((st.t + b.ph * 10) / 10) * 0.4 + b.vy; }
  st.obs = st.obs.filter((o) => o.x + o.w > -5);
  st.birds = st.birds.filter((b) => b.x > -10);
  // contrail
  if (st.t % 2 === 0) st.particles.push({ x: st.p.x + 2, y: st.p.y + 6, life: 40, c: '#5b6470' });
  // score
  for (const o of st.obs) if (!o.passed && o.x + o.w < st.p.x) { o.passed = true; st.score++; sfx.score(); }
  // collisions (hitbox inset from sprite)
  const hb = { x: st.p.x + 2, y: st.p.y + 4, w: 28, h: 6 };
  const hit = (r) => hb.x < r.x + r.w && hb.x + hb.w > r.x && hb.y < r.y + r.h && hb.y + hb.h > r.y;
  let dead = st.p.y + 11 >= GROUND;
  for (const o of st.obs) if (hit({ x: o.x, y: 0, w: o.w, h: o.top }) || hit({ x: o.x, y: o.top + o.gap, w: o.w, h: GROUND - o.top - o.gap })) dead = true;
  for (const b of st.birds) if (hit({ x: b.x, y: b.y, w: 7, h: 3 })) dead = true;
  if (dead) crash();
  stepParticles();
}
function crash() {
  st.mode = 'over'; st.crashAt = performance.now(); st.flash = 8; sfx.crash();
  for (let i = 0; i < 40; i++) st.particles.push({ x: st.p.x + 16, y: st.p.y + 6, vx: rnd(-2, 2), vy: rnd(-2.5, 1), life: rnd(20, 50), c: ['#ffa028', '#ff4b3e', '#ffd23f', '#eee'][i % 4] });
  if (st.score > hi) { hi = st.score; localStorage.setItem('a320flap:hi', String(hi)); showHi(); st.newHi = true; }
}
function stepParticles() {
  for (const p of st.particles) { p.life--; if (p.vx != null) { p.x += p.vx; p.y += p.vy; p.vy += 0.08; } else p.x -= st.mode === 'play' ? st.speed : 0; }
  st.particles = st.particles.filter((p) => p.life > 0);
}

// ---------------------------------------------------------------- draw
function text(s, x, y, c = '#ffa028', align = 'left', size = 8) {
  ctx.font = `bold ${size}px "JetBrains Mono", Menlo, Consolas, monospace`;
  ctx.textAlign = align; ctx.textBaseline = 'top';
  ctx.fillStyle = '#000'; ctx.fillText(s, x + 1, y + 1);
  ctx.fillStyle = c; ctx.fillText(s, x, y);
}
function drawSky() {
  const bands = ['#05070f', '#070b18', '#0a1022', '#0e1530', '#141c3c', '#1b2447'];
  const bh = GROUND / bands.length;
  bands.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(0, (i * bh) | 0, W, Math.ceil(bh) + 1); });
  // dithered horizon glow
  ctx.fillStyle = '#3a2a2a';
  for (let y = GROUND - 26; y < GROUND; y += 2) for (let x = (y / 2) % 4; x < W; x += 4) ctx.fillRect(x, y, 1, 1);
  for (const s of stars) {
    if (Math.sin(st.t / 20 + s.tw) > -0.6) { ctx.fillStyle = s.s > 1 ? '#ffd23f' : '#9aa3ad'; ctx.fillRect(((s.x - st.dist * 0.05) % W + W) % W | 0, s.y | 0, s.s, s.s); }
  }
  // moon
  // pixel crescent moon
  for (let y = -6; y <= 6; y++) for (let x = -6; x <= 6; x++) {
    if (x * x + y * y <= 36 && (x - 3) * (x - 3) + (y + 1) * (y + 1) > 30) { ctx.fillStyle = '#e8e2c8'; ctx.fillRect(322 + x, 28 + y, 1, 1); }
  }
}
function drawSkyline() {
  const off = (st.dist * 0.3) % skyline.width;
  for (const b of skyline.blocks) {
    let x = b.x - off; if (x + b.w < 0) x += skyline.width; if (x > W) continue;
    ctx.fillStyle = '#0c0f1c'; ctx.fillRect(x | 0, GROUND - b.h, b.w, b.h);
    ctx.fillStyle = '#ffd23f';
    for (let wy = GROUND - b.h + 3; wy < GROUND - 3; wy += 5) for (let wx = 2; wx < b.w - 2; wx += 4) if (((b.x + wx * 7 + wy * 3) % 11) < 3) ctx.fillRect((x + wx) | 0, wy, 1, 2);
  }
}
function drawGround() {
  ctx.fillStyle = '#1b1b1b'; ctx.fillRect(0, GROUND, W, H - GROUND);
  ctx.fillStyle = '#2b2b2b'; ctx.fillRect(0, GROUND, W, 2);
  ctx.fillStyle = '#d8d8d8';
  const off = st.dist % 24;
  for (let x = -off; x < W; x += 24) ctx.fillRect(x | 0, GROUND + 8, 12, 2);
  ctx.fillStyle = '#ffa028';
  const eo = st.dist % 16;
  for (let x = -eo; x < W; x += 16) { ctx.fillRect(x | 0, GROUND + 3, 1, 1); ctx.fillRect(x | 0, GROUND + 14, 1, 1); }
}
function drawObstacle(o) {
  const x = o.x | 0, botY = (o.top + o.gap) | 0;
  // top: storm cloud column
  ctx.fillStyle = '#2a2f3a'; ctx.fillRect(x, 0, o.w, o.top | 0);
  ctx.fillStyle = '#3c4250';
  for (let y = 0; y < o.top - 4; y += 6) ctx.fillRect(x + ((y / 6) % 2 ? 2 : 0), y, o.w - 2, 3);
  ctx.fillStyle = '#4a5160'; ctx.fillRect(x - 3, (o.top | 0) - 6, o.w + 6, 6);
  ctx.fillRect(x - 1, (o.top | 0) - 9, o.w + 2, 3);
  if (((st.t + o.seed * 100) | 0) % 90 < 4) { // lightning
    ctx.fillStyle = '#ffd23f';
    const lx = x + (o.w / 2 | 0);
    ctx.fillRect(lx, o.top | 0, 1, 4); ctx.fillRect(lx - 1, (o.top | 0) + 4, 1, 3); ctx.fillRect(lx, (o.top | 0) + 7, 1, 4);
  }
  // bottom: control tower or building
  const h = GROUND - botY;
  if (o.kind === 'tower') {
    ctx.fillStyle = '#3a3f48'; ctx.fillRect(x + 5, botY + 10, o.w - 10, h - 10);           // shaft
    ctx.fillStyle = '#4b525d'; ctx.fillRect(x, botY + 2, o.w, 8);                            // cab
    ctx.fillStyle = '#4ea1ff'; ctx.fillRect(x + 2, botY + 4, o.w - 4, 3);                    // glass
    ctx.fillStyle = '#2a2f3a'; ctx.fillRect(x + 1, botY, o.w - 2, 2);                        // roof
    ctx.fillStyle = st.t % 40 < 20 ? '#ff4b3e' : '#5a1a1a'; ctx.fillRect(x + (o.w / 2 | 0), botY - 3, 1, 3); // beacon
  } else {
    ctx.fillStyle = '#262a33'; ctx.fillRect(x, botY, o.w, h);
    ctx.fillStyle = '#353a45'; ctx.fillRect(x, botY, o.w, 2);
    for (let wy = botY + 4; wy < GROUND - 2; wy += 5) for (let wx = 3; wx < o.w - 2; wx += 4) {
      ctx.fillStyle = ((wx * 13 + wy * 7 + (o.seed * 100 | 0)) % 9) < 4 ? '#ffd23f' : '#14161c'; ctx.fillRect(x + wx, wy, 2, 2);
    }
    ctx.fillStyle = st.t % 40 < 20 ? '#ff4b3e' : '#5a1a1a'; ctx.fillRect(x + 2, botY - 2, 1, 2); ctx.fillRect(x + o.w - 3, botY - 2, 1, 2);
  }
}
function drawPlane() {
  const p = st.p;
  const pitch = Math.max(-0.45, Math.min(0.6, p.vy * 0.09));
  ctx.save();
  ctx.translate((p.x + 16) | 0, (p.y + 6) | 0);
  ctx.rotate(pitch);
  ctx.drawImage(planeImg, -16, -6);
  if (st.mode === 'play' && st.t % 30 < 15) { ctx.fillStyle = '#ff4b3e'; ctx.fillRect(-12, 6, 1, 1); } // beacon
  if (st.mode === 'play' && keys.has('ArrowRight')) { ctx.fillStyle = st.t % 4 < 2 ? '#ffa028' : '#ffd23f'; ctx.fillRect(1, 4, 2, 1); } // thrust
  ctx.restore();
}
function hud() {
  text(`SCORE ${String(st.score).padStart(3, '0')}`, 6, 5);
  text(`HI ${String(hi).padStart(3, '0')}`, W - 6, 5, '#ffd23f', 'right');
  const kt = Math.round(st.speed * 140), ft = Math.max(0, Math.round((GROUND - st.p.y - 11) * 50));
  const hudTxt = `SPD ${String(kt).padStart(3, '0')}KT  ALT ${String(ft).padStart(5, ' ')}FT${muted ? '  MUTE' : ''}`;
  ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.fillRect(3, H - 13, hudTxt.length * 5.6 + 8, 11);
  text(hudTxt, 6, H - 12, '#b9b9b9');
}
function overlay() {
  if (st.mode === 'ready') {
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(0, 70, W, 64);
    text('A320 FLAP', W / 2, 78, '#ffa028', 'center', 16);
    text(st.t % 60 < 40 ? '↑ / SPACE  KALKIŞ' : '', W / 2, 102, '#e8e8e8', 'center');
    text('↓ DALIŞ   ← → GAZ   P DURAKLAT', W / 2, 116, '#7d7d7d', 'center');
  }
  if (st.mode === 'paused') { ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(0, 0, W, H); text('DURAKLATILDI', W / 2, 96, '#ffd23f', 'center', 12); }
  if (st.mode === 'over') {
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 62, W, 84);
    text('CRASH', W / 2, 70, '#ff4b3e', 'center', 16);
    text(`SKOR ${st.score}${st.newHi ? '  YENİ REKOR!' : ''}`, W / 2, 94, st.newHi ? '#ffd23f' : '#e8e8e8', 'center', 10);
    if (performance.now() - st.crashAt > 600) text(st.t % 60 < 40 ? '↑ TEKRAR' : '', W / 2, 116, '#ffa028', 'center');
  }
}
function draw() {
  drawSky(); drawSkyline();
  for (const p of st.particles) { ctx.fillStyle = p.c; ctx.globalAlpha = Math.min(1, p.life / 30); ctx.fillRect(p.x | 0, p.y | 0, 1, 1); }
  ctx.globalAlpha = 1;
  for (const o of st.obs) drawObstacle(o);
  for (const b of st.birds) ctx.drawImage(birdImgs[(st.t / 8 | 0) % 2], b.x | 0, b.y | 0);
  drawGround();
  if (st.mode !== 'over' || st.t % 4 < 2 || performance.now() - st.crashAt > 400) drawPlane();
  hud(); overlay();
  if (st.flash > 0) { ctx.fillStyle = `rgba(255,255,255,${st.flash / 10})`; ctx.fillRect(0, 0, W, H); st.flash--; }
}

// fixed 60 Hz simulation, render every frame
let acc = 0, last = performance.now();
function frame(now) {
  acc += Math.min(100, now - last); last = now;
  while (acc >= 1000 / 60) { update(); acc -= 1000 / 60; }
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__game = { get state() { return st; }, up, reset }; // handy for testing
