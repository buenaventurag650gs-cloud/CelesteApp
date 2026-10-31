/* Índice CELESTE
   Un solo mapa que pondera lluvia, potencial de tormenta, ráfagas, probabilidad de lluvia y calor.
   Cubre las últimas 6 horas (observado) y las próximas 6 (pronóstico), en pasos de 30 minutos.
   - Pasado y ahora: radar de COCESNA calibrado con las estaciones del IMN; fuera del radar, modelo.
   - 0–3 h: el radar se proyecta según el movimiento medido entre imágenes (correlación por bloques +
     advección semilagrangiana), con decaimiento y difuminado crecientes.
   - Desde las 3 h y fuera del radar: modelo numérico (Open-Meteo). */
(function () {
  "use strict";
  const C = window.Celeste;
  if (!C) return;
  const { map, $ } = C;

  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } },
  };

  // ---------- Dominio y pasos ----------
  const AREA = C.extent(7.9, -86.25, 11.35, -82.45, 360); // ~1,2 km por celda
  const W = AREA.w, H = AREA.h, N = W * H;
  const STEPS = Array.from({ length: 25 }, (_, i) => (i - 12) * 30); // −6 h … +6 h
  const NOW_I = 12;
  const RADAR_CENTER = [12.141, -86.168]; // zona de Managua (aprox.)
  const RADAR_RANGE = 430; // km útiles
  const BLEND_END = 180; // a los 180 min el radar proyectado ya no pesa

  // ---------- Peldaños del índice (nombres ticos) ----------
  // Cada peldaño ocupa 10 puntos del índice (0–100). La regla de cada uno es objetiva y se basa en lo
  // que se mide o estima: lluvia (mm/h), nubosidad (%), probabilidad de lluvia, potencial de tormenta y ráfagas.
  const CLOUD = "M6 14h11a3.6 3.6 0 0 0 .4-7.2A5.5 5.5 0 0 0 5.8 8 3 3 0 0 0 6 14z";
  const LEVELS = [
    { n: "Pura vida", d: "Sol y condiciones despejadas.", rule: "Nubosidad menor al 20 % y sin lluvia.",
      i: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>' },
    { n: "Despejadillo", d: "Buen tiempo, algunas nubes.", rule: "Nubosidad del 20 al 45 %, sin lluvia.",
      i: '<circle cx="8.5" cy="8.5" r="3.3"/><path d="M8.5 2.3v1.5M2.3 8.5h1.5M4.1 4.1l1.1 1.1M12.9 4.1l-1.1 1.1"/><path d="M10 20h8a3 3 0 0 0 .3-6 4.5 4.5 0 0 0-8.6 1.2A2.4 2.4 0 0 0 10 20z"/>' },
    { n: "Nubladillo", d: "Cielo parcialmente nublado.", rule: "Nubosidad del 45 al 80 %, sin lluvia.",
      i: '<path d="M14.6 5.6a3.6 3.6 0 0 1 5.6 3.4"/><path d="M17.5 2.5v1.3M22 7.5h-1.3M20.8 3.9l-.9.9"/><path d="M5.5 20h10a3.6 3.6 0 0 0 .4-7.2A5.5 5.5 0 0 0 5.3 14a3 3 0 0 0 .2 6z"/>' },
    { n: "Amenazando", d: "Se está cerrando el cielo, posibles lluvias.", rule: "Lluvia apenas perceptible (menos de 0,2 mm/h), nubosidad mayor al 80 %, o nublado con probabilidad de lluvia ≥ 50 % o potencial de tormenta alto.",
      i: `<path d="${CLOUD}" fill="currentColor" fill-opacity=".35"/><path d="M9 18.5h6M10.5 21h3"/>` },
    { n: "Llovizna", d: "Lluvia ligera y pasajera.", rule: "Lluvia de 0,2 a 2,5 mm por hora.",
      i: `<path d="${CLOUD}"/><path d="M8 17.5v.01M12 18.5v.01M16 17.5v.01M10 21v.01M14 21v.01" stroke-width="2.6"/>` },
    { n: "Aguacero", d: "Lluvia moderada, por momentos fuerte.", rule: "Lluvia de 2,5 a 7,6 mm por hora.",
      i: `<path d="${CLOUD}"/><path d="M8.5 16.5l-1.2 3.5M12.5 16.5l-1.2 3.5M16.5 16.5l-1.2 3.5"/>` },
    { n: "Chaparrón", d: "Lluvia fuerte y localizada.", rule: "Lluvia de más de 7,6 mm por hora en un aguacero corto.",
      i: `<path d="${CLOUD}" fill="currentColor" fill-opacity=".25"/><path d="M7.5 16l-1.6 5M11 16l-1.6 5M14.5 16l-1.6 5M18 16l-1.6 5" stroke-width="2"/>` },
    { n: "Temporal", d: "Lluvias intensas y persistentes.", rule: "Más de 7,6 mm por hora con un promedio de 10 mm por hora o más durante ±1 hora.",
      i: '<path d="M9 9.5h8a3 3 0 0 0 .3-6 4.5 4.5 0 0 0-8.4 1.4A2.4 2.4 0 0 0 9 9.5z" fill="currentColor" fill-opacity=".25"/><path d="M5 15.5h10a3.4 3.4 0 0 0 1.6-.4"/><path d="M5 15.5a2.8 2.8 0 0 1 .2-5.6"/><path d="M6.5 18l-1 3M9.5 18l-1 3M12.5 18l-1 3M15.5 18l-1 3M18.5 13l-1 3M21 12l-1 3"/>' },
    { n: "Baldazo", d: "Lluvia muy fuerte, con posibles afectaciones.", rule: "Lluvia de 40 mm por hora o más.",
      i: '<path d="M3.5 4.5l9.5 3.2-2.6 6.8-8.4-3z" fill="currentColor" fill-opacity=".3"/><path d="M13 7.7c2.2 1.6 3.4 4 3.6 6.6M11 14.8c1.4 1.6 2.3 3.6 2.6 6M14.6 16c.8 1.5 1.3 3.1 1.4 4.8M18.2 13.6c.7 1.7 1 3.5 1 5.4M20.6 11.5c.5 1.5.7 3 .7 4.6"/>' },
    { n: "Vendaval", d: "Condiciones severas, lluvia y fuertes vientos.", rule: "Ráfagas de 70 km/h o más con lluvia de al menos 2,5 mm por hora, o ráfagas de 90 km/h o más.",
      i: '<path d="M7 11h9a3 3 0 0 0 .3-6A4.6 4.6 0 0 0 7.6 6.3 2.4 2.4 0 0 0 7 11z"/><path d="M2.5 14.5h12a2.3 2.3 0 1 0-2.3-2.3M2.5 18h15.5a2.3 2.3 0 1 1-2.3 2.3M4.5 21.5h6"/>' },
  ];
  // Escala de color: transparente en "Pura vida"; dos tonos extra muy diluidos para "Despejadillo"
  const IDX = {
    levels: [10, 15, 20, 30, 40, 50, 60, 70, 80, 90],
    colors: C.ramp(["#d7ebf8", "#b4d8f1", "#8cc1e7", "#64a6da", "#4189c9", "#2d70b3", "#20599b", "#17467f", "#103462", "#0a2550"], 10),
    alphas: [0.14, 0.26, 0.4, 0.54, 0.66, 0.76, 0.84, 0.9, 0.95, 1],
    units: "Índice CELESTE, de 0 a 100",
    fmt: C.fmtNum,
  };
  const levelOf = (v) => (!Number.isFinite(v) || v < 10 ? 0 : Math.min(9, Math.floor(v / 10)));
  const levelColor = (l) => (l === 0 ? "#f3d36b" : IDX.colors[l === 1 ? 1 : l]);
  const levelInk = (l) => (l >= 5 ? "#ffffff" : "#12324a");
  const levelIcon = (l, cls = "lvl-svg") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${LEVELS[l].i}</svg>`;
  const levelBadge = (l, cls = "") => `<span class="lvl-badge ${cls}" style="background:${l === 0 ? "#fff6d6" : levelColor(l)};color:${l === 0 ? "#a77b00" : levelInk(l)}" title="${LEVELS[l].n}: ${LEVELS[l].d}">${levelIcon(l)}</span>`;
  C.levels = { LEVELS, levelOf, levelIcon, levelBadge };

  // Regla de cada celda → valor 0–100 (10 puntos por peldaño; dentro del peldaño, la intensidad)
  function ladder(R, cloud, pp, cape, gust, persist) {
    if (gust >= 90 || (gust >= 70 && R >= 2.5)) return 90 + 9.9 * clamp((gust - 70) / 40);
    if (R >= 40) return 80 + 9.9 * clamp((R - 40) / 60);
    if (R >= 7.6 && persist >= 10) return 70 + 9.9 * clamp((persist - 10) / 20);
    if (R >= 7.6) return 60 + 9.9 * clamp(Math.log(R / 7.6) / Math.log(40 / 7.6));
    if (R >= 2.5) return 50 + 9.9 * clamp((R - 2.5) / 5.1);
    if (R >= 0.2) return 40 + 9.9 * clamp(Math.log(R / 0.2) / Math.log(12.5));
    const threat = R >= 0.05 || (cloud >= 50 && (pp >= 50 || cape >= 1500));
    if (cloud >= 80 || threat) return 30 + 9.9 * clamp(Math.max((cloud - 80) / 20, (pp - 50) / 50, (cape - 1500) / 1500, R / 0.2));
    if (cloud >= 45) return 20 + 9.9 * clamp((cloud - 45) / 35);
    if (cloud >= 20) return 10 + 9.9 * clamp((cloud - 20) / 25);
    return 9.9 * clamp(cloud / 20);
  }

  const MODEL_KEYS = ["cape", "gust", "pp", "heat", "cloud"];
  // Fuentes de la lluvia: cada celda pondera las fuentes que tienen dato ahí (peso × calidad local)
  const RSRC = [
    { key: "radar", name: "Radar COCESNA", w: 50, src: "cocesna" },
    { key: "est", name: "Lluvia de estaciones ±6 h", w: 30, src: "imn" },
    { key: "goes", name: "GOES-Este, nubes frías", w: 12, src: "noaa" },
    { key: "imerg", name: "IMERG (satélite)", w: 10, src: "nasa" },
    { key: "model", name: "Modelo numérico", w: 6, src: null },
  ];
  const SUGGESTED_SRC = Object.fromEntries(RSRC.map((r) => [r.key, r.w]));
  try {
    const savedS = JSON.parse(store.get("celeste-fuentes") || "null");
    if (savedS) RSRC.forEach((r) => { if (Number.isFinite(savedS[r.key])) r.w = savedS[r.key]; });
  } catch (e) { /* pesos por defecto */ }
  const RW = () => Object.fromEntries(RSRC.map((r) => [r.key, r.w]));
  // ---------- Capa ----------
  map.createPane("indice").style.zIndex = 435;
  map.getPane("indice").style.opacity = 0.85;
  const renderer = L.canvas({ pane: "indice", padding: 0.4 });
  // Herramientas de visualización (se recuerdan en este navegador)
  const VIZ = Object.assign({ op: 0.9, desde: 1, bordes: false, nubes: false }, (() => { try { return JSON.parse(store.get("celeste-viz") || "{}"); } catch (e) { return {}; } })());
  map.getPane("indice").style.opacity = VIZ.op;
  const bandLevel = (i) => (i <= 1 ? 1 : i); // banda de color → peldaño
  const layerOf = (geo) => L.geoJSON({ type: "FeatureCollection", features: geo.features.filter((f) => bandLevel(f.properties.i) >= VIZ.desde) }, {
    pane: "indice", renderer, interactive: false, smoothFactor: 0.4,
    style: (f) => {
      const a = IDX.alphas[f.properties.i];
      return VIZ.bordes
        ? { fillColor: f.properties.c, fillOpacity: a, color: f.properties.i >= 5 ? "#ffffff" : "#1a4e8e", weight: 1, opacity: 0.55 }
        : { fillColor: f.properties.c, fillOpacity: a, color: f.properties.c, weight: 0.6, opacity: a };
    },
  });

  // ---------- Estado ----------
  let active = false;
  let steps = []; // {min, time, rain(Float32), coarse:{cape,gust,pp,heat,cloud}, parts, index, layer, p90, max, source}
  let cur = NOW_I;
  let t0 = null;
  let radarOK = false;
  let calib = null; // {factor, n}
  let calibG = null; // sesgo de GOES frente a estaciones
  let goesFactor = 0.5;
  let sourcesUsed = null;
  let computing = false;
  let computedAt = 0;
  let timer = null, refresh = null;

  // ---------- Geometría precalculada ----------
  const cellLat = new Float32Array(N), cellLng = new Float32Array(N);
  const radX = new Float32Array(N), radY = new Float32Array(N), radW = new Float32Array(N);
  const toRad = Math.PI / 180;
  const radarWeight = (lat, lng) => {
    const dLat = (lat - RADAR_CENTER[0]) * 111.2;
    const dLng = (lng - RADAR_CENTER[1]) * 111.2 * Math.cos(lat * toRad);
    return clamp((RADAR_RANGE - Math.sqrt(dLat * dLat + dLng * dLng)) / 30);
  };
  (function precompute() {
    const [x0, y0, x1, y1] = AREA.bbox;
    const rb = C.RADAR_AREA.bbox, rw = C.RADAR_AREA.w, rh = C.RADAR_AREA.h;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        const X = x0 + ((i + 0.5) / W) * (x1 - x0);
        const Y = y1 - ((j + 0.5) / H) * (y1 - y0);
        const [lat, lng] = C.unmerc(X, Y);
        cellLat[k] = lat; cellLng[k] = lng;
        radX[k] = ((X - rb[0]) / (rb[2] - rb[0])) * rw - 0.5;
        radY[k] = ((rb[3] - Y) / (rb[3] - rb[1])) * rh - 0.5;
        radW[k] = radarWeight(lat, lng);
      }
    }
  })();

  // Rejilla gruesa (1/3) para el modelo: es suave por naturaleza y luego se interpola
  const CWd = Math.ceil(W / 3), CHd = Math.ceil(H / 3);
  const coarseLat = new Float32Array(CWd * CHd), coarseLng = new Float32Array(CWd * CHd);
  for (let j = 0; j < CHd; j++) for (let i = 0; i < CWd; i++) {
    const k = Math.min(H - 1, j * 3 + 1) * W + Math.min(W - 1, i * 3 + 1);
    coarseLat[j * CWd + i] = cellLat[k]; coarseLng[j * CWd + i] = cellLng[k];
  }

  function bilinear(g, w, h, x, y) {
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    return g[y0 * w + x0] * (1 - fx) * (1 - fy) + g[y0 * w + x1] * fx * (1 - fy) + g[y1 * w + x0] * (1 - fx) * fy + g[y1 * w + x1] * fx * fy;
  }
  const bilinearClamp = (g, w, h, x, y) => bilinear(g, w, h, clamp(x, 0, w - 1), clamp(y, 0, h - 1));

  // ---------- Movimiento de la lluvia ----------
  const F = 4; // reducción para estimar movimiento
  const B = 8; // tamaño de bloque (~32 km)
  const S = 7; // búsqueda ±7 celdas reducidas (~28 km por intervalo)

  function downsample(g, w, h) {
    const Wd = Math.floor(w / F), Hd = Math.floor(h / F), o = new Float32Array(Wd * Hd);
    for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) {
      let s = 0;
      for (let yy = 0; yy < F; yy++) for (let xx = 0; xx < F; xx++) s += Math.log1p(g[(y * F + yy) * w + x * F + xx]);
      o[y * Wd + x] = s / (F * F);
    }
    return { g: o, w: Wd, h: Hd };
  }

  function blockMotion(a, b) {
    const Wd = a.w, Hd = a.h;
    const nbx = Math.floor(Wd / B), nby = Math.floor(Hd / B);
    const vx = new Float32Array(nbx * nby).fill(NaN), vy = new Float32Array(nbx * nby).fill(NaN);
    for (let by = 0; by < nby; by++) {
      for (let bx = 0; bx < nbx; bx++) {
        const X0 = bx * B, Y0 = by * B;
        let energy = 0;
        for (let yy = 0; yy < B; yy++) for (let xx = 0; xx < B; xx++) energy += b.g[(Y0 + yy) * Wd + X0 + xx];
        if (energy < B * B * 0.12) continue;
        const cost = new Float32Array((2 * S + 1) * (2 * S + 1));
        let best = Infinity, bdx = 0, bdy = 0;
        for (let dy = -S; dy <= S; dy++) {
          for (let dx = -S; dx <= S; dx++) {
            let sad = 0;
            for (let yy = 0; yy < B; yy++) {
              const Y = Y0 + yy - dy;
              for (let xx = 0; xx < B; xx++) {
                const X = X0 + xx - dx;
                const va = X >= 0 && Y >= 0 && X < Wd && Y < Hd ? a.g[Y * Wd + X] : 0;
                sad += Math.abs(b.g[(Y0 + yy) * Wd + X0 + xx] - va);
              }
            }
            sad += 0.0005 * (dx * dx + dy * dy) * energy;
            cost[(dy + S) * (2 * S + 1) + dx + S] = sad;
            if (sad < best) { best = sad; bdx = dx; bdy = dy; }
          }
        }
        const at = (dx, dy) => cost[(dy + S) * (2 * S + 1) + dx + S];
        let sx = 0, sy = 0;
        if (bdx > -S && bdx < S) { const l = at(bdx - 1, bdy), c = at(bdx, bdy), r = at(bdx + 1, bdy); const d = l - 2 * c + r; if (d > 0) sx = clamp((l - r) / (2 * d), -0.5, 0.5); }
        if (bdy > -S && bdy < S) { const u = at(bdx, bdy - 1), c = at(bdx, bdy), dn = at(bdx, bdy + 1); const d = u - 2 * c + dn; if (d > 0) sy = clamp((u - dn) / (2 * d), -0.5, 0.5); }
        vx[by * nbx + bx] = bdx + sx;
        vy[by * nbx + bx] = bdy + sy;
      }
    }
    return { vx, vy, nbx, nby };
  }

  function fillAndSmooth(m) {
    const { vx, vy, nbx, nby } = m;
    const valid = [];
    for (let i = 0; i < vx.length; i++) if (Number.isFinite(vx[i])) valid.push(i);
    const med = (arr) => { const s = valid.map((i) => arr[i]).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
    const mx = med(vx), my = med(vy);
    valid.forEach((i) => { if (Math.hypot(vx[i] - mx, vy[i] - my) > 5) { vx[i] = NaN; vy[i] = NaN; } });
    for (let i = 0; i < vx.length; i++) if (!Number.isFinite(vx[i])) { vx[i] = mx; vy[i] = my; }
    for (let pass = 0; pass < 2; pass++) {
      const ax = vx.slice(), ay = vy.slice();
      for (let y = 0; y < nby; y++) for (let x = 0; x < nbx; x++) {
        let sx = 0, sy = 0, n = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
          const xx = x + i, yy = y + j;
          if (xx < 0 || yy < 0 || xx >= nbx || yy >= nby) continue;
          sx += ax[yy * nbx + xx]; sy += ay[yy * nbx + xx]; n++;
        }
        vx[y * nbx + x] = sx / n; vy[y * nbx + x] = sy / n;
      }
    }
    return { ...m, mx, my, nValid: valid.length };
  }

  // ---------- Modelo numérico ----------
  function modelAt(model, name, tSec, lat, lng) {
    const { times, lats, lons, vars } = model;
    const arr = vars[name];
    if (!arr) return 0;
    const ny = lats.length, nx = lons.length;
    let a = 0;
    while (a < times.length - 2 && times[a + 1] <= tSec) a++;
    const f = clamp((tSec - times[a]) / (times[a + 1] - times[a]));
    const step = lats[1] - lats[0];
    const fi = (lng - lons[0]) / step, fj = (lat - lats[0]) / step;
    const val = (ti) => {
      const i0 = clamp(Math.floor(fi), 0, nx - 1), j0 = clamp(Math.floor(fj), 0, ny - 1);
      const i1 = Math.min(nx - 1, i0 + 1), j1 = Math.min(ny - 1, j0 + 1);
      const ux = clamp(fi - i0), uy = clamp(fj - j0);
      const g = (j, i) => arr[(ti * ny + j) * nx + i] || 0;
      return g(j0, i0) * (1 - ux) * (1 - uy) + g(j0, i1) * ux * (1 - uy) + g(j1, i0) * (1 - ux) * uy + g(j1, i1) * ux * uy;
    };
    return val(a) * (1 - f) + val(a + 1) * f;
  }
  function modelCoarse(model, name, tSec, positive) {
    const c = new Float32Array(CWd * CHd);
    for (let q = 0; q < c.length; q++) { const v = modelAt(model, name, tSec, coarseLat[q], coarseLng[q]); c[q] = positive ? Math.max(0, v) : v; }
    return c;
  }

  // ---------- Radar: imágenes cada 30 min de las últimas 6 h ----------
  async function loadRadar() {
    const r = await fetch("/api/radar/tiempos", { cache: "no-store" });
    if (!r.ok) throw new Error("tiempos");
    const data = await r.json();
    const times = (data.capas.LNB_CAPPI_Z_450Km_1Km_cappi_dBZ || []).map((t) => [t, Date.parse(t)]);
    if (!times.length) throw new Error("sin radar");
    const last = times[times.length - 1];
    if (Date.now() - last[1] > 90 * 60000) throw new Error("radar viejo");
    const pick = (mins) => {
      const target = last[1] - mins * 60000;
      let best = null;
      times.forEach((t) => { if (!best || Math.abs(t[1] - target) < Math.abs(best[1] - target)) best = t; });
      return best && Math.abs(best[1] - target) <= 15 * 60000 ? best : null;
    };
    const frames = {};
    await Promise.all(Array.from({ length: 13 }, (_, i) => i * 30).map(async (m) => {
      const p = m === 0 ? last : pick(m);
      if (!p) return;
      try { const g = await C.radarRain(p[0]); g.t = p[1]; frames[-m] = g; } catch (e) { /* imagen faltante */ }
    }));
    if (!frames[0]) throw new Error("sin imagen actual");
    // Mosaico con el radar del IMN (solo si su imagen está al día)
    let mosaic = null;
    if (C.imnRadar) {
      try {
        const imn = await C.imnRadar.load();
        mosaic = { fresh: imn.fresh, time: imn.time };
        if (imn.fresh) { const b = C.imnRadar.blend(frames[0].grid); frames[0].grid = b.grid; mosaic.ratio = b.ratio; }
      } catch (e) { mosaic = null; }
    }
    return { time: last[0], frames, mosaic };
  }

  // ---------- Calibración con estaciones del IMN (sesgo medio de campo) ----------
  async function calibrate(radar) {
    if (!C.stations) return null;
    let data;
    try { data = await C.stations.load(); } catch (e) { return null; }
    const rb = C.RADAR_AREA.bbox, rw = C.RADAR_AREA.w, rh = C.RADAR_AREA.h;
    const endMs = radar.frames[0].t;
    let sumG = 0, sumR = 0, n = 0;
    data.imn.forEach((s) => {
      if (!s.q || radarWeight(s.lat, s.lng || s.lon) < 0.9) return;
      const g = C.stations.accum(s, 3, endMs);
      if (g == null) return;
      // Lluvia del radar acumulada en 3 h (imágenes cada 30 min)
      const [X, Y] = C.merc(s.lat, s.lon);
      const x = ((X - rb[0]) / (rb[2] - rb[0])) * rw - 0.5, y = ((rb[3] - Y) / (rb[3] - rb[1])) * rh - 0.5;
      let r = 0, used = 0;
      for (let m = 0; m <= 180; m += 30) {
        const f = radar.frames[-m];
        if (!f) continue;
        // promedio en una ventana de 3×3 celdas (~3 km) para tolerar la ubicación aproximada
        let v = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) v += bilinear(f.grid, rw, rh, x + dx, y + dy);
        r += (v / 9) * (m === 0 || m === 180 ? 0.25 : 0.5);
        used++;
      }
      if (used < 5) return;
      if (g < 0.5 && r < 0.5) return;
      sumG += g; sumR += r; n++;
    });
    if (n < 3 || sumR < 1) return { factor: 1, n, used: false };
    return { factor: clamp(sumG / sumR, 0.33, 3), n, used: true };
  }

  // ---------- Cálculo ----------
  const chan = new MessageChannel();
  const waiting = [];
  chan.port1.onmessage = () => { const r = waiting.shift(); if (r) r(); };
  const pause = () => new Promise((r) => { waiting.push(r); chan.port2.postMessage(0); });

  // Satélite: horas disponibles y rejillas sobre el área del índice (se piden en paralelo)
  async function loadSat(key, hours, tolMin, post) {
    if (!C.gibsTimes) return null;
    const times = await C.gibsTimes(key, hours);
    if (!times.length) return null;
    const grids = new Map();
    const get = (t) => {
      if (!grids.has(t)) grids.set(t, C.gibsGrid(key, new Date(t).toISOString().slice(0, 19) + "Z", AREA, key === "imerg30" ? 8 : 4).then((g) => (post ? post(g.grid) : g.grid)).catch(() => null));
      return grids.get(t);
    };
    const pick = (ms) => { let b = null, bd = Infinity; times.forEach((t) => { const d = Math.abs(t - ms); if (d < bd) { bd = d; b = t; } }); return bd <= tolMin * 60000 ? b : null; };
    return { times, get, pick, last: times[times.length - 1] };
  }

  // GOES: de la temperatura de los topes (°C) salen la lluvia estimada y la nubosidad (topes fríos = nublado)
  function goesPost(T) {
    const rain = new Float32Array(N), cloud = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const t = T[k];
      if (!Number.isFinite(t)) { rain[k] = NaN; cloud[k] = NaN; continue; }
      rain[k] = C.goesRain(t);
      cloud[k] = 100 * clamp((22 - t) / 27);
    }
    return { rain, cloud };
  }

  // Estaciones: la serie horaria (IMN + IMHPA) remuestreada al área del índice
  function prepareStations(serie) {
    if (!serie || !C.stations.AREA) return null;
    const A = C.stations.AREA;
    const lastObs = serie.steps.filter((st) => st.kind !== "pronostico").pop();
    let covLast = null;
    const steps = serie.steps.map((st) => {
      const g = C.resample(st.grid, A.w, A.h, W, H);
      let cov = null;
      if (st.ws) {
        const c = C.resample(st.ws, A.w, A.h, W, H);
        cov = new Uint8Array(N);
        for (let k = 0; k < N; k++) cov[k] = Math.round(255 * clamp((c[k] - A.MIN_W) / 0.5));
        if (st === lastObs) covLast = cov;
      }
      return { end: st.time.getTime(), h: st.h, grid: g, cov, fc: st.kind === "pronostico" };
    });
    steps.forEach((st) => { if (!st.cov) st.cov = covLast; });
    return { steps, t0: serie.t0, n: serie.nStations, nPa: serie.nPa || 0 };
  }
  const estStepAt = (est, ms) => est && est.steps.find((st) => ms > st.end - 3600000 && ms <= st.end + 60000);

  // Desplazamiento de una rejilla (persistencia de la lluvia de GOES hacia adelante)
  function shift(g, dx, dy) {
    const out = new Float32Array(N);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) out[j * W + i] = bilinear(g, W, H, i - dx, j - dy);
    return out;
  }

  // Combina las fuentes de lluvia de un paso con los pesos actuales
  function combineRain(st) {
    const w = RW();
    const P = st.parts;
    const mr = C.resample(P.mrC, CWd, CHd, W, H);
    const rain = st.rain || new Float32Array(N);
    const eq = P.est && P.est.q;
    for (let k = 0; k < N; k++) {
      let num = w.model * (Number.isFinite(mr[k]) ? mr[k] : 0), den = w.model;
      if (P.rr && w.radar) { const q = radW[k] * P.wTime; if (q > 0) { num += w.radar * q * P.rr[k] / 100; den += w.radar * q; } }
      if (P.est && w.est) { const q = (eq ? eq[k] / 255 : 0) * P.est.decay; const v = P.est.grid[k]; if (q > 0 && Number.isFinite(v)) { num += w.est * q * v; den += w.est * q; } }
      if (P.goes && w.goes) { const v = P.goes[k]; if (Number.isFinite(v)) { const q = P.goesQ; num += w.goes * q * v * goesFactor; den += w.goes * q; } }
      if (P.imerg && w.imerg) { const v = P.imerg[k]; if (Number.isFinite(v)) { num += w.imerg * v; den += w.imerg; } }
      rain[k] = den > 0 ? num / den : 0;
    }
    st.rain = rain;
  }

  // Sesgo de GOES frente a las estaciones (lluvia acumulada en 3 h)
  async function calibrateSat(sat, endMs) {
    if (!sat || !C.stations) return null;
    let data;
    try { data = await C.stations.load(); } catch (e) { return null; }
    const frames = [];
    for (let m = 150; m >= 0; m -= 30) { const t = sat.pick(endMs - m * 60000); if (t) { const g = await sat.get(t); frames.push(g && g.rain); } }
    const ok = frames.filter(Boolean);
    if (ok.length < 4) return null;
    const [x0, y0, x1, y1] = AREA.bbox;
    let sg = 0, ss = 0, n = 0;
    (data.hourly || data.imn).forEach((s) => {
      if (!s.q || !s.rows.length) return;
      const g = C.stations.accum(s, 3, s.rows[0][0]);
      if (g == null || Math.abs(s.rows[0][0] - endMs) > 90 * 60000) return;
      const [X, Y] = C.merc(s.lat, s.lon);
      const i = ((X - x0) / (x1 - x0)) * W - 0.5, j = ((y1 - Y) / (y1 - y0)) * H - 0.5;
      if (i < 0 || j < 0 || i > W - 1 || j > H - 1) return;
      let est = 0;
      ok.forEach((f) => { est += bilinear(f, W, H, i, j) * 0.5; });
      est *= 6 / ok.length;
      if (g < 0.5 && est < 0.5) return;
      sg += g; ss += est; n++;
    });
    if (n < 5 || ss < 1) return { factor: 1, n, used: false };
    return { factor: clamp(sg / ss, 0.15, 2.5), n, used: true };
  }

  async function run() {
    if (computing) return;
    computing = true;
    setStatus("Leyendo radar, estaciones, satélites y modelo…");
    try {
      const [radar, , model, serie, goes, imerg] = await Promise.all([
        loadRadar().catch(() => null),
        loadMask(),
        fetch("/api/celeste/modelo?v=2").then((r) => { if (!r.ok) throw new Error("modelo"); return r.json(); }),
        C.stations && C.stations.serie ? C.stations.serie().catch(() => null) : null,
        loadSat("goestemp", 7, 16, goesPost).catch(() => null),
        loadSat("imerg30", 12, 16).catch(() => null),
      ]);
      radarOK = !!radar;
      t0 = radar ? new Date(radar.time) : new Date(Math.floor(Date.now() / 600000) * 600000);
      calib = radar ? await calibrate(radar) : null;
      const factor = calib && calib.used ? calib.factor : 1;
      const est = prepareStations(serie);
      // GOES: imágenes para los pasos observados (en paralelo) y calibración con estaciones
      if (goes) STEPS.forEach((L) => { if (L <= 0) { const t = goes.pick(t0.getTime() + L * 60000); if (t) goes.get(t); } });
      if (imerg) STEPS.forEach((L) => { if (L <= 0) { const t = imerg.pick(t0.getTime() + L * 60000); if (t) imerg.get(t); } });
      // La calibración de GOES corre en paralelo; mientras tanto se usa un factor prudente y luego se recombina
      calibG = null;
      goesFactor = 0.5;
      const calibProm = goes ? calibrateSat(goes, t0.getTime()).catch(() => null) : Promise.resolve(null);
      setStatus(radarOK ? "Calculando el movimiento de la lluvia…" : "Sin radar en este momento: se combinan estaciones, satélites y modelo.");
      await pause();

      // Movimiento con las imágenes de −60, −30 y 0 min
      let motion = null;
      if (radar) {
        const seq = [radar.frames[-60], radar.frames[-30], radar.frames[0]].filter(Boolean).map((r) => ({ d: downsample(r.grid, r.w, r.h), t: r.t }));
        let sx = 0, sy = 0, n = 0, combo = null;
        for (let i = 0; i < seq.length - 1; i++) {
          const m = fillAndSmooth(blockMotion(seq[i].d, seq[i + 1].d));
          const dt = (seq[i + 1].t - seq[i].t) / 60000;
          if (!(dt > 0)) continue;
          const k = F / dt;
          if (!combo) combo = { vx: new Float32Array(m.vx.length), vy: new Float32Array(m.vy.length), nbx: m.nbx, nby: m.nby };
          for (let q = 0; q < m.vx.length; q++) { combo.vx[q] += m.vx[q] * k; combo.vy[q] += m.vy[q] * k; }
          sx += m.mx * k; sy += m.my * k; n++;
        }
        if (combo && n) {
          for (let q = 0; q < combo.vx.length; q++) { combo.vx[q] /= n; combo.vy[q] /= n; }
          motion = { ...combo, meanX: sx / n, meanY: sy / n };
        }
      }
      // Desplazamiento medio en celdas del índice por minuto (para proyectar GOES)
      const idxCellKm = ((AREA.bbox[2] - AREA.bbox[0]) / W / 1000) * Math.cos(9.7 * toRad);
      const mvx = motion ? (motion.meanX * radarCellKm) / idxCellKm : 0, mvy = motion ? (motion.meanY * radarCellKm) / idxCellKm : 0;
      const goesLast = goes ? await goes.get(goes.last) : null;
      const goesLastAge = goes ? (t0.getTime() - goes.last) / 60000 : 0;

      steps.forEach((s) => s.layer && map.removeLayer(s.layer));
      steps = [];
      const rw = C.RADAR_AREA.w, rh = C.RADAR_AREA.h;
      const latest = radar ? radar.frames[0] : null;
      const used = { radar: false, est: false, goes: 0, imerg: 0 };

      const order = [NOW_I];
      for (let d = 1; d <= 12; d++) { order.push(NOW_I + d); order.push(NOW_I - d); }

      for (const si of order) {
        const L = STEPS[si];
        const ms = t0.getTime() + L * 60000;
        const tSec = ms / 1000;
        // Radar: observado (pasado/ahora) o proyectado (futuro)
        let radarField = null, wTime = 0, sigma = 0.9;
        if (radar) {
          if (L <= 0) { radarField = radar.frames[L] || null; wTime = radarField ? 1 : 0; }
          else { radarField = latest; wTime = clamp(1 - L / BLEND_END); sigma = 0.9 + (L / 60) * 1.6; }
        }
        let rr16 = null;
        if (radarField && wTime > 0) {
          const rr = new Float32Array(N);
          const decay = L > 0 ? Math.exp(-L / 150) : 1;
          for (let k = 0; k < N; k++) {
            if (radW[k] <= 0) continue;
            let x = radX[k], y = radY[k];
            if (L > 0 && motion) {
              const bx = x / (F * B) - 0.5, by = y / (F * B) - 0.5;
              x -= bilinearClamp(motion.vx, motion.nbx, motion.nby, bx, by) * L;
              y -= bilinearClamp(motion.vy, motion.nbx, motion.nby, bx, by) * L;
            }
            rr[k] = bilinear(radarField.grid, rw, rh, x, y) * decay * factor;
          }
          const rrS = C.blur(rr, W, H, sigma);
          rr16 = new Uint16Array(N);
          for (let k = 0; k < N; k++) rr16[k] = Math.min(65535, Math.round((Number.isFinite(rrS[k]) ? rrS[k] : 0) * 100));
          used.radar = true;
        }
        // Estaciones: la hora que contiene este instante; en el pronóstico la confianza baja con el plazo
        const es = estStepAt(est, ms);
        const estPart = es ? { grid: es.grid, q: es.cov, decay: es.fc ? clamp(1 - Math.max(0, (ms - est.t0) / 3600000) / 8) : 1 } : null;
        if (estPart) used.est = true;
        // GOES: imagen de esa hora (pasado) o la última, desplazada con el movimiento de la lluvia (hasta +2 h)
        let goesG = null, goesQ = 0;
        if (goes) {
          if (L <= 0) { const t = goes.pick(ms) || (L === 0 && ms - goes.last <= 45 * 60000 ? goes.last : null); if (t) { goesG = await goes.get(t); goesQ = 1; } }
          else if (goesLast && L <= 120) { const dx = mvx * (L + goesLastAge), dy = mvy * (L + goesLastAge); goesG = { rain: shift(goesLast.rain, dx, dy), cloud: shift(goesLast.cloud, dx, dy) }; goesQ = clamp(1 - L / 120); }
          if (goesG) used.goes++;
        }
        // IMERG: solo donde hay imagen de esa hora (llega con unas 5 h de retraso)
        let imergG = null;
        if (imerg && L <= 0) { const t = imerg.pick(ms); if (t) { imergG = await imerg.get(t); if (imergG) used.imerg++; } }

        const st = {
          si, min: L, time: new Date(ms),
          parts: { rr: rr16, wTime, est: estPart, goes: goesG && goesG.rain, cloudG: goesG && goesG.cloud, goesQ, imerg: imergG, mrC: modelCoarse(model, "precipitation", tSec + 1800, true) },
          coarse: {
            cape: modelCoarse(model, "cape", tSec, true),
            gust: modelCoarse(model, "wind_gusts_10m", tSec + 1800, true),
            pp: modelCoarse(model, "precipitation_probability", tSec + 1800, true),
            heat: modelCoarse(model, "apparent_temperature", tSec, false),
            cloud: modelCoarse(model, "cloud_cover", tSec, true),
          },
          source: !radarField || wTime === 0 ? "modelo" : L < 0 ? "observado" : L === 0 ? "ahora" : "proyectado",
        };
        combineRain(st);
        steps[si] = st;
        computeIndex(st);
        if (si === NOW_I) { cur = NOW_I; drawBars(); show(NOW_I); $("#idxTimeline").hidden = !active; renderLoc(); }
        else drawBars();
        await pause();
      }
      calibG = await calibProm;
      if (calibG && calibG.used) {
        goesFactor = calibG.factor;
        steps.forEach((s) => { if (s && s.parts.goes) combineRain(s); });
      }
      // Con todos los pasos listos se puede evaluar la persistencia (Temporal) y recalcular
      steps.forEach((s) => s && computeIndex(s));
      drawBars(); show(cur);
      computedAt = Date.now();
      const motionTxt = motion ? ` La lluvia se desplaza hacia ${direction(motion.meanX, motion.meanY)} a unos ${C.fmtNum.format(speedKmh(motion.meanX, motion.meanY))} km/h.` : "";
      const mos = radar && radar.mosaic;
      const mosTxt = mos && !mos.fresh ? " El radar del IMN no publica imágenes recientes; no se incluye." : mos && mos.fresh ? " Radar del IMN incluido." : "";
      const calibTxt = calib ? (calib.used ? ` Radar ajustado con ${calib.n} estaciones (×${C.fmtNum1.format(calib.factor)}).` : "") : "";
      const parts = [];
      if (used.radar) parts.push("radar de COCESNA");
      if (used.est && est) parts.push(`${est.n} estaciones (${est.n - est.nPa} IMN, ${est.nPa} IMHPA)`);
      if (used.goes) parts.push(`GOES-Este${calibG && calibG.used ? ` (ajustado ×${C.fmtNum1.format(calibG.factor)})` : ""}`);
      if (used.imerg) parts.push(`IMERG en ${used.imerg} pasos`);
      parts.push("modelo");
      sourcesUsed = used;
      setStatus(`Lluvia combinada de ${parts.join(", ")}.${radarOK ? ` Radar de las ${C.fmtHour.format(t0)}`.replace(/\.?$/, ".") : ""}${motionTxt}${calibTxt}${mosTxt}`);
      renderWeights();
      checkAlerts();
      $("#idxTimeline").hidden = !active;
    } catch (err) {
      console.error("indice", err);
      setStatus("No se pudo calcular el índice. Vuelve a intentarlo en unos minutos.");
      C.toast("No se pudo calcular el índice CELESTE en este momento.");
    }
    computing = false;
  }

  const radarCellKm = (() => {
    const [x0, , x1] = C.RADAR_AREA.bbox;
    return ((x1 - x0) / C.RADAR_AREA.w / 1000) * Math.cos(9.7 * toRad);
  })();
  const speedKmh = (vx, vy) => Math.hypot(vx, vy) * radarCellKm * 60;
  function direction(vx, vy) {
    const ang = (Math.atan2(vx, -vy) * 180 / Math.PI + 360) % 360;
    return ["el norte", "el noreste", "el este", "el sureste", "el sur", "el suroeste", "el oeste", "el noroeste"][Math.round(ang / 45) % 8];
  }

  function computeIndex(st) {
    const full = {};
    MODEL_KEYS.forEach((k) => (full[k] = C.resample(st.coarse[k], CWd, CHd, W, H)));
    const P = st.parts || {};
    const nb = [-2, -1, 1, 2].map((d) => steps[st.si + d]).filter((x) => x && x.rain);
    const idx = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      if (mask && !mask[k]) { idx[k] = NaN; continue; }
      const R = st.rain[k];
      let persist = 0;
      if (R >= 7.6 && nb.length) { let sm = R; nb.forEach((x) => (sm += x.rain[k])); persist = sm / (nb.length + 1); }
      let cloud = full.cloud[k];
      if (P.cloudG) { const g = P.cloudG[k]; if (Number.isFinite(g)) { const q = 0.75 * P.goesQ; cloud = q * Math.max(g, cloud) + (1 - q) * cloud; } }
      idx[k] = ladder(R, cloud, full.pp[k], full.cape[k], full.gust[k], persist);
    }
    st.index = idx;
    const sample = [];
    for (let k = 0; k < N; k += 5) if (Number.isFinite(idx[k])) sample.push(idx[k]);
    sample.sort((a, b) => a - b);
    st.p90 = sample[Math.floor(sample.length * 0.9)] || 0;
    st.max = sample[sample.length - 1] || 0;
    const wasShown = st.layer && map.hasLayer(st.layer);
    if (st.layer) map.removeLayer(st.layer);
    st.layer = null;
    if (wasShown && active && steps[cur] === st) ensureLayer(st).addTo(map);
  }

  // Valores de una celda en un paso (para la ficha)
  function cellInfo(st, k, ck) {
    const P = st.parts || {};
    const m = (key) => st.coarse[key][ck];
    let cloud = m("cloud");
    if (P.cloudG && Number.isFinite(P.cloudG[k])) { const q = 0.75 * P.goesQ; cloud = q * Math.max(P.cloudG[k], cloud) + (1 - q) * cloud; }
    return { R: st.rain[k], cloud, pp: m("pp"), cape: m("cape"), gust: m("gust"), heat: m("heat"), v: st.index[k] };
  }

  function ensureLayer(st) {
    if (!st.layer) st.layer = layerOf(C.polygons(st.index, W, H, AREA.bbox, IDX));
    return st.layer;
  }

  // Silueta de Costa Rica (Natural Earth 1:50 m) con una franja costera de ~10 km
  let mask = null;
  async function loadMask() {
    if (mask) return mask;
    try {
      const topo = await fetch("https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json").then((r) => r.json());
      const geo = topojson.feature(topo, topo.objects.countries);
      const cr = geo.features.find((f) => String(f.id) === "188");
      if (!cr) return null;
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      const [x0, y0, x1, y1] = AREA.bbox;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      const polys = cr.geometry.type === "Polygon" ? [cr.geometry.coordinates] : cr.geometry.coordinates;
      polys.forEach((poly) => poly.forEach((ring) => ring.forEach(([lng, lat], i) => {
        const [X, Y] = C.merc(lat, lng);
        const px = ((X - x0) / (x1 - x0)) * W, py = ((y1 - Y) / (y1 - y0)) * H;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      })));
      ctx.fill("evenodd");
      const a = ctx.getImageData(0, 0, W, H).data;
      const m = new Float32Array(N);
      for (let k = 0; k < N; k++) m[k] = a[k * 4 + 3] / 255;
      const soft = C.blur(m, W, H, 7);
      mask = new Uint8Array(N);
      for (let k = 0; k < N; k++) mask[k] = soft[k] > 0.1 ? 1 : 0;
      return mask;
    } catch (e) {
      return null;
    }
  }

  // ---------- Línea de tiempo ----------
  const bars = $("#idxBars");
  const btnPlay = $("#idxPlay");

  const leadWords = (min) => { const m = Math.abs(min); return m < 60 ? `${m} min` : `${Number.isInteger(m / 60) ? m / 60 : (m / 60).toFixed(1).replace(".", ",")} h`; };
  const fmtLead = (min) => (min === 0 ? "Ahora" : `${min < 0 ? "−" : "+"}${leadWords(min)}`);
  const whenText = (st) => {
    const h = C.fmtHour.format(st.time);
    if (st.min === 0) return `Ahora · ${h}`;
    return st.min < 0 ? `Hace ${leadWords(st.min)} · ${h} · observado` : `Dentro de ${leadWords(st.min)} · ${h} · pronóstico`;
  };
  const sourceText = (st) => ({
    observado: "observado: radar, estaciones y satélites",
    ahora: radarOK ? `radar de ${C.ago(st.time)}, estaciones y satélites` : "estaciones, satélites y modelo",
    proyectado: "pronóstico: radar proyectado, estaciones y modelo",
    modelo: st.min < 0 ? "observado: estaciones, satélites y modelo" : "pronóstico: estaciones corregidas y modelo",
  })[st.source];

  function drawBars() {
    bars.innerHTML = "";
    STEPS.forEach((m, i) => {
      const st = steps[i];
      const b = document.createElement("span");
      b.className = "tl-bar" + (st ? "" : " loading") + (i === cur ? " current" : "") + (m < 0 ? " past" : "") + (m === 0 ? " now" : "");
      if (st) {
        const l = levelOf(st.p90);
        b.style.height = `${6 + 28 * clamp(st.p90 / 90)}px`;
        b.style.background = i === cur ? "" : levelColor(l);
        b.title = `${fmtLead(st.min)}, ${C.fmtHour.format(st.time)}: el 10 % del país llega a ${LEVELS[l].n} o más`;
      } else b.style.height = "4px";
      bars.appendChild(b);
    });
    bars.setAttribute("aria-valuemax", String(STEPS.length - 1));
    if (t0) {
      $("#idxStart").textContent = C.fmtHour.format(new Date(t0.getTime() + STEPS[0] * 60000));
      $("#idxEnd").textContent = C.fmtHour.format(new Date(t0.getTime() + STEPS[STEPS.length - 1] * 60000));
    }
  }

  function show(i) {
    i = clamp(i, 0, STEPS.length - 1);
    if (!steps[i]) return;
    const prev = steps[cur];
    cur = i;
    const st = steps[cur];
    if (active) { const lyr = ensureLayer(st); if (!map.hasLayer(lyr)) lyr.addTo(map); }
    if (prev && prev !== st && prev.layer) map.removeLayer(prev.layer);
    [...bars.children].forEach((b, j) => {
      b.classList.toggle("current", j === cur);
      if (steps[j]) b.style.background = j === cur ? "" : levelColor(levelOf(steps[j].p90));
    });
    $("#idxTime").textContent = whenText(st).split(" · ").slice(0, 2).join(" · ");
    $("#idxAgo").textContent = sourceText(st);
    bars.setAttribute("aria-valuenow", String(cur));
    bars.setAttribute("aria-valuetext", whenText(st));
    updateClouds(st);
  }

  function play() {
    if (timer || steps.filter(Boolean).length < 2) return;
    btnPlay.classList.add("playing");
    btnPlay.setAttribute("aria-label", "Pausar la animación");
    const step = () => {
      const next = cur >= STEPS.length - 1 ? 0 : cur + 1;
      show(next);
      timer = setTimeout(step, next === STEPS.length - 1 ? 1800 : next === NOW_I ? 1200 : 650);
    };
    timer = setTimeout(step, 200);
  }
  function stop() {
    clearTimeout(timer); timer = null;
    btnPlay.classList.remove("playing");
    btnPlay.setAttribute("aria-label", "Reproducir la animación");
  }
  btnPlay.addEventListener("click", () => (timer ? stop() : play()));
  const pick = (e) => { const r = bars.getBoundingClientRect(); stop(); show(Math.floor(((e.clientX - r.left) / r.width) * STEPS.length)); };
  let dragging = false;
  bars.addEventListener("pointerdown", (e) => { dragging = true; bars.setPointerCapture(e.pointerId); pick(e); });
  bars.addEventListener("pointermove", (e) => { if (dragging) pick(e); });
  bars.addEventListener("pointerup", () => (dragging = false));
  bars.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { stop(); show(cur - 1); e.preventDefault(); }
    if (e.key === "ArrowRight") { stop(); show(cur + 1); e.preventDefault(); }
    if (e.key === "Home") { stop(); show(NOW_I); e.preventDefault(); }
    if (e.key === " ") { timer ? stop() : play(); e.preventDefault(); }
  });

  // ---------- Nubes reales debajo del índice (GOES-Este en color, a la hora de cada paso) ----------
  map.createPane("idxnubes").style.zIndex = 425;
  map.getPane("idxnubes").style.pointerEvents = "none";
  let cloudTimes = null;
  const cloudLayers = new Map();
  async function updateClouds(st) {
    const on = active && VIZ.nubes && st;
    if (!on) { cloudLayers.forEach((l) => l.setOpacity(0)); return; }
    if (!cloudTimes) { try { cloudTimes = await C.gibsTimes("geocolor", 8); } catch (e) { cloudTimes = []; } }
    if (!cloudTimes.length) return;
    const ms = st.time.getTime() + 5 * 60000;
    let t = cloudTimes[0];
    cloudTimes.forEach((x) => { if (x <= ms) t = x; });
    const iso = new Date(t).toISOString().slice(0, 19) + "Z";
    let lyr = cloudLayers.get(iso);
    if (!lyr) {
      lyr = L.tileLayer(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_GeoColor/default/${iso}/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png`, { pane: "idxnubes", maxNativeZoom: 7, maxZoom: 16, opacity: 0, className: "imagen-suave", errorTileUrl: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }).addTo(map);
      cloudLayers.set(iso, lyr);
      if (cloudLayers.size > 8) { const k0 = cloudLayers.keys().next().value; map.removeLayer(cloudLayers.get(k0)); cloudLayers.delete(k0); }
    }
    if (!(active && VIZ.nubes) || steps[cur] !== st) return;
    cloudLayers.forEach((l, k) => l.setOpacity(k === iso ? 0.8 : 0));
  }

  // ---------- Panel ----------
  function setStatus(t) { const el = $("#idxStatus"); if (el) el.textContent = t; }

  function renderLegend() {
    $("#idxLegend").innerHTML = `
      <div class="lvl-scale" aria-hidden="true">${LEVELS.map((L, l) => `<span style="background:${l === 0 ? "transparent" : levelColor(l)};opacity:${l === 0 ? 1 : IDX.alphas[l === 1 ? 1 : l]}" class="${l === 0 ? "transp" : ""}"></span>`).join("")}</div>
      <details class="lvl-box" open><summary>Qué significa cada peldaño</summary>
        <ul class="lvl-list">${LEVELS.map((L, l) => `<li title="${L.rule}">${levelBadge(l)}<span class="lvl-n">${l}</span><span><b>${L.n}</b><span class="muted">${L.d}</span></span></li>`).join("")}</ul>
        <p class="w-note">"Pura vida" no se colorea: deja ver el terreno y las nubes. Pasa el cursor sobre un peldaño para ver su regla.</p>
      </details>`;
  }

  function renderViz() {
    $("#idxViz").innerHTML = `
      <details class="idx-box" open><summary>Visualización</summary>
        <div class="opacity"><span>Opacidad</span><input type="range" id="vizOp" min="0.3" max="1" step="0.05" value="${VIZ.op}" aria-label="Opacidad del índice"></div>
        <label class="viz-row">Mostrar desde
          <select id="vizDesde">${[1, 2, 3, 4, 5, 6].map((l) => `<option value="${l}"${VIZ.desde === l ? " selected" : ""}>${LEVELS[l].n}</option>`).join("")}</select>
        </label>
        <label class="viz-check"><input type="checkbox" id="vizBordes"${VIZ.bordes ? " checked" : ""}> Bordes entre peldaños</label>
        <label class="viz-check"><input type="checkbox" id="vizNubes"${VIZ.nubes ? " checked" : ""}> Nubes reales del satélite debajo (GOES-Este)</label>
      </details>`;
  }
  const saveViz = () => store.set("celeste-viz", JSON.stringify(VIZ));
  function redrawLayers() {
    steps.forEach((s) => { if (s && s.layer) { map.removeLayer(s.layer); s.layer = null; } });
    show(cur);
  }
  document.addEventListener("input", (e) => {
    if (e.target.id === "vizOp") { VIZ.op = parseFloat(e.target.value); map.getPane("indice").style.opacity = VIZ.op; saveViz(); }
  });
  document.addEventListener("change", (e) => {
    const id = e.target.id;
    if (id === "vizDesde") { VIZ.desde = parseInt(e.target.value, 10); saveViz(); redrawLayers(); }
    if (id === "vizBordes") { VIZ.bordes = e.target.checked; saveViz(); redrawLayers(); }
    if (id === "vizNubes") { VIZ.nubes = e.target.checked; saveViz(); updateClouds(steps[cur]); }
    if (id === "alertOn" || id === "alertLvl") {
      ALERT.on = $("#alertOn").checked;
      ALERT.lvl = parseInt($("#alertLvl").value, 10);
      store.set("celeste-aviso", JSON.stringify(ALERT));
      if (ALERT.on && "Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
      scheduleRefresh();
      checkAlerts(true);
    }
  });

  function renderWeights() {
    const wrap = $("#idxWeights");
    const totalS = RSRC.reduce((s, c) => s + c.w, 0) || 1;
    const avail = (k) => !sourcesUsed || k === "model" || (k === "radar" ? sourcesUsed.radar : k === "est" ? sourcesUsed.est : sourcesUsed[k] > 0);
    wrap.innerHTML = `<p class="w-note">La lluvia de cada punto es un promedio de las fuentes que tienen dato ahí, con estos pesos. Los peldaños se definen con esa lluvia, la nubosidad, la probabilidad de lluvia, el potencial de tormenta y las ráfagas.</p>` + RSRC.map((c) => `
      <div class="weight${avail(c.key) ? "" : " sin-dato"}">
        <label for="ws-${c.key}">${c.src && C.SOURCES && C.SOURCES[c.src] ? `<span class="w-chip">${C.SOURCES[c.src].name}</span>` : ""}${c.name}${avail(c.key) ? "" : " <em>(sin dato ahora)</em>"}</label>
        <input id="ws-${c.key}" type="range" min="0" max="100" step="2" value="${c.w}" data-src="${c.key}">
        <output for="ws-${c.key}">${C.fmtNum.format((c.w / totalS) * 100)} %</output>
      </div>`).join("") + `<button type="button" class="link-btn" id="idxReset">Volver a los pesos sugeridos</button>`;
  }
  let resourceTimer = null;
  document.addEventListener("input", (e) => {
    const es = e.target.closest("#idxWeights input[data-src]");
    if (!es) return;
    RSRC.find((c) => c.key === es.dataset.src).w = parseInt(es.value, 10);
    const totalS = RSRC.reduce((s, c) => s + c.w, 0) || 1;
    document.querySelectorAll("#idxWeights input[data-src]").forEach((inp) => { inp.nextElementSibling.textContent = `${C.fmtNum.format((RSRC.find((c) => c.key === inp.dataset.src).w / totalS) * 100)} %`; });
    clearTimeout(resourceTimer);
    resourceTimer = setTimeout(() => {
      steps.forEach((s) => s && combineRain(s));
      steps.forEach((s) => s && computeIndex(s));
      drawBars(); show(cur); renderLoc();
      store.set("celeste-fuentes", JSON.stringify(RW()));
    }, 300);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#idxReset")) return;
    RSRC.forEach((c) => (c.w = SUGGESTED_SRC[c.key]));
    store.set("celeste-fuentes", JSON.stringify(RW()));
    renderWeights();
    steps.forEach((s) => s && combineRain(s));
    steps.forEach((s) => s && computeIndex(s));
    drawBars(); show(cur); renderLoc();
  });

  // ---------- Celdas y resúmenes por punto ----------
  function cellOf(lat, lng) {
    const [X, Y] = C.merc(lat, lng);
    const [x0, y0, x1, y1] = AREA.bbox;
    const i = Math.floor(((X - x0) / (x1 - x0)) * W), j = Math.floor(((y1 - Y) / (y1 - y0)) * H);
    if (i < 0 || j < 0 || i >= W || j >= H) return null;
    return { i, j, k: j * W + i, ck: Math.min(CHd - 1, Math.floor(j / 3)) * CWd + Math.min(CWd - 1, Math.floor(i / 3)) };
  }
  // Peldaño más alto, lluvia esperada y probabilidad de lluvia en una ventana de pasos.
  // Probabilidad: 60 % "de vecindario" (qué parte de los 10 km alrededor recibe lluvia en la ventana, según
  // radar, estaciones y satélite combinados) + 40 % probabilidad del modelo.
  function outlook(c, a, b) {
    let maxL = 0, at = null, mm = 0, ppMax = 0, n = 0;
    for (let i = a; i <= b; i++) {
      const st = steps[i];
      if (!st) continue;
      n++;
      const l = levelOf(st.index[c.k]);
      if (!at || l > maxL) { maxL = l; at = st; }
      mm += Math.max(0, st.rain[c.k]) * 0.5;
      ppMax = Math.max(ppMax, st.coarse.pp[c.ck] || 0);
    }
    if (!n) return null;
    let wet = 0, tot = 0;
    for (let dj = -8; dj <= 8; dj += 2) for (let di = -8; di <= 8; di += 2) {
      if (di * di + dj * dj > 64) continue;
      const ii = c.i + di, jj = c.j + dj;
      if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
      const q = jj * W + ii;
      tot++;
      for (let i = a; i <= b; i++) { const st = steps[i]; if (st && st.rain[q] >= 0.2) { wet++; break; } }
    }
    const neigh = tot ? (100 * wet) / tot : 0;
    return { maxL, at, mm, pp: Math.round(0.6 * neigh + 0.4 * ppMax), neigh: Math.round(neigh), ppModel: Math.round(ppMax) };
  }
  function confidence(c) {
    const st = steps[NOW_I];
    if (!st || !st.parts) return null;
    const qr = st.parts.rr ? radW[c.k] * st.parts.wTime : 0;
    const qe = st.parts.est && st.parts.est.q ? st.parts.est.q[c.k] / 255 : 0;
    if (qr >= 0.5 && qe >= 0.3) return ["alta", "hay radar y estaciones cerca"];
    if (qr >= 0.5) return ["media", "hay radar, pero pocas estaciones cerca"];
    if (qe >= 0.3) return ["media", "hay estaciones cerca, pero el radar no llega"];
    return ["baja", "solo satélite y modelo; no hay radar ni estaciones cerca"];
  }

  // ---------- Tu ubicación y avisos ----------
  let userLoc = (() => { try { const u = JSON.parse(store.get("celeste-ubicacion") || "null"); return u && Date.now() - u.t < 7 * 86400000 ? u : null; } catch (e) { return null; } })();
  let userPlace = null;
  const ALERT = Object.assign({ on: false, lvl: 5 }, (() => { try { return JSON.parse(store.get("celeste-aviso") || "{}"); } catch (e) { return {}; } })());
  let alertMsg = "";

  function renderLoc() {
    const el = $("#idxLoc");
    if (!el) return;
    if (!userLoc) {
      el.innerHTML = `<button type="button" class="loc-cta" id="idxLocBtn"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7.5"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/></svg><span><b>Usar mi ubicación</b><span>Para ver el pronóstico donde estás y recibir avisos</span></span></button>`;
      return;
    }
    const c = cellOf(userLoc.lat, userLoc.lng);
    const place = userPlace && userPlace.nombre ? userPlace.nombre : "Tu ubicación";
    let body = `<p class="w-note">Calculando…</p>`;
    if (c && steps[NOW_I]) {
      const l = levelOf(steps[NOW_I].index[c.k]);
      const o = outlook(c, NOW_I + 1, NOW_I + 12);
      body = `<div class="loc-now">${levelBadge(l, "big")}<div><span class="loc-name">${place}</span><b>Ahora: ${LEVELS[l].n}</b><span class="muted">${LEVELS[l].d}</span></div></div>
        ${o ? `<p class="loc-next">Próximas 6 h: hasta <b>${LEVELS[o.maxL].n}</b>${o.maxL > l ? ` hacia las ${C.fmtHour.format(o.at.time)}` : ""} · lluvia ${o.pp} % · ${C.fmtNum1.format(o.mm)} mm esperados.</p>` : ""}`;
    } else if (!c) body = `<p class="w-note">${place} está fuera del área del índice (Costa Rica).</p>`;
    el.innerHTML = `<div class="loc-card${alertMsg ? " alerta" : ""}">${body}
      ${alertMsg ? `<p class="loc-alert">${alertMsg}</p>` : ""}
      <div class="loc-actions"><button type="button" data-loc="ficha">Ver ficha</button><button type="button" data-loc="upd">Actualizar ubicación</button></div>
      <label class="viz-check alert-row"><input type="checkbox" id="alertOn"${ALERT.on ? " checked" : ""}> Avisarme si llega a
        <select id="alertLvl">${[3, 4, 5, 6, 7, 8, 9].map((x) => `<option value="${x}"${ALERT.lvl === x ? " selected" : ""}>${LEVELS[x].n}</option>`).join("")}</select></label>
      <p class="w-note">Los avisos llegan mientras Celeste esté abierto en este navegador (aunque sea en otra pestaña).</p>
    </div>`;
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest("#idxLocBtn")) { C.locate({ open: false, noPan: false }); return; }
    const b = e.target.closest("[data-loc]");
    if (!b || !userLoc) return;
    if (b.dataset.loc === "ficha") { map.setView([userLoc.lat, userLoc.lng], Math.max(map.getZoom(), 11)); map.fire("click", { latlng: L.latLng(userLoc.lat, userLoc.lng) }); }
    if (b.dataset.loc === "upd") C.locate({ noPan: false });
  });
  C.onLocation((lat, lng) => {
    userLoc = { lat, lng, t: Date.now() };
    userPlace = null;
    C.placeName(lat, lng).then((p) => { userPlace = p; renderLoc(); });
    renderLoc();
    checkAlerts();
  });
  if (userLoc) C.placeName(userLoc.lat, userLoc.lng).then((p) => { userPlace = p; renderLoc(); });

  function checkAlerts(fromUser) {
    alertMsg = "";
    if (!ALERT.on || !userLoc || !steps[NOW_I]) { renderLoc(); return; }
    const c = cellOf(userLoc.lat, userLoc.lng);
    if (!c) { renderLoc(); return; }
    let hit = null;
    for (let i = NOW_I; i < STEPS.length; i++) { const st = steps[i]; if (st && levelOf(st.index[c.k]) >= ALERT.lvl) { hit = st; break; } }
    if (hit) {
      const l = levelOf(hit.index[c.k]);
      const when = hit.min === 0 ? "ahora" : `hacia las ${C.fmtHour.format(hit.time)} (dentro de ${leadWords(hit.min)})`;
      alertMsg = `Aviso: se espera ${LEVELS[l].n} en ${userPlace && userPlace.nombre ? userPlace.nombre : "tu ubicación"} ${when}.`;
      const key = `${ALERT.lvl}|${Math.round(hit.time.getTime() / 3600000)}`;
      if (store.get("celeste-aviso-ultimo") !== key) {
        store.set("celeste-aviso-ultimo", key);
        C.toast(alertMsg, 10000);
        if ("Notification" in window && Notification.permission === "granted") {
          try { new Notification("Celeste · " + LEVELS[l].n, { body: alertMsg.replace(/^Aviso: /, ""), icon: "/favicon.svg", tag: "celeste-aviso" }); } catch (e) { /* sin notificaciones */ }
        }
      }
    } else if (fromUser) C.toast(`Listo: te avisaremos si tu ubicación llega a ${LEVELS[ALERT.lvl].n} en las próximas 6 horas.`);
    renderLoc();
  }

  function scheduleRefresh() {
    clearInterval(refresh);
    if (active || ALERT.on) refresh = setInterval(() => { if (active || ALERT.on) run(); }, 10 * 60000);
  }

  renderLegend();
  renderViz();
  renderWeights();
  renderLoc();

  // ---------- Activar / desactivar ----------
  function setActive(on) {
    active = on;
    document.body.classList.toggle("modo-indice", on);
    document.querySelectorAll("[data-indice-btn]").forEach((b) => b.setAttribute("aria-pressed", String(on)));
    $("#idxPanel").hidden = !on;
    $("#idxTimeline").hidden = !on || !steps[NOW_I];
    if (on) {
      if (!steps[NOW_I] || Date.now() - computedAt > 10 * 60000) run();
      else show(cur);
      // Pide la ubicación (el navegador pregunta solo la primera vez)
      C.locate({ silent: true, noPan: true });
    } else {
      stop();
      steps.forEach((s) => s && s.layer && map.removeLayer(s.layer));
      updateClouds(null);
    }
    scheduleRefresh();
  }
  document.querySelectorAll("[data-indice-btn]").forEach((b) => b.addEventListener("click", () => {
    setActive(!active);
    if (active && window.innerWidth < 820) $("#panel").classList.add("open");
  }));
  // Con avisos activos, el índice se calcula en segundo plano aunque no esté a la vista
  if (ALERT.on && userLoc) { setTimeout(() => { if (!computing && !steps[NOW_I]) run(); }, 15000); scheduleRefresh(); }

  // ---------- Al tocar un punto: ficha del lugar ----------
  const capeWord = (v) => (v >= 2500 ? "muy alto" : v >= 1500 ? "alto" : v >= 700 ? "moderado" : "bajo");
  C.pointHooks.push((lat, lng) => {
    if (!active || !steps[NOW_I]) return "";
    const c = cellOf(lat, lng);
    if (!c) return `<h3>Índice CELESTE</h3><p class="muted">Este punto está fuera del área del índice.</p>`;
    const st = steps[cur];
    const v = st.index[c.k];
    if (!Number.isFinite(v)) return `<h3>Índice CELESTE</h3><p class="muted">El índice se calcula sobre Costa Rica y su franja costera. Toca un punto dentro del país.</p>`;
    const l = levelOf(v);
    const inf = cellInfo(st, c.k, c.ck);
    const series = steps.map((s) => (s && Number.isFinite(s.index[c.k]) ? s.index[c.k] : null));
    const wins = [["Próxima hora", 1, 2], ["Próximas 3 h", 1, 6], ["Próximas 6 h", 1, 12]].map(([n, a, b]) => [n, outlook(c, NOW_I + a, NOW_I + b)]);
    const past = outlook(c, 0, NOW_I);
    const conf = confidence(c);
    const facts = [
      ["Lluvia estimada", inf.R >= 0.05 ? `${C.fmtNum1.format(inf.R)} mm/h` : "Sin lluvia"],
      ["Nubosidad", `${C.fmtNum.format(inf.cloud)} %`],
      ["Probabilidad de lluvia (modelo)", `${C.fmtNum.format(inf.pp)} %`],
      ["Potencial de tormenta", `${capeWord(inf.cape)} (${C.fmtNum.format(inf.cape)} J/kg)`],
      ["Ráfagas", `${C.fmtNum.format(inf.gust)} km/h`],
      ["Sensación térmica", `${C.fmtNum.format(inf.heat)} °C`],
    ];
    return `
      <div class="lvl-card" style="--lvl:${levelColor(l)}">
        ${levelBadge(l, "big")}
        <div class="lvl-txt"><span class="lvl-when">${whenText(st)}</span><b>${LEVELS[l].n}</b><span>${LEVELS[l].d}</span></div>
        <span class="lvl-num" title="Índice CELESTE, de 0 a 100">${C.fmtNum.format(v)}<small>de 100</small></span>
      </div>
      <p class="chart-title">Qué esperar desde ahora</p>
      <div class="fc-grid">${wins.map(([n, o]) => o ? `
        <div class="fc-cell">${levelBadge(o.maxL, "sm")}<span class="fc-lbl">${n}</span><b>${LEVELS[o.maxL].n}</b>
          <span><span class="fc-k">Lluvia</span> ${o.pp} %</span><span><span class="fc-k">Total</span> ${C.fmtNum1.format(o.mm)} mm</span></div>` : "").join("")}</div>
      <p class="fc-note">Peldaño más alto esperado, probabilidad de que llueva en ese lapso y lluvia acumulada esperada.${past ? ` En las últimas 6 horas: hasta ${LEVELS[past.maxL].n}, ${C.fmtNum1.format(past.mm)} mm.` : ""}</p>
      <p class="chart-title">Peldaño cada media hora</p>
      ${seriesChart(series)}
      <p class="chart-title">Por qué ${LEVELS[l].n.toLowerCase()}</p>
      <table class="pop-vals facts">${facts.map(([a, b]) => `<tr><td>${a}</td><td><b>${b}</b></td></tr>`).join("")}</table>
      <p class="fc-note">Regla: ${LEVELS[l].rule}</p>
      <p class="chart-title">De dónde sale la lluvia aquí</p>
      ${rainSourcesHTML(st, c.k, c.ck)}
      ${conf ? `<p class="conf conf-${conf[0]}">Confianza ${conf[0]}: ${conf[1]}.</p>` : ""}
      <p class="source">Estimación automática y experimental. Para avisos oficiales consulta al IMN y a la CNE.</p>`;
  });

  function rainSourcesHTML(st, k, ck) {
    const w = RW(), P = st.parts;
    if (!P) return "";
    const mrv = P.mrC[ck];
    const rows = [];
    if (P.rr && radW[k] * P.wTime > 0) rows.push(["Radar COCESNA" + (st.min > 0 ? " (proyectado)" : ""), w.radar * radW[k] * P.wTime, P.rr[k] / 100]);
    if (P.est && P.est.q && P.est.q[k] > 0 && Number.isFinite(P.est.grid[k])) rows.push(["Estaciones IMN e IMHPA" + (st.min > 0 ? " (pronóstico)" : ""), w.est * (P.est.q[k] / 255) * P.est.decay, P.est.grid[k]]);
    if (P.goes && Number.isFinite(P.goes[k])) rows.push(["GOES-Este" + (st.min > 0 ? " (desplazado)" : ""), w.goes * P.goesQ, P.goes[k] * goesFactor]);
    if (P.imerg && Number.isFinite(P.imerg[k])) rows.push(["IMERG", w.imerg, P.imerg[k]]);
    rows.push(["Modelo numérico", w.model, mrv]);
    const tot = rows.reduce((s, r) => s + r[1], 0) || 1;
    return `<div class="parts">${rows.filter((r) => r[1] > 0).map(([n, wt, v]) => `
      <div class="part"><span class="part-name">${n}<br><span class="muted">${C.fmtNum1.format(v)} mm/h</span></span>
      <span class="part-bar"><span style="width:${(wt / tot) * 100}%"></span></span><b>${C.fmtNum.format((wt / tot) * 100)} %</b></div>`).join("")}</div>
      <p class="fc-note">Lluvia combinada: <b>${C.fmtNum1.format(st.rain[k])} mm/h</b>. Cada fuente pesa según su peso general y su calidad aquí (alcance del radar, estaciones cercanas, plazo).</p>`;
  }

  function seriesChart(vals) {
    const CW = 340, CH = 120, PL = 8, PR = 8, PT = 10, PB = 20;
    const iw = CW - PL - PR, ih = CH - PT - PB, bw = iw / vals.length;
    const y = (v) => PT + ih - (clamp(v, 0, 100) / 100) * ih;
    let g = "";
    [20, 40, 60, 80].forEach((t) => { g += `<line class="grid" x1="${PL}" x2="${CW - PR}" y1="${y(t)}" y2="${y(t)}"/>`; });
    const xNow = PL + NOW_I * bw + bw / 2;
    g += `<line x1="${xNow}" x2="${xNow}" y1="${PT}" y2="${PT + ih}" stroke="currentColor" stroke-width="1" stroke-dasharray="3 3" opacity="0.5"/>`;
    vals.forEach((v, i) => {
      if (v == null) return;
      const l = levelOf(v);
      const x = PL + i * bw + 1, w = Math.max(2, bw - 2), top = y(Math.max(v, 3)), h = Math.max(1, PT + ih - top), r = Math.min(2, h, w / 2);
      g += `<rect class="hit" x="${PL + i * bw}" y="${PT}" width="${bw}" height="${ih}" data-tip="${whenText(steps[i])}: ${LEVELS[l].n}"/>`;
      g += `<path d="M${x},${PT + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${PT + ih} Z" fill="${levelColor(l)}" opacity="${i < NOW_I ? 0.6 : 1}" ${i === cur ? 'stroke="currentColor" stroke-width="1.2"' : ""}/>`;
    });
    [[0, "Hace 6 h"], [NOW_I, "Ahora"], [STEPS.length - 1, "En 6 h"]].forEach(([i, t]) => {
      g += `<text x="${PL + i * bw + bw / 2}" y="${CH - 5}" text-anchor="${i === 0 ? "start" : i === STEPS.length - 1 ? "end" : "middle"}">${t}</text>`;
    });
    return `<svg class="chart" viewBox="0 0 ${CW} ${CH}" role="img" aria-label="Peldaño del índice en las últimas 6 horas y las próximas 6">${g}</svg>`;
  }
})();
