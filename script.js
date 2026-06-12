'use strict';
/* =====================================================================
   SINGULARITY  —  Black Hole Slots
   ---------------------------------------------------------------------
   Architecture
     1. Engine   — pure, DOM-free slot mathematics (also unit-testable
                   in Node). Produces a complete, deterministic result
                   object per spin which the UI merely "plays back".
     2. Utils    — formatting, easing, timing helpers.
     3. Audio    — synthesized WebAudio sound effects (no asset files).
     4. FX       — starfield + particle systems on two canvases.
     5. Reel     — physics-based reel animation (accelerate / cruise /
                   brake / bounce) driven by one shared rAF loop.
     6. UI       — game state, orchestration, overlays, cinematics.
   ===================================================================== */

/* =====================================================================
   1. GAME MATH ENGINE  (no DOM access — pure functions + RNG)
   ===================================================================== */
const Engine = (() => {

  const REELS = 5;
  const ROWS = 3;
  const LINE_COUNT = 20;
  const rng = () => Math.random();   // late-bound: single swap point for seeding/tests

  /* ---- Symbol definitions. pays[] is indexed by match count and is
     expressed in LINE-BET multiples (line bet = total bet / 20). ---- */
  const SYMBOLS = {
    ROCK:    { glyph: '🌑', name: 'Dark Moon',        tier: 'low',     pays: [0, 0, 0, 7, 16, 55] },
    COMET:   { glyph: '☄️', name: 'Comet',            tier: 'low',     pays: [0, 0, 0, 8, 20, 65] },
    SAT:     { glyph: '🛰️', name: 'Deep Probe',       tier: 'low',     pays: [0, 0, 0, 9, 24, 75] },
    SCOPE:   { glyph: '🔭', name: 'Observatory',      tier: 'low',     pays: [0, 0, 0, 11, 30, 90] },
    STAR:    { glyph: '⭐', name: 'Neutron Star',     tier: 'low',     pays: [0, 0, 0, 13, 38, 120] },
    PLANET:  { glyph: '🪐', name: 'Ring Giant',       tier: 'high',    pays: [0, 0, 0, 22, 60, 200] },
    ROCKET:  { glyph: '🚀', name: 'Escape Vessel',    tier: 'high',    pays: [0, 0, 0, 30, 80, 300] },
    ALIEN:   { glyph: '👽', name: 'Voidborn',         tier: 'high',    pays: [0, 0, 0, 40, 120, 500] },
    GALAXY:  { glyph: '🌌', name: 'Spiral Galaxy',    tier: 'high',    pays: [0, 0, 0, 50, 200, 1000] },
    WILD:    { glyph: '🕳️', name: 'Black Hole Wild',  tier: 'wild',    pays: [0, 0, 0, 50, 200, 1000] },
    SCATTER: { glyph: '💫', name: 'Singularity Core', tier: 'scatter', pays: [0, 0, 0, 0, 0, 0] },
  };

  /* Scatter pays are expressed in TOTAL-BET multiples (pay anywhere). */
  const SCATTER_PAYS = [0, 0, 0, 3, 15, 75];

  /* ---- 20 paylines. Each entry: row index (0 top / 2 bottom) per reel. */
  const PAYLINES = [
    [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0],
    [2, 1, 0, 1, 2], [0, 0, 1, 0, 0], [2, 2, 1, 2, 2], [1, 0, 0, 0, 1],
    [1, 2, 2, 2, 1], [0, 1, 1, 1, 0], [2, 1, 1, 1, 2], [1, 0, 1, 0, 1],
    [1, 2, 1, 2, 1], [0, 1, 0, 1, 0], [2, 1, 2, 1, 2], [1, 1, 0, 1, 1],
    [1, 1, 2, 1, 1], [0, 2, 0, 2, 0], [2, 0, 2, 0, 2], [0, 2, 2, 2, 0],
  ];

  /* ---- Weighted symbol distribution (per cell). Tuned via Monte Carlo
     simulation so total RTP lands between 94% and 97%. ---- */
  const BASE_WEIGHTS = {
    ROCK: 19, COMET: 18, SAT: 16, SCOPE: 14, STAR: 12,
    PLANET: 7, ROCKET: 5, ALIEN: 3.4, GALAXY: 2.4,
    WILD: 2.1, SCATTER: 2.6,
  };

  /* Event Horizon spins use an enriched strip: more premiums, wilds and
     scatters — "enhanced win frequency" inside the time-warp. */
  const EH_WEIGHTS = {
    ROCK: 11, COMET: 11, SAT: 11, SCOPE: 10, STAR: 10,
    PLANET: 11, ROCKET: 9, ALIEN: 7, GALAXY: 5,
    WILD: 6.5, SCATTER: 4,
  };

  /* Cascade multiplier ladders (base game / free spins). */
  const BASE_LADDER = [1, 2, 3, 5];
  const FS_LADDER   = [2, 4, 6, 10];

  const FS_AWARD = { 3: 10, 4: 15, 5: 20 };   // scatters -> free spins
  const FS_RETRIGGER = 5;                     // +5 spins on 3+ scatters in FS
  const EH_CHANCE = 1 / 150;                  // Event Horizon trigger rate
  const PLANET_CHANCE = 0.12;                 // multiplier planet per cascade
  const PLANET_TABLE = [
    { mult: 2, weight: 60 }, { mult: 3, weight: 30 }, { mult: 5, weight: 10 },
  ];

  /* Jackpots — fixed total-bet multiples with fixed hit probabilities,
     rolled once per PAID spin. EV contribution ≈ 2.0% of turnover. */
  const JACKPOTS = {
    MINI:        { mult: 10,  p: 1 / 900 },
    MAJOR:       { mult: 75,  p: 1 / 18000 },
    SINGULARITY: { mult: 750, p: 1 / 140000 },
  };

  /* ------------------------------------------------------------------
     Weighted draw tables (precomputed cumulative arrays).
  ------------------------------------------------------------------ */
  function buildTable(weightMap, excluded = []) {
    const entries = [];
    let total = 0;
    for (const [id, w] of Object.entries(weightMap)) {
      if (excluded.includes(id)) continue;
      total += w;
      entries.push({ id, cum: total });
    }
    return { entries, total };
  }

  const T_BASE    = buildTable(BASE_WEIGHTS);
  const T_BASE_NS = buildTable(BASE_WEIGHTS, ['SCATTER']);
  const T_EH      = buildTable(EH_WEIGHTS);
  const T_EH_NS   = buildTable(EH_WEIGHTS, ['SCATTER']);

  function draw(table) {
    const r = rng() * table.total;
    for (const e of table.entries) if (r < e.cum) return e.id;
    return table.entries[table.entries.length - 1].id;
  }

  function drawPlanet() {
    const total = PLANET_TABLE.reduce((a, p) => a + p.weight, 0);
    let r = rng() * total;
    for (const p of PLANET_TABLE) { r -= p.weight; if (r < 0) return p.mult; }
    return 2;
  }

  /* Random "decor" symbol for reel-strip filler while spinning (UI use). */
  function randomFiller() { return draw(T_BASE_NS); }

  /* ------------------------------------------------------------------
     Grid generation — grid[col][row]. Max one scatter per reel.
  ------------------------------------------------------------------ */
  function spinColumn(table, tableNS) {
    const col = [];
    let hasScatter = false;
    for (let r = 0; r < ROWS; r++) {
      let id = draw(table);
      if (id === 'SCATTER') {
        if (hasScatter) id = draw(tableNS);
        else hasScatter = true;
      }
      col.push(id);
    }
    return col;
  }

  function generateGrid(table, tableNS) {
    const g = [];
    for (let c = 0; c < REELS; c++) g.push(spinColumn(table, tableNS));
    return g;
  }

  const cloneGrid = (g) => g.map((c) => c.slice());
  const round2 = (n) => Math.round(n * 100) / 100;

  /* ------------------------------------------------------------------
     Payline evaluation. Wilds substitute everything except scatter.
     A run of leading wilds is also scored as its own (wild) win and
     the better of the two interpretations is paid.
  ------------------------------------------------------------------ */
  function evalLines(grid) {
    const wins = [];
    for (let li = 0; li < PAYLINES.length; li++) {
      const line = PAYLINES[li];
      const cells = line.map((row, col) => grid[col][row]);

      let lead = 0;
      while (lead < REELS && cells[lead] === 'WILD') lead++;

      let best = null;
      if (lead >= 3) {
        const pay = SYMBOLS.WILD.pays[lead];
        if (pay > 0) best = { symbol: 'WILD', count: lead, pay };
      }
      if (lead < REELS) {
        const s = cells[lead];
        if (s !== 'SCATTER') {
          let count = 0;
          for (let i = 0; i < REELS; i++) {
            if (cells[i] === s || cells[i] === 'WILD') count++;
            else break;
          }
          const pay = SYMBOLS[s].pays[count] || 0;
          if (pay > 0 && (!best || pay > best.pay)) best = { symbol: s, count, pay };
        }
      }
      if (best) {
        const positions = [];
        for (let c = 0; c < best.count; c++) positions.push({ col: c, row: line[c] });
        wins.push({ line: li, symbol: best.symbol, count: best.count, pay: best.pay, positions });
      }
    }
    return wins;
  }

  function uniquePositions(wins) {
    const set = new Set();
    for (const w of wins) for (const p of w.positions) set.add(p.col + ':' + p.row);
    return set;
  }

  /* Remove winning cells, drop survivors, refill from the top
     (refills never contain scatters — scatters pay on the initial drop). */
  function collapse(grid, removedSet, tableNS) {
    const out = [];
    for (let c = 0; c < REELS; c++) {
      const survivors = [];
      for (let r = 0; r < ROWS; r++) {
        if (!removedSet.has(c + ':' + r)) survivors.push(grid[c][r]);
      }
      const fresh = [];
      for (let k = survivors.length; k < ROWS; k++) fresh.push(draw(tableNS));
      out.push(fresh.concat(survivors));
    }
    return out;
  }

  function scatterInfo(grid) {
    const positions = [];
    for (let c = 0; c < REELS; c++)
      for (let r = 0; r < ROWS; r++)
        if (grid[c][r] === 'SCATTER') positions.push({ col: c, row: r });
    return { count: positions.length, positions };
  }

  /* ------------------------------------------------------------------
     playSpin — resolves an entire spin (all cascade steps) up-front.
     mode: 'base' | 'free'
  ------------------------------------------------------------------ */
  function playSpin({ bet, mode = 'base' }) {
    const isFree = mode === 'free';
    const eventHorizon = !isFree && rng() < EH_CHANCE;
    const table   = eventHorizon ? T_EH : T_BASE;
    const tableNS = eventHorizon ? T_EH_NS : T_BASE_NS;
    const ladder  = isFree ? FS_LADDER : BASE_LADDER;
    const lineBet = bet / LINE_COUNT;

    let grid = generateGrid(table, tableNS);
    const initialGrid = cloneGrid(grid);
    const steps = [];
    let lineWinTotal = 0;
    let guard = 0;

    while (guard++ < 40) {
      const wins = evalLines(grid);
      if (!wins.length) break;
      const mult = ladder[Math.min(steps.length, ladder.length - 1)];
      const planet = rng() < PLANET_CHANCE ? drawPlanet() : null;
      const baseSum = wins.reduce((a, w) => a + w.pay, 0) * lineBet;
      const win = round2(baseSum * mult * (planet || 1));
      const removed = uniquePositions(wins);
      const gridBefore = cloneGrid(grid);
      grid = collapse(grid, removed, tableNS);
      steps.push({
        grid: gridBefore, wins, mult, planet, win,
        removed: [...removed].map((k) => { const [c, r] = k.split(':'); return { col: +c, row: +r }; }),
        gridAfter: cloneGrid(grid),
      });
      lineWinTotal = round2(lineWinTotal + win);
    }

    const sc = scatterInfo(initialGrid);
    const scatterWin = round2((SCATTER_PAYS[Math.min(sc.count, 5)] || 0) * bet);
    const freeSpins = !isFree && sc.count >= 3 ? FS_AWARD[Math.min(sc.count, 5)] : 0;
    const retrigger = isFree && sc.count >= 3 ? FS_RETRIGGER : 0;

    return {
      bet, mode, eventHorizon, initialGrid, steps,
      finalGrid: cloneGrid(grid),
      scatter: { count: sc.count, positions: sc.positions, win: scatterWin },
      freeSpins, retrigger, lineWinTotal,
      totalWin: round2(lineWinTotal + scatterWin),
    };
  }

  /* One jackpot roll per paid spin. Returns {tier, amount} or null. */
  function rollJackpot(bet) {
    const r = rng();
    let acc = 0;
    for (const tier of ['SINGULARITY', 'MAJOR', 'MINI']) {
      acc += JACKPOTS[tier].p;
      if (r < acc) return { tier, amount: round2(JACKPOTS[tier].mult * bet) };
    }
    return null;
  }

  return {
    REELS, ROWS, LINE_COUNT,
    SYMBOLS, PAYLINES, SCATTER_PAYS, JACKPOTS,
    BASE_LADDER, FS_LADDER, FS_AWARD, FS_RETRIGGER,
    playSpin, rollJackpot, randomFiller, evalLines,
  };
})();

