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
    SAT:     { glyph: '🛰️', name: 'Satellite',        tier: 'low',     pays: [0, 0, 0, 9, 24, 75] },
    SCOPE:   { glyph: '🔭', name: 'Observatory',      tier: 'low',     pays: [0, 0, 0, 11, 30, 90] },
    STAR:    { glyph: '⭐', name: 'Neutron Star',     tier: 'low',     pays: [0, 0, 0, 13, 38, 120] },
    PLANET:  { glyph: '🪐', name: 'Ringed Planet',    tier: 'high',    pays: [0, 0, 0, 22, 60, 200] },
    ROCKET:  { glyph: '🚀', name: 'Launch Vehicle',   tier: 'high',    pays: [0, 0, 0, 30, 80, 300] },
    ALIEN:   { glyph: '🧑‍🚀', name: 'Lone Astronaut',  tier: 'high',    pays: [0, 0, 0, 40, 120, 500] },
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
   1.5 SYMBOL ART — custom vector symbols (replaces emoji glyphs).
   Each entry is an inline SVG sized in em units via CSS (.sym svg),
   so it inherits the cell's fluid font-size. Gradient ids are prefixed
   per symbol; duplicate ids across identical cells resolve to the same
   definition, which is safe.
   ===================================================================== */
const SYMBOL_ART = {

  /* Dark Moon — cratered, rim-lit dead world */
  ROCK: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    + '<defs><radialGradient id="sa-rock-b" cx="38%" cy="32%" r="80%">'
    + '<stop offset="0%" stop-color="#8b93a7"/><stop offset="55%" stop-color="#4b5263"/>'
    + '<stop offset="100%" stop-color="#14171f"/></radialGradient></defs>'
    + '<circle cx="32" cy="32" r="24" fill="url(#sa-rock-b)"/>'
    + '<circle cx="32" cy="32" r="24" fill="none" stroke="#9aa3b8" stroke-opacity="0.35" stroke-width="1.5"/>'
    + '<ellipse cx="24" cy="26" rx="5.5" ry="4.5" fill="#262b38" opacity="0.85"/>'
    + '<ellipse cx="24" cy="25.2" rx="5.5" ry="3.6" fill="#1b1f2a"/>'
    + '<ellipse cx="40" cy="38" rx="4" ry="3.2" fill="#262b38" opacity="0.85"/>'
    + '<ellipse cx="40" cy="37.4" rx="4" ry="2.5" fill="#1b1f2a"/>'
    + '<circle cx="34" cy="18" r="2.2" fill="#1f2430"/>'
    + '<circle cx="18" cy="40" r="2.6" fill="#1f2430"/>'
    + '<circle cx="44" cy="24" r="1.6" fill="#262b38"/>'
    + '</svg>',

  /* Comet — ice head, ion tail */
  COMET: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    + '<defs><linearGradient id="sa-com-t" x1="0%" y1="0%" x2="100%" y2="100%">'
    + '<stop offset="0%" stop-color="#67e8f9" stop-opacity="0"/>'
    + '<stop offset="60%" stop-color="#7dd3fc" stop-opacity="0.55"/>'
    + '<stop offset="100%" stop-color="#e0f6ff" stop-opacity="0.95"/></linearGradient>'
    + '<radialGradient id="sa-com-h" cx="40%" cy="40%" r="70%">'
    + '<stop offset="0%" stop-color="#ffffff"/><stop offset="55%" stop-color="#bdeeff"/>'
    + '<stop offset="100%" stop-color="#38bdf8"/></radialGradient></defs>'
    + '<path d="M6 6 L46 36 L40 44 Z" fill="url(#sa-com-t)"/>'
    + '<path d="M14 4 L48 34 L44 40 Z" fill="url(#sa-com-t)" opacity="0.6"/>'
    + '<circle cx="44" cy="42" r="10" fill="url(#sa-com-h)"/>'
    + '<circle cx="44" cy="42" r="13" fill="none" stroke="#7dd3fc" stroke-opacity="0.35" stroke-width="2"/>'
    + '<circle cx="41" cy="39" r="2.4" fill="#ffffff" opacity="0.9"/>'
    + '</svg>',

  /* Satellite — gold body, twin solar wings */
  SAT: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    + '<defs><linearGradient id="sa-sat-p" x1="0%" y1="0%" x2="100%" y2="0%">'
    + '<stop offset="0%" stop-color="#1d4ed8"/><stop offset="50%" stop-color="#3b82f6"/>'
    + '<stop offset="100%" stop-color="#1e40af"/></linearGradient></defs>'
    + '<g transform="rotate(-18 32 32)">'
    + '<rect x="4" y="26" width="17" height="12" rx="1.5" fill="url(#sa-sat-p)" stroke="#93c5fd" stroke-width="1"/>'
    + '<rect x="43" y="26" width="17" height="12" rx="1.5" fill="url(#sa-sat-p)" stroke="#93c5fd" stroke-width="1"/>'
    + '<path d="M9.7 26v12 M15.3 26v12 M48.7 26v12 M54.3 26v12" stroke="#bfdbfe" stroke-width="0.8" opacity="0.7"/>'
    + '<rect x="21" y="24" width="22" height="16" rx="3" fill="#d9a44a"/>'
    + '<rect x="21" y="24" width="22" height="7" rx="3" fill="#f3c97b"/>'
    + '<circle cx="32" cy="18" r="6" fill="none" stroke="#cbd5e1" stroke-width="2"/>'
    + '<line x1="32" y1="24" x2="32" y2="18" stroke="#cbd5e1" stroke-width="2"/>'
    + '<circle cx="32" cy="12.5" r="1.8" fill="#fca5a5"/>'
    + '</g></svg>',

  /* Observatory — dome with a search beam */
  SCOPE: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    + '<defs><linearGradient id="sa-obs-b" x1="0%" y1="100%" x2="100%" y2="0%">'
    + '<stop offset="0%" stop-color="#fde68a" stop-opacity="0"/>'
    + '<stop offset="100%" stop-color="#fff7d6" stop-opacity="0.9"/></linearGradient>'
    + '<linearGradient id="sa-obs-d" x1="0%" y1="0%" x2="0%" y2="100%">'
    + '<stop offset="0%" stop-color="#e2e8f0"/><stop offset="100%" stop-color="#94a3b8"/></linearGradient></defs>'
    + '<path d="M36 26 L58 4 L62 10 L42 32 Z" fill="url(#sa-obs-b)"/>'
    + '<path d="M14 34 a18 18 0 0 1 36 0 Z" fill="url(#sa-obs-d)"/>'
    + '<path d="M33 17.5 L44 26 L40 34 L33 34 Z" fill="#475569"/>'
    + '<rect x="10" y="34" width="44" height="6" rx="2" fill="#64748b"/>'
    + '<rect x="16" y="40" width="32" height="14" rx="2" fill="#3f4a5c"/>'
    + '<rect x="28.5" y="44" width="7" height="10" rx="1" fill="#1e2532"/>'
    + '<circle cx="56" cy="8" r="2" fill="#fff7d6"/>'
    + '</svg>',

  /* Neutron Star — pulsar with polar jets */
  STAR: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    + '<defs><radialGradient id="sa-ns-c" cx="50%" cy="50%" r="55%">'
    + '<stop offset="0%" stop-color="#ffffff"/><stop offset="45%" stop-color="#bdeeff"/>'
    + '<stop offset="100%" stop-color="#22d3ee" stop-opacity="0.15"/></radialGradient>'
    + '<linearGradient id="sa-ns-j" x1="0%" y1="0%" x2="0%" y2="100%">'
    + '<stop offset="0%" stop-color="#a5f3fc" stop-opacity="0"/>'
    + '<stop offset="50%" stop-color="#e0fbff" stop-opacity="0.95"/>'
    + '<stop offset="100%" stop-color="#a5f3fc" stop-opacity="0"/></linearGradient></defs>'
    + '<g transform="rotate(24 32 32)">'
    + '<rect x="29.5" y="2" width="5" height="60" rx="2.5" fill="url(#sa-ns-j)"/>'
    + '<ellipse cx="32" cy="32" rx="20" ry="6.5" fill="none" stroke="#67e8f9" stroke-opacity="0.55" stroke-width="1.6"/>'
    + '</g>'
    + '<circle cx="32" cy="32" r="15" fill="url(#sa-ns-c)"/>'
    + '<circle cx="32" cy="32" r="7" fill="#ffffff"/>'
    + '</svg>',

  /* Ringed Planet — banded amber giant */
  PLANET: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    + '<defs><radialGradient id="sa-pl-b" cx="38%" cy="32%" r="85%">'
    + '<stop offset="0%" stop-color="#ffd9a0"/><stop offset="55%" stop-color="#e8a35c"/>'
    + '<stop offset="100%" stop-color="#7c4a1e"/></radialGradient>'
    + '<clipPath id="sa-pl-cl"><circle cx="32" cy="32" r="17"/></clipPath></defs>'
    + '<g transform="rotate(-16 32 32)">'
    + '<path d="M5 32 a27 9 0 0 1 54 0" fill="none" stroke="#caa46f" stroke-width="3.2" stroke-opacity="0.55" transform="rotate(180 32 32)"/>'
    + '<circle cx="32" cy="32" r="17" fill="url(#sa-pl-b)"/>'
    + '<g clip-path="url(#sa-pl-cl)" opacity="0.55">'
    + '<rect x="12" y="24" width="40" height="3.4" fill="#b06a2c"/>'
    + '<rect x="12" y="33" width="40" height="4.4" fill="#9a5a22"/>'
    + '<rect x="12" y="42" width="40" height="2.6" fill="#b06a2c"/>'
    + '</g>'
    + '<path d="M5 32 a27 9 0 0 1 54 0" fill="none" stroke="#f3cf9b" stroke-width="3.2"/>'
    + '<path d="M5 32 a27 9 0 0 1 54 0" fill="none" stroke="#a9824f" stroke-width="1.2" transform="translate(0 3.5)"/>'
    + '</g></svg>',

  /* Launch Vehicle — retro rocket at full burn */
  ROCKET: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    + '<defs><linearGradient id="sa-rk-b" x1="0%" y1="0%" x2="100%" y2="0%">'
    + '<stop offset="0%" stop-color="#f8fafc"/><stop offset="55%" stop-color="#cbd5e1"/>'
    + '<stop offset="100%" stop-color="#8c98ab"/></linearGradient>'
    + '<radialGradient id="sa-rk-f" cx="50%" cy="20%" r="90%">'
    + '<stop offset="0%" stop-color="#fff7d6"/><stop offset="45%" stop-color="#ffb347"/>'
    + '<stop offset="100%" stop-color="#ff5a1f" stop-opacity="0.1"/></radialGradient></defs>'
    + '<g transform="rotate(38 32 32)">'
    + '<path d="M32 2 C40 12 41 26 41 36 L23 36 C23 26 24 12 32 2 Z" fill="url(#sa-rk-b)"/>'
    + '<path d="M32 2 C36.5 8 39 17 40 25 L32 25 Z" fill="#ef4444" opacity="0.9"/>'
    + '<circle cx="32" cy="24" r="5" fill="#0e7490" stroke="#e0f2fe" stroke-width="2"/>'
    + '<path d="M23 30 L14 44 L23 41 Z" fill="#ef4444"/>'
    + '<path d="M41 30 L50 44 L41 41 Z" fill="#ef4444"/>'
    + '<rect x="27" y="36" width="10" height="4" fill="#64748b"/>'
    + '<path d="M27 40 C29 50 35 50 37 40 Z" fill="url(#sa-rk-f)"/>'
    + '<path d="M29.5 40 C30.5 46 33.5 46 34.5 40 Z" fill="#fff1c0"/>'
    + '</g></svg>',

  /* Lone Astronaut — helmet with visor gleam */
  ALIEN: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    + '<defs><radialGradient id="sa-as-h" cx="38%" cy="30%" r="80%">'
    + '<stop offset="0%" stop-color="#ffffff"/><stop offset="60%" stop-color="#d7dee9"/>'
    + '<stop offset="100%" stop-color="#94a3b8"/></radialGradient>'
    + '<linearGradient id="sa-as-v" x1="0%" y1="0%" x2="100%" y2="100%">'
    + '<stop offset="0%" stop-color="#0b1f33"/><stop offset="100%" stop-color="#123c5e"/></linearGradient></defs>'
    + '<rect x="14" y="44" width="36" height="16" rx="8" fill="#cbd5e1"/>'
    + '<rect x="14" y="44" width="36" height="8" rx="4" fill="#e8edf4"/>'
    + '<rect x="26" y="46" width="12" height="6" rx="2" fill="#64748b"/>'
    + '<circle cx="32" cy="27" r="21" fill="url(#sa-as-h)"/>'
    + '<path d="M17 27 a15 15 0 0 1 30 0 v3 a15 13 0 0 1 -30 0 Z" fill="url(#sa-as-v)"/>'
    + '<path d="M21 22 a13 11 0 0 1 13 -6" fill="none" stroke="#67e8f9" stroke-width="2.4" stroke-linecap="round" opacity="0.85"/>'
    + '<circle cx="40" cy="33" r="1.6" fill="#67e8f9" opacity="0.7"/>'
    + '<circle cx="11" cy="30" r="3" fill="#94a3b8"/><circle cx="53" cy="30" r="3" fill="#94a3b8"/>'
    + '</svg>',

  /* Spiral Galaxy — violet arms, blazing core */
  GALAXY: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    + '<defs><radialGradient id="sa-gx-c" cx="50%" cy="50%" r="55%">'
    + '<stop offset="0%" stop-color="#fff7ed"/><stop offset="45%" stop-color="#f5c66b"/>'
    + '<stop offset="100%" stop-color="#8b5cf6" stop-opacity="0.12"/></radialGradient>'
    + '<linearGradient id="sa-gx-a" x1="0%" y1="0%" x2="100%" y2="100%">'
    + '<stop offset="0%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#38bdf8"/></linearGradient></defs>'
    + '<g fill="none" stroke="url(#sa-gx-a)" stroke-linecap="round">'
    + '<path d="M32 32 C46 28 54 36 52 48 C50 56 42 60 34 58" stroke-width="5" opacity="0.85"/>'
    + '<path d="M32 32 C18 36 10 28 12 16 C14 8 22 4 30 6" stroke-width="5" opacity="0.85"/>'
    + '<path d="M32 32 C40 22 52 22 56 30" stroke-width="3" opacity="0.5"/>'
    + '<path d="M32 32 C24 42 12 42 8 34" stroke-width="3" opacity="0.5"/>'
    + '</g>'
    + '<circle cx="32" cy="32" r="13" fill="url(#sa-gx-c)"/>'
    + '<circle cx="32" cy="32" r="4.5" fill="#fff7ed"/>'
    + '<circle cx="49" cy="44" r="1.4" fill="#c4b5fd"/><circle cx="16" cy="20" r="1.4" fill="#bae6fd"/>'
    + '<circle cx="44" cy="14" r="1.1" fill="#e9d5ff"/><circle cx="20" cy="50" r="1.1" fill="#bae6fd"/>'
    + '</svg>',

  /* Black Hole Wild — photon ring around the void */
  WILD: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    + '<defs><radialGradient id="sa-bh-g" cx="50%" cy="50%" r="50%">'
    + '<stop offset="55%" stop-color="#d946ef" stop-opacity="0"/>'
    + '<stop offset="82%" stop-color="#d946ef" stop-opacity="0.45"/>'
    + '<stop offset="100%" stop-color="#7c3aed" stop-opacity="0"/></radialGradient>'
    + '<linearGradient id="sa-bh-r" x1="0%" y1="0%" x2="100%" y2="100%">'
    + '<stop offset="0%" stop-color="#ffd27a"/><stop offset="50%" stop-color="#ff8a3c"/>'
    + '<stop offset="100%" stop-color="#e0418f"/></linearGradient></defs>'
    + '<circle cx="32" cy="32" r="30" fill="url(#sa-bh-g)"/>'
    + '<ellipse cx="32" cy="32" rx="26" ry="9" fill="none" stroke="url(#sa-bh-r)" stroke-width="3" opacity="0.85" transform="rotate(-20 32 32)"/>'
    + '<circle cx="32" cy="32" r="14.5" fill="none" stroke="url(#sa-bh-r)" stroke-width="3.4"/>'
    + '<circle cx="32" cy="32" r="12" fill="#03040a"/>'
    + '<circle cx="32" cy="32" r="12" fill="none" stroke="#ffe9c4" stroke-width="0.8" opacity="0.8"/>'
    + '</svg>',

  /* Singularity Core (scatter) — golden core in an orbit cage */
  SCATTER: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    + '<defs><radialGradient id="sa-sc-c" cx="42%" cy="38%" r="70%">'
    + '<stop offset="0%" stop-color="#fffbe8"/><stop offset="50%" stop-color="#ffd966"/>'
    + '<stop offset="100%" stop-color="#d98a1f"/></radialGradient></defs>'
    + '<ellipse cx="32" cy="32" rx="27" ry="10" fill="none" stroke="#ffd966" stroke-width="2.2" opacity="0.8" transform="rotate(-28 32 32)"/>'
    + '<ellipse cx="32" cy="32" rx="27" ry="10" fill="none" stroke="#ffb347" stroke-width="2.2" opacity="0.65" transform="rotate(28 32 32)"/>'
    + '<circle cx="32" cy="32" r="12" fill="url(#sa-sc-c)"/>'
    + '<circle cx="32" cy="32" r="12" fill="none" stroke="#fff3c9" stroke-width="1.2" opacity="0.9"/>'
    + '<path d="M50 12 L52 17 L57 19 L52 21 L50 26 L48 21 L43 19 L48 17 Z" fill="#fff3c9"/>'
    + '<circle cx="13" cy="46" r="2" fill="#ffd966"/>'
    + '</svg>',
};

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

  /* ---------------------------------------------------------------
     Ambient background score — slow drifting drone pads + sparse
     twinkling arpeggios, generated on the fly (no audio files).
     Runs on its own gain node so it can be ducked independently
     and toggled by the sound button without affecting SFX.
  --------------------------------------------------------------- */
  music: {
    master: null,
    nodes: [],
    timers: [],
    playing: false,
    duckLevel: 1,
  },

  musicStart() {
    if (!this.enabled || !this.ensure()) return;
    if (this.music.playing) return;
    try {
      const ctx = this.ctx;
      const master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);
      master.gain.setTargetAtTime(0.05, ctx.currentTime, 1.5);
      this.music.master = master;
      this.music.playing = true;

      /* Slow-shifting drone pads — two detuned saws + a sub sine,
         each through its own lowpass, very low in the mix. */
      const padFreqs = [55, 65.4, 73.4]; // A1, C2, D2 — cold open chord
      padFreqs.forEach((f, i) => {
        const o1 = ctx.createOscillator();
        const o2 = ctx.createOscillator();
        const g = ctx.createGain();
        const lp = ctx.createBiquadFilter();
        o1.type = 'sawtooth'; o2.type = 'sawtooth';
        o1.frequency.value = f; o2.frequency.value = f;
        o1.detune.value = -6; o2.detune.value = 6;
        lp.type = 'lowpass'; lp.frequency.value = 420 + i * 60; lp.Q.value = 0.6;
        g.gain.value = 0.5;
        o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(master);
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        lfo.frequency.value = 0.03 + i * 0.011;
        lfoGain.gain.value = 150;
        lfo.connect(lfoGain); lfoGain.connect(lp.frequency);
        o1.start(); o2.start(); lfo.start();
        this.music.nodes.push(o1, o2, lfo);
      });

      /* Sub pulse — slow breathing low sine, the "heartbeat" of the void. */
      const sub = ctx.createOscillator();
      const subGain = ctx.createGain();
      sub.type = 'sine'; sub.frequency.value = 27.5; // A0
      subGain.gain.value = 0.35;
      const subLfo = ctx.createOscillator();
      const subLfoGain = ctx.createGain();
      subLfo.frequency.value = 0.08;
      subLfoGain.gain.value = 0.3;
      subLfo.connect(subLfoGain); subLfoGain.connect(subGain.gain);
      sub.connect(subGain); subGain.connect(master);
      sub.start(); subLfo.start();
      this.music.nodes.push(sub, subLfo);

      /* Sparse twinkling arpeggio — cosmic "wind chime" notes drawn
         from a pentatonic-ish scale, scheduled at random intervals. */
      const scale = [220, 261.6, 329.6, 392, 440, 523.3, 659.3, 784];
      const playTwinkle = () => {
        if (!this.music.playing) return;
        if (this.enabled) {
          const f = scale[(Math.random() * scale.length) | 0];
          const t = ctx.currentTime;
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = 'sine';
          o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.045 * this.music.duckLevel, t + 0.4);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
          o.connect(g); g.connect(master);
          o.start(t); o.stop(t + 3.3);
        }
        const next = 2200 + Math.random() * 3600;
        this.music.timers.push(setTimeout(playTwinkle, next));
      };
      this.music.timers.push(setTimeout(playTwinkle, 1800));
    } catch (e) { /* music is decorative — never break gameplay */ }
  },

  musicStop() {
    const m = this.music;
    if (!m.playing) return;
    try {
      const ctx = this.ctx;
      if (m.master) {
        m.master.gain.setTargetAtTime(0, ctx.currentTime, 0.6);
        const master = m.master;
        setTimeout(() => {
          for (const n of m.nodes) { try { n.stop(); } catch (e) {} }
          try { master.disconnect(); } catch (e) {}
        }, 900);
      }
    } catch (e) { /* noop */ }
    for (const t of m.timers) clearTimeout(t);
    m.timers = [];
    m.nodes = [];
    m.master = null;
    m.playing = false;
  },

  /* Temporarily lower music volume for big cinematic moments. */
  musicDuck(level = 0.3, recoverAfter = 0) {
    const m = this.music;
    m.duckLevel = level;
    if (m.master) {
      const ctx = this.ctx;
      m.master.gain.setTargetAtTime(0.05 * level, ctx.currentTime, 0.4);
    }
    if (recoverAfter > 0) {
      setTimeout(() => this.musicDuck(1), recoverAfter);
    }
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
  ACCEL: 6200,          // px/s²
  VMAX_CELLS: 16,       // top speed, in cell-heights per second
  BRAKE: 4.6,           // proportional braking constant (1/s)
  MINV_CELLS: 3.6,      // minimum landing speed
  FILLERS: 2,           // random symbols before the final ones land
  SPIN_MS: 2000,        // target total spin time: launch → last reel lands
  STOP_STAGGER: 150,    // ms between successive reel-stop commands
  BRAKE_EST: 760,       // ≈ time (ms) a reel takes to brake & land once told to stop
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
    s.innerHTML = SYMBOL_ART[id] || Engine.SYMBOLS[id].glyph;
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
  autoSpinsRemaining: 0,
  autoSpinActive: false,
};

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

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

  const slow = UI.slowMo;
  const n = UI.reels.length;
  const t0 = performance.now();

  /* launch */
  for (let i = 0; i < n; i++) {
    setTimeout(() => UI.reels[i].startSpin(), i * 70 * slow);
  }

  /* scatter anticipation flags — the result is already known, so this can
     be precomputed without waiting for reels to physically land */
  const anticipate = [];
  let scattersSoFar = 0;
  for (let i = 0; i < n; i++) {
    anticipate[i] = scattersSoFar >= 2 && i >= 2;
    scattersSoFar += result.initialGrid[i].filter((s) => s === 'SCATTER').length;
  }

  /* cruise phase, sized so the LAST reel lands ≈ SPIN_MS after launch:
     SPIN_MS = cruise + stop stagger across reels + braking time */
  const stopSeq = ReelCfg.STOP_STAGGER * (n - 1) + ReelCfg.BRAKE_EST;
  const cruise = ReelCfg.SPIN_MS * slow - stopSeq * slow - (performance.now() - t0);
  await sleep(Math.max((70 * n + 180) * slow, cruise));

  /* staggered, overlapping stops (reels land left → right) with
     scatter anticipation pauses where earned */
  const landings = [];
  for (let i = 0; i < n; i++) {
    if (anticipate[i]) {
      await Promise.all(landings);   // let earlier reels settle for the tease
      UI.reels[i].root.classList.add('anticipate');
      Audio2.tone(700 + i * 60, 0.4, 'sine', 0.05);
      await sleep(680 * slow);
    }
    landings.push(UI.reels[i].stopWith(result.initialGrid[i]));
    if (i < n - 1) await sleep(ReelCfg.STOP_STAGGER * slow);
  }
  await Promise.all(landings);
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
  Audio2.musicDuck(0.25, 2400);
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
  Audio2.musicDuck(0.15);
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
  Audio2.musicDuck(1);
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
    stopAutoSpin();
  } finally {
    UI.busy = false;
    UI.els.spin.classList.remove('spinning');
    setControlsLocked(false);
    updateBetDisplay();
  }

  /* Auto-spin: queue the next spin unless we've run out of credits,
     spins, or the player stopped it mid-sequence. */
  if (UI.autoSpinActive) {
    if (UI.balance < currentBet() || UI.els.brokeOverlay.classList.contains('open')) {
      stopAutoSpin();
    } else {
      UI.autoSpinsRemaining--;
      updateAutoSpinLabel();
      if (UI.autoSpinsRemaining <= 0) {
        stopAutoSpin();
      } else {
        setTimeout(() => doSpin(), 500);
      }
    }
  }
}