/* Node export for the simulation harness / tests. Ignored by browsers. */
if (typeof module !== 'undefined' && module.exports) module.exports = { Engine };

/* =====================================================================
   2. UTILS
   ===================================================================== */
const fmt = (n) =>
  Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/* Reusable number ticker: animates el.textContent from -> to. */
function animateNumber(el, from, to, dur = 700, prefix = '') {
  return new Promise((resolve) => {
    const t0 = performance.now();
    function frame(t) {
      const p = clamp((t - t0) / dur, 0, 1);
      el.textContent = prefix + fmt(from + (to - from) * easeOutCubic(p));
      if (p < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}

/* =====================================================================
   3. AUDIO — synthesized effects, created lazily on first user gesture.
   ===================================================================== */
const Audio2 = {
  ctx: null,
  enabled: true,

  ensure() {
    if (this.ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
    } catch (e) { return false; }
    return true;
  },

  tone(freq, dur = 0.15, type = 'sine', gain = 0.08, when = 0, slideTo = null) {
    if (!this.enabled || !this.ensure()) return;
    try {
      const t = this.ctx.currentTime + when;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.ctx.destination);
      o.start(t); o.stop(t + dur + 0.05);
    } catch (e) { /* audio is decorative — never break gameplay */ }
  },

  noise(dur = 0.4, gain = 0.05, when = 0) {
    if (!this.enabled || !this.ensure()) return;
    try {
      const t = this.ctx.currentTime + when;
      const len = Math.floor(this.ctx.sampleRate * dur);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 0.8;
      const g = this.ctx.createGain(); g.gain.value = gain;
      src.connect(f).connect(g).connect(this.ctx.destination);
      src.start(t);
    } catch (e) { /* noop */ }
  },

  spinStart()    { this.noise(0.5, 0.06); this.tone(160, 0.4, 'sawtooth', 0.03, 0, 90); },
  reelStop(i)    { this.tone(330 - i * 28, 0.09, 'square', 0.05); this.noise(0.06, 0.04); },
  win(level = 0) {
    const base = [523, 659, 784, 1047];
    base.slice(0, 2 + level).forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.07, i * 0.09));
  },
  absorb()       { this.tone(900, 0.5, 'sine', 0.06, 0, 70); this.noise(0.35, 0.05); },
  cascadeDrop()  { this.tone(220, 0.12, 'triangle', 0.05); },
  planet()       { this.tone(440, 0.12, 'sine', 0.07); this.tone(880, 0.25, 'sine', 0.07, 0.1); },
  scatter()      { [880, 1109, 1319, 1760].forEach((f, i) => this.tone(f, 0.22, 'sine', 0.06, i * 0.08)); },
  horizon()      { this.tone(60, 1.6, 'sine', 0.09, 0, 38); this.tone(220, 1.4, 'sawtooth', 0.02, 0, 110); },
  jackpot()      { [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => this.tone(f, 0.3, 'triangle', 0.08, i * 0.12)); },
  singularity()  {
    this.tone(50, 2.4, 'sine', 0.12, 0, 28);
    this.noise(1.6, 0.08);
    [392, 523, 659, 784, 1047, 1319, 1568, 2093].forEach((f, i) => this.tone(f, 0.45, 'triangle', 0.08, 1.5 + i * 0.13));
  },
};

/* =====================================================================
   4. FX — starfield (behind UI) + particle layer (above UI).
   Stars near the hole spiral inward and are consumed: the black hole
   visibly bends the whole scene, not just the reels.
   ===================================================================== */
const FX = (() => {
  let starC, starX, fxC, fxX;
  let W = 0, H = 0, dpr = 1;
  let stars = [];
  let parts = [];
  let hole = { x: 0, y: 0, r: 60 };
  let reduced = false;

  function init(starCanvas, fxCanvas) {
    starC = starCanvas; fxC = fxCanvas;
    starX = starC.getContext('2d'); fxX = fxC.getContext('2d');
    reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    resize();
    window.addEventListener('resize', resize);
    seedStars();
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    for (const c of [starC, fxC]) {
      c.width = W * dpr; c.height = H * dpr;
      c.style.width = W + 'px'; c.style.height = H + 'px';
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    seedStars();
  }

  function seedStars() {
    const n = reduced ? 50 : Math.min(220, Math.floor((W * H) / 9000));
    stars = [];
    for (let i = 0; i < n; i++) stars.push(newStar(true));
  }

  function newStar(anywhere) {
    return {
      x: Math.random() * W,
      y: anywhere ? Math.random() * H : (Math.random() < 0.5 ? -4 : Math.random() * H),
      z: 0.3 + Math.random() * 0.7,
      tw: Math.random() * Math.PI * 2,
    };
  }

  function setHole(x, y, r) { hole.x = x; hole.y = y; hole.r = r; }
  function holeCenter() { return { x: hole.x, y: hole.y }; }

  /* ---------------- particles ---------------- */
  function add(p) { if (parts.length < 1200) parts.push(p); }

  /* Winning-symbol matter streaming into the black hole. */
  function absorbBurst(x, y, color, n = 14) {
    n = reduced ? Math.ceil(n / 3) : n;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      add({
        kind: 'absorb', x: x + Math.cos(a) * 8, y: y + Math.sin(a) * 8,
        vx: Math.cos(a) * 40, vy: Math.sin(a) * 40,
        life: 1.6 + Math.random() * 0.5, age: 0,
        size: 1.5 + Math.random() * 2.5, color,
      });
    }
  }

  function sparkBurst(x, y, color, n = 26, speed = 220) {
    n = reduced ? Math.ceil(n / 3) : n;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random());
      add({
        kind: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        life: 0.5 + Math.random() * 0.7, age: 0,
        size: 1 + Math.random() * 2.5, color,
      });
    }
  }

  function coinShower(x, y, n = 40) {
    n = reduced ? Math.ceil(n / 3) : n;
    for (let i = 0; i < n; i++) {
      add({
        kind: 'coin', x: x + (Math.random() - 0.5) * 160, y,
        vx: (Math.random() - 0.5) * 260, vy: -260 - Math.random() * 320,
        life: 1.8 + Math.random(), age: 0,
        size: 2.5 + Math.random() * 3, color: Math.random() < 0.6 ? '#ffd966' : '#ffb347',
      });
    }
  }

  function shockwave(x, y, color = '#ffb347') {
    add({ kind: 'ring', x, y, r: 10, life: 0.9, age: 0, color });
  }

  /* Full-screen galaxy explosion for the Singularity jackpot. */
  function galaxyExplosion(x, y) {
    const colors = ['#ffd966', '#ffb347', '#ff7a1a', '#d946ef', '#8b5cf6', '#67e8f9', '#ffffff'];
    const n = reduced ? 120 : 420;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 120 + Math.random() * 620;
      add({
        kind: 'galaxy', x, y,
        vx: Math.cos(a) * v - Math.sin(a) * v * 0.45,
        vy: Math.sin(a) * v + Math.cos(a) * v * 0.45,
        life: 1.4 + Math.random() * 1.6, age: 0,
        size: 1 + Math.random() * 3.5,
        color: colors[(Math.random() * colors.length) | 0],
      });
    }
    shockwave(x, y, '#ffffff');
    shockwave(x, y, '#d946ef');
  }

  /* ---------------- frame update ---------------- */
  function tick(dt) {
    if (!starX) return;
    /* stars */
    starX.clearRect(0, 0, W, H);
    for (const s of stars) {
      s.tw += dt * 2;
      const dx = hole.x - s.x, dy = hole.y - s.y;
      const d = Math.hypot(dx, dy);
      const pull = hole.r * 3.2;
      if (d < pull && d > 1) {
        /* gravitational spiral toward the singularity */
        const f = (1 - d / pull) * 60 * s.z;
        s.x += (dx / d) * f * dt + (-dy / d) * f * 1.6 * dt;
        s.y += (dy / d) * f * dt + (dx / d) * f * 1.6 * dt;
        if (d < hole.r * 0.55) Object.assign(s, newStar(false));
      } else {
        s.x += 3 * s.z * dt;
        if (s.x > W + 4) s.x = -4;
      }
      const a = 0.25 + 0.55 * Math.abs(Math.sin(s.tw)) * s.z;
      starX.globalAlpha = a;
      starX.fillStyle = '#cfd8ff';
      starX.fillRect(s.x, s.y, s.z * 1.7, s.z * 1.7);
    }
    starX.globalAlpha = 1;

    /* particles */
    fxX.clearRect(0, 0, W, H);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.age += dt;
      if (p.age >= p.life) { parts.splice(i, 1); continue; }
      const t = p.age / p.life;

      if (p.kind === 'absorb') {
        const dx = hole.x - p.x, dy = hole.y - p.y;
        const d = Math.max(8, Math.hypot(dx, dy));
        p.vx += (dx / d) * 1400 * dt + (-dy / d) * 460 * dt;
        p.vy += (dy / d) * 1400 * dt + (dx / d) * 460 * dt;
        p.vx *= 0.985; p.vy *= 0.985;
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (d < hole.r * 0.5) { parts.splice(i, 1); continue; }
      } else if (p.kind === 'spark' || p.kind === 'galaxy') {
        p.vx *= 0.985; p.vy *= 0.985;
        if (p.kind === 'galaxy') p.vy += 30 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
      } else if (p.kind === 'coin') {
        p.vy += 760 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
      } else if (p.kind === 'ring') {
        p.r += 900 * dt;
        fxX.globalAlpha = 1 - t;
        fxX.strokeStyle = p.color;
        fxX.lineWidth = 3 * (1 - t) + 0.5;
        fxX.beginPath(); fxX.arc(p.x, p.y, p.r, 0, Math.PI * 2); fxX.stroke();
        continue;
      }
      fxX.globalAlpha = 1 - t;
      fxX.fillStyle = p.color;
      fxX.beginPath(); fxX.arc(p.x, p.y, p.size * (1 - t * 0.5), 0, Math.PI * 2); fxX.fill();
    }
    fxX.globalAlpha = 1;
  }

  return { init, tick, setHole, holeCenter, absorbBurst, sparkBurst, coinShower, shockwave, galaxyExplosion };
})();

/* =====================================================================
   5. REEL — strip-scrolling physics. One shared rAF loop ticks all reels.
   States: idle → accel → cruise → braking → (bounce) → idle.
   ===================================================================== */
const ReelCfg = {
  ACCEL: 5200,          // px/s²
  VMAX_CELLS: 13.5,     // top speed, in cell-heights per second
  BRAKE: 3.0,           // proportional braking constant (1/s)
  MINV_CELLS: 3.2,      // minimum landing speed
  FILLERS: 3,           // random symbols before the final ones land
};

class Reel {
  constructor(root, index) {
    this.root = root;
    this.index = index;
    this.strip = document.createElement('div');
    this.strip.className = 'strip';
    root.appendChild(this.strip);
    this.symbols = [];
    for (let i = 0; i < 5; i++) this.symbols.push(Engine.randomFiller());
    this.offset = 0;
    this.v = 0;
    this.state = 'idle';
    this.pending = null;
    this._landed = false;
    this._resolve = null;
    this.render();
  }

  cellH() { return UI.cellH || 96; }

  makeCell(id) {
    const d = document.createElement('div');
    d.className = 'cell';
    d.dataset.sym = id;
    const s = document.createElement('span');
    s.className = 'sym';
    s.textContent = Engine.SYMBOLS[id].glyph;
    d.appendChild(s);
    return d;
  }