/* ------------------------------------------------------------------
   Auto spin — repeats the spin a chosen number of times.
------------------------------------------------------------------ */
function updateAutoSpinLabel() {
  const label = UI.els.autoLabel;
  if (UI.autoSpinActive) {
    label.textContent = String(UI.autoSpinsRemaining);
  } else {
    label.textContent = 'AUTO';
  }
}

function startAutoSpin(count) {
  UI.autoSpinActive = true;
  UI.autoSpinsRemaining = count;
  UI.els.autoBtn.classList.add('active');
  updateAutoSpinLabel();
  UI.els.autospinModal.classList.remove('open');
  setMsg(`AUTO SPIN ENGAGED — ${count} SPINS`, 'violet');
  if (!UI.busy) doSpin();
}

function stopAutoSpin() {
  if (!UI.autoSpinActive && UI.autoSpinsRemaining === 0) return;
  UI.autoSpinActive = false;
  UI.autoSpinsRemaining = 0;
  UI.els.autoBtn.classList.remove('active');
  updateAutoSpinLabel();
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
    html += `<div class="pay-row"><span class="pay-sym" data-sym="${id}">${SYMBOL_ART[id]}</span>
      <span class="pay-name">${s.name}${id === 'WILD' ? ' — substitutes all except the Singularity Core' : ''}</span>
      <span class="pay-vals">3× <b>${s.pays[3]}</b> &nbsp; 4× <b>${s.pays[4]}</b> &nbsp; 5× <b>${s.pays[5]}</b></span></div>`;
  }
  html += `<div class="pay-row"><span class="pay-sym" data-sym="SCATTER">${SYMBOL_ART.SCATTER}</span>
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
  E.autoBtn = $('#btn-autospin');
  E.autoLabel = $('#auto-label');
  E.autospinModal = $('#modal-autospin');

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

  /* Auto spin. */
  E.autoBtn.addEventListener('click', () => {
    if (UI.autoSpinActive) {
      stopAutoSpin();
      Audio2.tone(220, 0.12, 'square', 0.05);
      setMsg('AUTO SPIN STOPPED', 'warn');
      return;
    }
    if (UI.busy || UI.inFreeSpins) return;
    E.autospinModal.classList.add('open');
    Audio2.tone(660, 0.08, 'sine', 0.05);
  });
  $$('.auto-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      const count = parseInt(btn.dataset.spins, 10);
      Audio2.tone(900, 0.1, 'square', 0.05);
      startAutoSpin(count);
    });
  });
  $('#autospin-close').addEventListener('click', () => E.autospinModal.classList.remove('open'));
  $('#autospin-stop').addEventListener('click', () => {
    stopAutoSpin();
    E.autospinModal.classList.remove('open');
    Audio2.tone(220, 0.12, 'square', 0.05);
    setMsg('AUTO SPIN STOPPED', 'warn');
  });
  E.autospinModal.addEventListener('click', (e) => {
    if (e.target === E.autospinModal) E.autospinModal.classList.remove('open');
  });

  /* Sound toggle. */
  const sndBtn = $('#btn-sound');
  sndBtn.addEventListener('click', () => {
    Audio2.enabled = !Audio2.enabled;
    sndBtn.classList.toggle('muted', !Audio2.enabled);
    sndBtn.title = Audio2.enabled ? 'Mute sound' : 'Unmute sound';
    if (Audio2.enabled) {
      Audio2.tone(660, 0.1, 'sine', 0.06);
      Audio2.musicStart();
    } else {
      Audio2.musicStop();
    }
  });

  /* Ambient score starts on the first user gesture (autoplay policies
     require this). One-shot listener, harmless if sound is muted. */
  const startMusicOnce = () => {
    if (Audio2.enabled) Audio2.musicStart();
    document.removeEventListener('pointerdown', startMusicOnce);
    document.removeEventListener('keydown', startMusicOnce);
  };
  document.addEventListener('pointerdown', startMusicOnce, { once: true });
  document.addEventListener('keydown', startMusicOnce, { once: true });

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