  render() {
    this.strip.innerHTML = '';
    for (const id of this.symbols) this.strip.appendChild(this.makeCell(id));
    this.apply();
  }

  apply() {
    this.strip.style.transform = `translate3d(0, ${this.offset - this.cellH()}px, 0)`;
  }

  visibleCells() { return Array.from(this.strip.children).slice(1, 4); }

  /* Instantly show a column (used for cascades / restoring state). */
  setColumn(col, dropInfo = null) {
    this.symbols = [Engine.randomFiller(), ...col, Engine.randomFiller()];
    this.offset = 0;
    this.render();
    if (dropInfo && dropInfo.removed > 0) {
      const fall = dropInfo.removed * this.cellH();
      this.visibleCells().forEach((cell, r) => {
        cell.style.setProperty('--fall', fall + 'px');
        cell.style.animationDelay = (r * 45) + 'ms';
        cell.classList.add('drop');
        cell.addEventListener('animationend', () => cell.classList.remove('drop'), { once: true });
      });
    }
  }

  startSpin() {
    this.state = 'accel';
    this.v = 0;
    this.pending = null;
    this._landed = false;
    this.root.classList.add('spinning');
    this.root.classList.remove('anticipate');
  }

  /* Queue the landing sequence. pending is consumed top-first; the last
     four entries guarantee the final visible column = finalCol. */
  stopWith(finalCol) {
    const f = Engine.randomFiller;
    const fillers = [];
    for (let i = 0; i < ReelCfg.FILLERS; i++) fillers.push(f());
    this.pending = [...fillers, f(), finalCol[2], finalCol[1], finalCol[0], f()];
    this.state = 'braking';
    return new Promise((res) => { this._resolve = res; });
  }

  cycle() {
    if (this.pending && this.pending.length) {
      this.symbols.unshift(this.pending.shift());
      if (this.pending.length === 0) this._landed = true;
    } else {
      this.symbols.unshift(Engine.randomFiller());
    }
    this.symbols.pop();
    this.render();
  }

  land() {
    this.offset = 0;
    this.v = 0;
    this.state = 'idle';
    this.apply();
    this.root.classList.remove('spinning', 'anticipate');
    this.strip.classList.add('bounce');
    this.strip.addEventListener('animationend', () => this.strip.classList.remove('bounce'), { once: true });
    Audio2.reelStop(this.index);
    if (this._resolve) { this._resolve(); this._resolve = null; }
  }

  tick(dt) {
    if (this.state === 'idle') return;
    const h = this.cellH();
    const slow = UI.slowMo || 1;
    const eff = dt / slow;
    const VMAX = ReelCfg.VMAX_CELLS * h;

    if (this.state === 'accel') {
      this.v = Math.min(VMAX, this.v + ReelCfg.ACCEL * eff);
      if (this.v >= VMAX) this.state = 'cruise';
    } else if (this.state === 'braking' && this.pending) {
      const remaining = this.pending.length * h - this.offset;
      this.v = Math.max(ReelCfg.MINV_CELLS * h, Math.min(this.v, remaining * ReelCfg.BRAKE));
    }

    this.offset += this.v * eff;
    while (this.offset >= h && !this._landed) {
      this.offset -= h;
      this.cycle();
    }
    if (this._landed) { this.land(); return; }
    this.apply();
  }
}

/* =====================================================================
   6. UI — state, orchestration, overlays, cinematics.
   ===================================================================== */
const BET_STEPS = [
  0.20, 0.40, 0.60, 0.80, 1.00, 1.20, 1.60, 2.00, 2.40, 3.00,
  4.00, 5.00, 6.00, 8.00, 10.00, 12.00, 16.00, 20.00, 25.00,
  30.00, 40.00, 50.00, 60.00, 80.00, 100.00,
];

const UI = {
  balance: 1000.00,
  betIndex: BET_STEPS.indexOf(1.00),
  busy: false,
  inFreeSpins: false,
  slowMo: 1,
  cellH: 96,
  reels: [],
  els: {},
  lastTime: 0,
};

function $(sel) { return document.querySelector(sel); }

function setMsg(text, tone = '') {
  const m = UI.els.msg;
  m.textContent = text;
  m.className = 'msg' + (tone ? ' ' + tone : '');
  m.classList.remove('flash');
  void m.offsetWidth; // restart animation
  m.classList.add('flash');
}

function currentBet() { return BET_STEPS[UI.betIndex]; }

function updateBalance(animateFrom = null) {
  const el = UI.els.balance;
  if (animateFrom !== null) animateNumber(el, animateFrom, UI.balance, 800);
  else el.textContent = fmt(UI.balance);
}

function updateBetDisplay() {
  UI.els.bet.textContent = fmt(currentBet());
  const b = currentBet();
  UI.els.jpMini.textContent = fmt(Engine.JACKPOTS.MINI.mult * b);
  UI.els.jpMajor.textContent = fmt(Engine.JACKPOTS.MAJOR.mult * b);
  UI.els.jpSing.textContent = fmt(Engine.JACKPOTS.SINGULARITY.mult * b);
  UI.els.betMinus.disabled = UI.betIndex === 0 || UI.busy;
  UI.els.betPlus.disabled = UI.betIndex === BET_STEPS.length - 1 || UI.busy;
}

function changeBet(delta) {
  if (UI.busy) return;
  UI.betIndex = clamp(UI.betIndex + delta, 0, BET_STEPS.length - 1);
  updateBetDisplay();
  Audio2.tone(500 + UI.betIndex * 14, 0.06, 'square', 0.04);
}

function setControlsLocked(locked) {
  UI.els.spin.disabled = locked;
  UI.els.betMinus.disabled = locked || UI.betIndex === 0;
  UI.els.betPlus.disabled = locked || UI.betIndex === BET_STEPS.length - 1;
  UI.els.maxBet.disabled = locked;
}

/* ------------------------------------------------------------------
   Geometry helpers — everything flies toward the black hole core.
------------------------------------------------------------------ */
function holeRectCenter() {
  const r = UI.els.holeCore.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 };
}

function syncHoleToFX() {
  const c = holeRectCenter();
  FX.setHole(c.x, c.y, Math.max(40, c.r));
}

function measureCells() {
  const cell = document.querySelector('.cell');
  if (cell) UI.cellH = cell.offsetHeight;
  document.documentElement.style.setProperty('--cell-h-px', UI.cellH + 'px');
}

function holePulse(strength = 1) {
  const h = UI.els.hole;
  h.classList.remove('pulse', 'pulse-big');
  void h.offsetWidth;
  h.classList.add(strength > 1 ? 'pulse-big' : 'pulse');
}

/* ------------------------------------------------------------------
   Payline win presentation
------------------------------------------------------------------ */
const LINE_COLORS = ['#ffd966', '#67e8f9', '#d946ef', '#8b5cf6', '#ff7a1a', '#7CFC9B'];

function cellCenter(col, row) {
  const reel = UI.reels[col];
  const cell = reel.visibleCells()[row];
  const cr = cell.getBoundingClientRect();
  const lr = UI.els.lineLayer.getBoundingClientRect();
  return { x: cr.left + cr.width / 2 - lr.left, y: cr.top + cr.height / 2 - lr.top };
}

function drawWinLines(wins) {
  const svg = UI.els.lineLayer;
  const lr = svg.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${lr.width} ${lr.height}`);
  svg.innerHTML = '';
  wins.forEach((w, i) => {
    const pts = w.positions.map((p) => {
      const c = cellCenter(p.col, p.row);
      return `${c.x},${c.y}`;
    }).join(' ');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', pts);
    poly.setAttribute('class', 'winline');
    poly.style.stroke = LINE_COLORS[i % LINE_COLORS.length];
    poly.style.animationDelay = (i * 60) + 'ms';
    svg.appendChild(poly);
  });
}

function clearWinLines() { UI.els.lineLayer.innerHTML = ''; }

/* ------------------------------------------------------------------
   Multiplier planet flight: a clone leaves orbit, slams into the board.
------------------------------------------------------------------ */
async function planetFly(mult) {
  const src = document.querySelector(`.m-planet[data-mult="${mult}"]`) ||
              document.querySelector('.m-planet');
  const board = UI.els.reelhouse.getBoundingClientRect();
  const from = src.getBoundingClientRect();
  src.classList.add('charging');

  const ghost = document.createElement('div');
  ghost.className = 'planet-ghost m' + mult;
  ghost.textContent = '×' + mult;
  ghost.style.left = (from.left + from.width / 2) + 'px';
  ghost.style.top = (from.top + from.height / 2) + 'px';
  document.body.appendChild(ghost);
  Audio2.planet();

  await sleep(30);
  ghost.style.left = (board.left + board.width / 2) + 'px';
  ghost.style.top = (board.top + board.height / 2) + 'px';
  ghost.classList.add('arrive');
  await sleep(620 * UI.slowMo);

  FX.sparkBurst(board.left + board.width / 2, board.top + board.height / 2,
    mult >= 5 ? '#d946ef' : '#ffb347', 40, 320);
  FX.shockwave(board.left + board.width / 2, board.top + board.height / 2, '#d946ef');
  ghost.classList.add('burst');
  await sleep(420 * UI.slowMo);
  ghost.remove();
  src.classList.remove('charging');
}

/* ------------------------------------------------------------------
   Cascade step playback: highlight → spaghettify into the hole → drop.
------------------------------------------------------------------ */
const SYM_COLORS = {
  ROCK: '#8d97b3', COMET: '#67e8f9', SAT: '#9fb4ff', SCOPE: '#b48cff',
  STAR: '#ffd966', PLANET: '#ffb347', ROCKET: '#ff7a1a', ALIEN: '#7CFC9B',
  GALAXY: '#d946ef', WILD: '#ffffff', SCATTER: '#ffd966',
};

async function playStep(step, runningTotal) {
  const slow = UI.slowMo;

  /* 1) Highlight winning cells + draw the paylines. */
  drawWinLines(step.wins);
  const winningCells = [];
  for (const p of step.removed) {
    const cell = UI.reels[p.col].visibleCells()[p.row];
    cell.classList.add('hit');
    winningCells.push({ cell, pos: p });
  }
  if (step.mult > 1) {
    UI.els.cascadeMult.textContent = '×' + step.mult;
    UI.els.cascadeMult.classList.add('show');
  }
  Audio2.win(Math.min(2, step.wins.length - 1));
  await sleep(620 * slow);

  /* 2) Multiplier planet strike (if drawn). */
  if (step.planet) await planetFly(step.planet);

  /* 3) Spaghettification — stretch toward the hole, shatter, absorb. */
  const hc = holeRectCenter();
  Audio2.absorb();
  for (const { cell } of winningCells) {
    const cr = cell.getBoundingClientRect();
    const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    cell.style.setProperty('--tx', (hc.x - cx) + 'px');
    cell.style.setProperty('--ty', (hc.y - cy) + 'px');
    cell.classList.add('absorb');
    FX.absorbBurst(cx, cy, SYM_COLORS[cell.dataset.sym] || '#ffd966', 14);
  }
  holePulse(step.win >= currentBet() * 10 ? 2 : 1);
  await sleep(700 * slow);
  clearWinLines();

  /* 4) Win amount ticks up on the win bar. */
  UI.els.winLabel.textContent = step.mult > 1 ? `CASCADE ×${step.mult}` : 'WIN';
  UI.els.winbar.classList.add('show');
  await animateNumber(UI.els.winAmount, runningTotal, runningTotal + step.win, 520);

  /* 5) Collapse: survivors drop, fresh matter falls in from above. */
  const removedPerCol = new Array(Engine.REELS).fill(0);
  for (const p of step.removed) removedPerCol[p.col]++;
  Audio2.cascadeDrop();
  for (let c = 0; c < Engine.REELS; c++) {
    UI.reels[c].setColumn(step.gridAfter[c], { removed: removedPerCol[c] });
  }
  UI.els.cascadeMult.classList.remove('show');
  await sleep(430 * slow);
  return runningTotal + step.win;
}

/* ------------------------------------------------------------------
   Full spin playback (used by base game and free spins).
------------------------------------------------------------------ */
async function spinReels(result) {
  Audio2.spinStart();
  clearWinLines();
  UI.els.winbar.classList.remove('show');
  UI.els.winAmount.textContent = fmt(0);

  /* launch */
  for (let i = 0; i < UI.reels.length; i++) {
    setTimeout(() => UI.reels[i].startSpin(), i * 70 * UI.slowMo);
  }
  await sleep((650 + 70 * UI.reels.length) * UI.slowMo);

  /* staggered, sequential stops with scatter anticipation */
  let scattersSoFar = 0;
  for (let i = 0; i < UI.reels.length; i++) {
    if (scattersSoFar >= 2 && i >= 2) {
      UI.reels[i].root.classList.add('anticipate');
      Audio2.tone(700 + i * 60, 0.4, 'sine', 0.05);
      await sleep(680 * UI.slowMo);
    }
    const col = result.initialGrid[i];
    await UI.reels[i].stopWith(col);
    scattersSoFar += col.filter((s) => s === 'SCATTER').length;
    await sleep(150 * UI.slowMo);
  }
}

async function playOutSpin(result) {
  await spinReels(result);

  /* Scatter hit flash (before cascades read better visually). */
  if (result.scatter.count >= 3) {
    Audio2.scatter();
    for (const p of result.scatter.positions) {
      UI.reels[p.col].visibleCells()[p.row].classList.add('scatter-hit');
    }
    setMsg(`${result.scatter.count} SINGULARITY CORES — GRAVITY WELL OPENS`, 'gold');
    await sleep(1100);
  }

  /* Cascades */
  let running = 0;
  for (const step of result.steps) {
    running = await playStep(step, running);
  }

  if (result.scatter.win > 0) {
    UI.els.winLabel.textContent = 'SCATTER PAY';
    UI.els.winbar.classList.add('show');
    await animateNumber(UI.els.winAmount, running, running + result.scatter.win, 520);
  }

  document.querySelectorAll('.scatter-hit').forEach((c) => c.classList.remove('scatter-hit'));
  return result.totalWin;
}

/* ------------------------------------------------------------------
   Big win celebration tiers
------------------------------------------------------------------ */
async function maybeBigWin(win, bet) {
  const x = win / bet;
  if (x < 15) return;
  const tier = x >= 100 ? 'COSMIC WIN' : x >= 40 ? 'MEGA WIN' : 'BIG WIN';
  const ov = UI.els.bigwin;
  ov.querySelector('.bw-title').textContent = tier;
  ov.classList.add('open', x >= 100 ? 't3' : x >= 40 ? 't2' : 't1');
  Audio2.jackpot();
  const center = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  FX.coinShower(center.x, center.y - 60, x >= 100 ? 90 : 50);
  FX.sparkBurst(center.x, center.y, '#ffd966', 60, 380);
  const amountEl = ov.querySelector('.bw-amount');
  let skipped = false;
  const skip = () => { skipped = true; };
  ov.addEventListener('click', skip, { once: true });
  await animateNumber(amountEl, 0, win, 1600);
  for (let w = 0; w < 12 && !skipped; w++) await sleep(100);
  ov.removeEventListener('click', skip);
  ov.classList.remove('open', 't1', 't2', 't3');
}

/* ------------------------------------------------------------------
   Event Horizon mode — time dilation for one spin.
------------------------------------------------------------------ */
function enterEventHorizon() {
  UI.slowMo = 1.9;
  document.body.classList.add('event-horizon');
  UI.els.ehBanner.classList.add('show');
  Audio2.horizon();
  setMsg('EVENT HORIZON — TIME DILATES, ODDS BEND', 'violet');
}

function exitEventHorizon() {
  UI.slowMo = 1;
  document.body.classList.remove('event-horizon');
  UI.els.ehBanner.classList.remove('show');
}

/* ------------------------------------------------------------------
   Jackpots
------------------------------------------------------------------ */
async function jackpotSequence(jp) {
  if (jp.tier === 'SINGULARITY') return singularitySequence(jp.amount);
  const ov = UI.els.jackpotOverlay;
  ov.querySelector('.jp-title').textContent = jp.tier + ' JACKPOT';
  ov.className = 'overlay jackpot open ' + jp.tier.toLowerCase();
  Audio2.jackpot();
  FX.coinShower(window.innerWidth / 2, window.innerHeight / 2 - 80, jp.tier === 'MAJOR' ? 90 : 50);
  FX.shockwave(window.innerWidth / 2, window.innerHeight / 2, '#ffd966');
  await animateNumber(ov.querySelector('.jp-amount-big'), 0, jp.amount, 1500);
  await new Promise((res) => {
    const done = () => { clearTimeout(t); res(); };
    const t = setTimeout(done, 2600);
    ov.addEventListener('click', done, { once: true });
  });
  ov.classList.remove('open');
}

/* The grand cinematic: the UI itself falls past the event horizon. */
async function singularitySequence(amount) {
  const body = document.body;
  Audio2.singularity();
  setMsg('CRITICAL MASS — SINGULARITY COLLAPSE', 'violet');

  body.classList.add('sing-prelude');                 // rumble
  const hc = holeRectCenter();
  FX.shockwave(hc.x, hc.y, '#d946ef');
  await sleep(1000);

  body.classList.remove('sing-prelude');
  body.classList.add('sing-collapse');                // reels fall into the hole
  const rh = UI.els.reelhouse.getBoundingClientRect();
  for (let i = 0; i < 7; i++) {
    FX.absorbBurst(rh.left + Math.random() * rh.width, rh.top + Math.random() * rh.height, '#ffd966', 16);
  }
  await sleep(1700);

  body.classList.add('sing-flash');                   // white-out
  await sleep(380);
  FX.galaxyExplosion(window.innerWidth / 2, window.innerHeight / 2);
  body.classList.remove('sing-flash');

  const ov = UI.els.singOverlay;
  ov.classList.add('open');
  await animateNumber(ov.querySelector('.sing-amount'), 0, amount, 2200);
  await new Promise((res) => {
    const done = () => { clearTimeout(t); res(); };
    const t = setTimeout(done, 5200);
    ov.addEventListener('click', done, { once: true });
  });

  /* Safe return to gameplay: rebuild the board, fade everything back. */
  ov.classList.remove('open');
  body.classList.remove('sing-collapse');
  body.classList.add('sing-return');
  setTimeout(() => body.classList.remove('sing-return'), 1300);
  setMsg('REALITY RESTORED — SPIN AGAIN', 'gold');
}

/* ------------------------------------------------------------------
   Free spins
------------------------------------------------------------------ */
async function runFreeSpins(initialCount, bet) {
  UI.inFreeSpins = true;
  document.body.classList.add('free-spins');
  const intro = UI.els.fsIntro;
  intro.querySelector('.fs-n').textContent = initialCount;
  intro.classList.add('open');
  Audio2.scatter();
  await new Promise((res) => {
    const done = () => { clearTimeout(t); res(); };
    const t = setTimeout(done, 3200);
    intro.addEventListener('click', done, { once: true });
  });
  intro.classList.remove('open');

  let remaining = initialCount;
  let totalWin = 0;
  let spinsPlayed = 0;
  UI.els.fsBadge.classList.add('show');

  while (remaining > 0) {
    remaining--;
    spinsPlayed++;
    UI.els.fsCount.textContent = remaining;
    UI.els.fsTotal.textContent = fmt(totalWin);
    setMsg(`FREE SPIN ${spinsPlayed} — MULTIPLIERS DOUBLED`, 'violet');

    const res = Engine.playSpin({ bet, mode: 'free' });
    await playOutSpin(res);

    if (res.totalWin > 0) {
      const before = UI.balance;
      UI.balance = Math.round((UI.balance + res.totalWin) * 100) / 100;
      totalWin = Math.round((totalWin + res.totalWin) * 100) / 100;
      updateBalance(before);
      UI.els.fsTotal.textContent = fmt(totalWin);
    }
    if (res.retrigger) {
      remaining += res.retrigger;
      UI.els.fsCount.textContent = remaining;
      setMsg(`RETRIGGER! +${res.retrigger} FREE SPINS`, 'gold');
      Audio2.scatter();
      await sleep(1000);
    }
    await maybeBigWin(res.totalWin, bet);
    await sleep(420);
  }

  UI.els.fsBadge.classList.remove('show');
  document.body.classList.remove('free-spins');
  UI.inFreeSpins = false;

  const outro = UI.els.fsOutro;
  outro.querySelector('.fs-won').textContent = fmt(totalWin);
  outro.classList.add('open');
  Audio2.jackpot();
  FX.coinShower(window.innerWidth / 2, window.innerHeight / 2 - 60, 60);
  await new Promise((res) => {
    const done = () => { clearTimeout(t); res(); };
    const t = setTimeout(done, 3400);
    outro.addEventListener('click', done, { once: true });
  });
  outro.classList.remove('open');
}

/* ------------------------------------------------------------------
   The main spin entry point.
------------------------------------------------------------------ */
async function doSpin() {
  if (UI.busy) return;
  const bet = currentBet();

  if (UI.balance < bet) {
    setMsg('INSUFFICIENT CREDITS — LOWER YOUR BET', 'warn');
    UI.els.controls.classList.remove('shake');
    void UI.els.controls.offsetWidth;
    UI.els.controls.classList.add('shake');
    if (UI.balance < BET_STEPS[0]) UI.els.brokeOverlay.classList.add('open');
    return;
  }

  UI.busy = true;
  setControlsLocked(true);
  UI.els.spin.classList.add('spinning');

  try {
    /* charge the bet */
    const beforeBal = UI.balance;
    UI.balance = Math.round((UI.balance - bet) * 100) / 100;
    updateBalance(beforeBal);
    setMsg('THE VOID IS WATCHING…');

    /* resolve outcome + jackpot roll up-front, then play it back */
    const jackpot = Engine.rollJackpot(bet);
    const result = Engine.playSpin({ bet, mode: 'base' });

    if (result.eventHorizon) enterEventHorizon();

    await playOutSpin(result);

    if (result.totalWin > 0) {
      const before = UI.balance;
      UI.balance = Math.round((UI.balance + result.totalWin) * 100) / 100;
      updateBalance(before);
      setMsg(`THE VOID GIVES BACK — WIN ${fmt(result.totalWin)}`, 'gold');
    } else {
      setMsg('ABSORBED BY THE DARK. SPIN AGAIN.');
    }

    if (result.eventHorizon) exitEventHorizon();

    await maybeBigWin(result.totalWin, bet);

    if (result.freeSpins > 0) {
      await runFreeSpins(result.freeSpins, bet);
    }

    if (jackpot) {
      await jackpotSequence(jackpot);
      const before = UI.balance;
      UI.balance = Math.round((UI.balance + jackpot.amount) * 100) / 100;
      updateBalance(before);
      setMsg(`${jackpot.tier} JACKPOT PAID — ${fmt(jackpot.amount)}`, 'gold');
    }

    if (UI.balance < BET_STEPS[0]) {
      await sleep(700);
      UI.els.brokeOverlay.classList.add('open');
    }
  } catch (err) {
    /* Never strand the machine in a locked state. */
    console.error('Spin error:', err);
    exitEventHorizon();
    setMsg('GRAVITATIONAL ANOMALY — PLEASE SPIN AGAIN', 'warn');
  } finally {
    UI.busy = false;
    UI.els.spin.classList.remove('spinning');
    setControlsLocked(false);
    updateBetDisplay();
  }
}

/* ------------------------------------------------------------------
   Paytable / info modal content (generated from engine data).
------------------------------------------------------------------ */
function buildInfoModal() {
  const body = UI.els.infoBody;
  const order = ['GALAXY', 'WILD', 'ALIEN', 'ROCKET', 'PLANET', 'STAR', 'SCOPE', 'SAT', 'COMET', 'ROCK'];
  let html = '<h3>Symbol Pays <small>(× line bet — line bet = total bet ÷ 20)</small></h3><div class="pay-grid">';
  for (const id of order) {
    const s = Engine.SYMBOLS[id];
    html += `<div class="pay-row"><span class="pay-sym" data-sym="${id}">${s.glyph}</span>
      <span class="pay-name">${s.name}${id === 'WILD' ? ' — substitutes all except 💫' : ''}</span>
      <span class="pay-vals">3× <b>${s.pays[3]}</b> &nbsp; 4× <b>${s.pays[4]}</b> &nbsp; 5× <b>${s.pays[5]}</b></span></div>`;
  }
  html += `<div class="pay-row"><span class="pay-sym" data-sym="SCATTER">💫</span>
    <span class="pay-name">Singularity Core — pays anywhere (× total bet)</span>
    <span class="pay-vals">3× <b>${Engine.SCATTER_PAYS[3]}</b> &nbsp; 4× <b>${Engine.SCATTER_PAYS[4]}</b> &nbsp; 5× <b>${Engine.SCATTER_PAYS[5]}</b></span></div></div>`;

  html += `<h3>Features</h3><ul class="feat-list">
    <li><b>Cascading Reels</b> — winning symbols are absorbed by the black hole; new matter falls in. Consecutive cascades multiply wins ×1 → ×2 → ×3 → ×5 (doubled to ×2 → ×4 → ×6 → ×10 during free spins).</li>
    <li><b>Multiplier Planets</b> — orbiting planets can crash into a winning cascade and multiply it ×2, ×3 or ×5.</li>
    <li><b>Free Spins</b> — 3, 4, 5 Singularity Cores award 10, 15, 20 free spins. 3+ cores during free spins retrigger +5.</li>
    <li><b>Event Horizon</b> — randomly, time dilates: reels spin in slow motion on an enriched strip with far more premiums, wilds and scatters.</li>
    <li><b>Jackpots</b> — Mini (10× bet), Major (75× bet) and the Singularity (750× bet) can strike on any paid spin.</li>
  </ul>`;

  html += '<h3>Paylines (20)</h3><div class="lines-grid">';
  Engine.PAYLINES.forEach((line, i) => {
    let mini = `<div class="line-mini"><span class="ln">${i + 1}</span><div class="mini-grid">`;
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 5; c++)
        mini += `<i class="${line[c] === r ? 'on' : ''}"></i>`;
    mini += '</div></div>';
    html += mini;
  });
  html += '</div><p class="rtp-note">All wins pay left to right on adjacent reels. Theoretical RTP ≈ 95% (Monte Carlo verified). Play-money credits only.</p>';
  body.innerHTML = html;
}

/* ------------------------------------------------------------------
   Boot
------------------------------------------------------------------ */
function initGame() {
  const E = UI.els;
  E.balance = $('#balance-val');
  E.bet = $('#bet-val');
  E.betMinus = $('#bet-minus');
  E.betPlus = $('#bet-plus');
  E.maxBet = $('#btn-max');
  E.spin = $('#btn-spin');
  E.msg = $('#msg');
  E.reelsRoot = $('#reels');
  E.reelhouse = $('#reelhouse');
  E.lineLayer = $('#linelayer');
  E.winbar = $('#winbar');
  E.winLabel = $('#win-label');
  E.winAmount = $('#win-amount');
  E.hole = $('#hole');
  E.holeCore = $('#hole .core');
  E.cascadeMult = $('#cascade-mult');
  E.ehBanner = $('#eh-banner');
  E.fsBadge = $('#fs-badge');
  E.fsCount = $('#fs-count');
  E.fsTotal = $('#fs-total');
  E.fsIntro = $('#overlay-fs-intro');
  E.fsOutro = $('#overlay-fs-outro');
  E.jackpotOverlay = $('#overlay-jackpot');
  E.singOverlay = $('#overlay-sing');
  E.bigwin = $('#overlay-bigwin');
  E.brokeOverlay = $('#overlay-broke');
  E.infoModal = $('#modal-info');
  E.infoBody = $('#info-body');
  E.controls = $('#controls');
  E.jpMini = $('#jp-mini .jp-amount');
  E.jpMajor = $('#jp-major .jp-amount');
  E.jpSing = $('#jp-sing .jp-amount');

  /* Build the 5 reels. */
  for (let i = 0; i < Engine.REELS; i++) {
    const r = document.createElement('div');
    r.className = 'reel';
    E.reelsRoot.appendChild(r);
    UI.reels.push(new Reel(r, i));
  }

  /* Canvases. */
  FX.init($('#starfield'), $('#fx'));

  measureCells();
  syncHoleToFX();
  window.addEventListener('resize', () => { measureCells(); syncHoleToFX(); });

  /* Shared animation loop: reels + particles + hole tracking. */
  UI.lastTime = performance.now();
  function loop(t) {
    const dt = clamp((t - UI.lastTime) / 1000, 0, 0.05);
    UI.lastTime = t;
    for (const reel of UI.reels) reel.tick(dt);
    FX.tick(dt);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  setInterval(syncHoleToFX, 1500); // cheap drift correction (layout shifts)

  /* Controls. */
  E.spin.addEventListener('click', doSpin);
  E.betMinus.addEventListener('click', () => changeBet(-1));
  E.betPlus.addEventListener('click', () => changeBet(1));
  E.maxBet.addEventListener('click', () => {
    if (UI.busy) return;
    UI.betIndex = BET_STEPS.length - 1;
    updateBetDisplay();
    Audio2.tone(900, 0.08, 'square', 0.05);
  });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !UI.busy && !document.querySelector('.overlay.open, .modal.open')) {
      e.preventDefault();
      doSpin();
    }
  });

  /* Info modal. */
  buildInfoModal();
  $('#btn-info').addEventListener('click', () => E.infoModal.classList.add('open'));
  $('#info-close').addEventListener('click', () => E.infoModal.classList.remove('open'));
  E.infoModal.addEventListener('click', (e) => {
    if (e.target === E.infoModal) E.infoModal.classList.remove('open');
  });

  /* Sound toggle. */
  const sndBtn = $('#btn-sound');
  sndBtn.addEventListener('click', () => {
    Audio2.enabled = !Audio2.enabled;
    sndBtn.classList.toggle('muted', !Audio2.enabled);
    sndBtn.title = Audio2.enabled ? 'Mute sound' : 'Unmute sound';
    if (Audio2.enabled) Audio2.tone(660, 0.1, 'sine', 0.06);
  });

  /* Out-of-credits recharge. */
  $('#btn-recharge').addEventListener('click', () => {
    UI.balance = 1000.00;
    updateBalance();
    UI.els.brokeOverlay.classList.remove('open');
    setMsg('1,000.00 CREDITS MATERIALISED FROM HAWKING RADIATION', 'gold');
  });

  updateBalance();
  updateBetDisplay();
  setMsg('PLACE YOUR BET — FEED THE SINGULARITY');
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGame);
  } else {
    initGame();
  }
}
