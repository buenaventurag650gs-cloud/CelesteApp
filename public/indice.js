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

  // ---------- Paleta azul: más oscuro = más intenso ----------
  const IDX = {
    levels: C.steps(0, 90, 10),
    colors: C.ramp(["#eef6fc", "#cfe5f6", "#a8d0ee", "#7db7e3", "#529bd5", "#3580c3", "#2466aa", "#1a4e8e", "#123a70", "#0a2652"], 10),
    units: "Índice CELESTE, de 0 a 100",
    clamp: true,
    fmt: C.fmtNum,
    words: ["Tranquilo", "Inestable", "Lluvioso", "Tormentoso", "Severo"],
  };
  const CLASSES = [[0, "Tranquilo"], [20, "Inestable"], [40, "Lluvioso"], [60, "Tormentoso"], [80, "Severo"]];
  const className = (v) => CLASSES.filter((c) => v >= c[0]).pop()[1];
  const inkOn = (v) => (v >= 45 ? "#ffffff" : "#12324a");

  // ---------- Componentes y ponderación ----------
  const COMPS = [
    { key: "rain", name: "Lluvia", w: 45, unit: "mm/h", fmt: C.fmtNum1, score: (v) => Math.min(1, Math.log1p(Math.max(0, v)) / Math.log1p(25)) },
    { key: "cape", name: "Potencial de tormenta", w: 20, unit: "J/kg", fmt: C.fmtNum, score: (v) => clamp(v / 2500) },
    { key: "gust", name: "Ráfagas de viento", w: 15, unit: "km/h", fmt: C.fmtNum, score: (v) => clamp((v - 25) / 55) },
    { key: "pp", name: "Probabilidad de lluvia", w: 10, unit: "%", fmt: C.fmtNum, score: (v) => clamp(v / 100) },
    { key: "heat", name: "Calor", w: 10, unit: "°C de sensación", fmt: C.fmtNum, score: (v) => clamp((v - 30) / 10) },
  ];
  const MODEL_KEYS = ["cape", "gust", "pp", "heat"];
  const SUGGESTED = { rain: 45, cape: 20, gust: 15, pp: 10, heat: 10 };
  try {
    const saved = JSON.parse(store.get("celeste-pesos") || "null");
    if (saved) COMPS.forEach((c) => { if (Number.isFinite(saved[c.key])) c.w = saved[c.key]; });
  } catch (e) { /* pesos por defecto */ }

  // ---------- Capa ----------
  map.createPane("indice").style.zIndex = 435;
  map.getPane("indice").style.opacity = 0.85;
  const renderer = L.canvas({ pane: "indice", padding: 0.4 });
  const layerOf = (geo) => L.geoJSON(geo, {
    pane: "indice", renderer, interactive: false, smoothFactor: 0.4,
    style: (f) => ({ fillColor: f.properties.c, fillOpacity: 1, color: f.properties.c, weight: 0.8, opacity: 1 }),
  });

  // ---------- Estado ----------
  let active = false;
  let steps = []; // {min, time, rain(Float32), coarse:{cape,gust,pp,heat}, index, layer, p90, max, source}
  let cur = NOW_I;
  let t0 = null;
  let radarOK = false;
  let calib = null; // {factor, n}
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

  async function run() {
    if (computing) return;
    computing = true;
    setStatus("Leyendo radar, estaciones y modelo…");
    try {
      const [radar, , model] = await Promise.all([
        loadRadar().catch(() => null),
        loadMask(),
        fetch("/api/celeste/modelo").then((r) => { if (!r.ok) throw new Error("modelo"); return r.json(); }),
      ]);
      radarOK = !!radar;
      t0 = radar ? new Date(radar.time) : new Date(Math.floor(Date.now() / 600000) * 600000);
      calib = radar ? await calibrate(radar) : null;
      const factor = calib && calib.used ? calib.factor : 1;
      setStatus(radarOK ? "Calculando el movimiento de la lluvia…" : "Sin radar en este momento: se usa solo el modelo.");
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

      steps.forEach((s) => s.layer && map.removeLayer(s.layer));
      steps = [];
      const rw = C.RADAR_AREA.w, rh = C.RADAR_AREA.h;
      const latest = radar ? radar.frames[0] : null;

      // Orden de cálculo: ahora primero, luego futuro y pasado alternando
      const order = [NOW_I];
      for (let d = 1; d <= 12; d++) { order.push(NOW_I + d); order.push(NOW_I - d); }

      for (const si of order) {
        const L = STEPS[si];
        const tSec = t0.getTime() / 1000 + L * 60;
        const rain = new Float32Array(N);
        let source;
        // Lluvia del radar: observada (pasado/ahora) o proyectada (futuro)
        let radarField = null, wTime = 0, sigma = 0.9;
        if (radar) {
          if (L <= 0) { radarField = radar.frames[L] || null; wTime = radarField ? 1 : 0; }
          else { radarField = latest; wTime = clamp(1 - L / BLEND_END); sigma = 0.9 + (L / 60) * 1.6; }
        }
        const rr = new Float32Array(N);
        if (radarField && wTime > 0) {
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
        }
        const rrS = radarField && wTime > 0 ? C.blur(rr, W, H, sigma) : rr;
        const mrC = modelCoarse(model, "precipitation", tSec + 1800, true);
        const mr = C.resample(mrC, CWd, CHd, W, H);
        for (let k = 0; k < N; k++) {
          const wr = radarField ? radW[k] * wTime : 0;
          rain[k] = wr * (Number.isFinite(rrS[k]) ? rrS[k] : 0) + (1 - wr) * (Number.isFinite(mr[k]) ? mr[k] : 0);
        }
        source = !radarField || wTime === 0 ? "modelo" : L < 0 ? "observado" : L === 0 ? "ahora" : "proyectado";
        const coarse = {
          cape: modelCoarse(model, "cape", tSec, true),
          gust: modelCoarse(model, "wind_gusts_10m", tSec + 1800, true),
          pp: modelCoarse(model, "precipitation_probability", tSec + 1800, true),
          heat: modelCoarse(model, "apparent_temperature", tSec, false),
        };
        const st = { min: L, time: new Date(t0.getTime() + L * 60000), rain, coarse, source };
        steps[si] = st;
        computeIndex(st);
        if (si === NOW_I) { cur = NOW_I; drawBars(); show(NOW_I); $("#idxTimeline").hidden = !active; }
        else drawBars();
        await pause();
      }
      computedAt = Date.now();
      const motionTxt = motion ? ` La lluvia se desplaza hacia ${direction(motion.meanX, motion.meanY)} a unos ${C.fmtNum.format(speedKmh(motion.meanX, motion.meanY))} km/h.` : "";
      const mos = radar && radar.mosaic;
      const mosTxt = mos ? (mos.fresh ? ` Radar del IMN incluido${mos.ratio ? ` (en la zona común marca ${C.fmtNum1.format(mos.ratio)} veces lo de COCESNA)` : ""}.` : " El radar del IMN no publica imágenes recientes; no se incluye.") : "";
      const calibTxt = calib ? (calib.used ? ` Lluvia del radar ajustada con ${calib.n} estaciones del IMN (×${C.fmtNum1.format(calib.factor)}).` : ` Calibración: solo ${calib.n} estaciones con lluvia; se usa el radar sin ajustar.`) : "";
      setStatus(radarOK
        ? `Radar de las ${C.fmtHour.format(t0)} y modelo de las ${C.fmtHour.format(new Date((model.times.filter((t) => t * 1000 <= Date.now()).pop() || model.times[0]) * 1000))}${motionTxt}${calibTxt}${mosTxt}`
        : "Sin radar en este momento: el índice usa solo el modelo numérico.");
      $("#idxTimeline").hidden = !active;
    } catch (err) {
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
    const wsum = COMPS.reduce((s, c) => s + c.w, 0) || 1;
    const full = {};
    MODEL_KEYS.forEach((k) => (full[k] = C.resample(st.coarse[k], CWd, CHd, W, H)));
    const w = Object.fromEntries(COMPS.map((c) => [c.key, c.w]));
    const sc = Object.fromEntries(COMPS.map((c) => [c.key, c.score]));
    const idx = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      if (mask && !mask[k]) { idx[k] = NaN; continue; }
      let s = 0;
      if (w.rain) s += w.rain * sc.rain(st.rain[k]);
      for (const key of MODEL_KEYS) if (w[key]) s += w[key] * sc[key](full[key][k]);
      idx[k] = (100 * s) / wsum;
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

  const fmtLead = (min) => {
    if (min === 0) return "Ahora";
    const h = Math.abs(min) / 60;
    const txt = Number.isInteger(h) ? String(h) : h.toFixed(1).replace(".", ",");
    return `${min < 0 ? "−" : "+"}${txt} h`;
  };
  const sourceText = (st) => ({
    observado: "observado: radar calibrado y modelo",
    ahora: radarOK ? `radar ${C.ago(st.time)}` : "modelo",
    proyectado: "pronóstico: radar proyectado y modelo",
    modelo: st.min < 0 ? "observado: modelo (sin radar)" : "pronóstico: modelo",
  })[st.source];

  function drawBars() {
    bars.innerHTML = "";
    STEPS.forEach((m, i) => {
      const st = steps[i];
      const b = document.createElement("span");
      b.className = "tl-bar" + (st ? "" : " loading") + (i === cur ? " current" : "") + (m < 0 ? " past" : "") + (m === 0 ? " now" : "");
      if (st) {
        b.style.height = `${6 + 28 * clamp(st.p90 / 80)}px`;
        b.style.background = i === cur ? "" : C.bandColor(IDX, st.p90);
        b.title = `${fmtLead(st.min)}, ${C.fmtHour.format(st.time)}: el 10 % del país supera ${C.fmtNum.format(st.p90)}; máximo ${C.fmtNum.format(st.max)}`;
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
      if (steps[j]) b.style.background = j === cur ? "" : C.bandColor(IDX, steps[j].p90);
    });
    $("#idxTime").textContent = `${fmtLead(st.min)} · ${C.fmtHour.format(st.time)}`;
    $("#idxAgo").textContent = sourceText(st);
    bars.setAttribute("aria-valuenow", String(cur));
    bars.setAttribute("aria-valuetext", `${fmtLead(st.min)}, ${C.fmtHour.format(st.time)}`);
  }

  function play() {
    if (timer || steps.filter(Boolean).length < 2) return;
    btnPlay.classList.add("playing");
    btnPlay.setAttribute("aria-label", "Pausar la animación");
    const step = () => {
      const next = cur >= STEPS.length - 1 ? 0 : cur + 1;
      show(next);
      timer = setTimeout(step, next === STEPS.length - 1 ? 1800 : next === NOW_I ? 1200 : 600);
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

  // ---------- Panel ----------
  function setStatus(t) { const el = $("#idxStatus"); if (el) el.textContent = t; }

  function renderWeights() {
    const wrap = $("#idxWeights");
    const total = COMPS.reduce((s, c) => s + c.w, 0) || 1;
    wrap.innerHTML = COMPS.map((c) => `
      <div class="weight">
        <label for="w-${c.key}">${c.name}</label>
        <input id="w-${c.key}" type="range" min="0" max="100" step="5" value="${c.w}" data-key="${c.key}">
        <output for="w-${c.key}">${C.fmtNum.format((c.w / total) * 100)} %</output>
      </div>`).join("") + `<button type="button" class="link-btn" id="idxReset">Volver a los pesos sugeridos</button>`;
  }
  let reweightTimer = null;
  function reweight() {
    clearTimeout(reweightTimer);
    reweightTimer = setTimeout(() => {
      steps.forEach((s) => s && computeIndex(s));
      drawBars();
      show(cur);
      store.set("celeste-pesos", JSON.stringify(Object.fromEntries(COMPS.map((c) => [c.key, c.w]))));
    }, 250);
  }
  document.addEventListener("input", (e) => {
    const el = e.target.closest("#idxWeights input[data-key]");
    if (!el) return;
    COMPS.find((c) => c.key === el.dataset.key).w = parseInt(el.value, 10);
    const total = COMPS.reduce((s, c) => s + c.w, 0) || 1;
    document.querySelectorAll("#idxWeights output").forEach((o, i) => (o.textContent = `${C.fmtNum.format((COMPS[i].w / total) * 100)} %`));
    reweight();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#idxReset")) return;
    COMPS.forEach((c) => (c.w = SUGGESTED[c.key]));
    renderWeights();
    reweight();
  });

  $("#idxLegend").innerHTML = C.legendHTML(IDX);
  renderWeights();

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
      clearInterval(refresh);
      refresh = setInterval(() => { if (active) run(); }, 10 * 60000);
    } else {
      stop();
      clearInterval(refresh);
      steps.forEach((s) => s && s.layer && map.removeLayer(s.layer));
    }
  }
  document.querySelectorAll("[data-indice-btn]").forEach((b) => b.addEventListener("click", () => {
    setActive(!active);
    if (active && window.innerWidth < 820) $("#panel").classList.add("open");
  }));

  // ---------- Al tocar un punto ----------
  C.pointHooks.push((lat, lng) => {
    if (!active || !steps[NOW_I]) return "";
    const [X, Y] = C.merc(lat, lng);
    const [x0, y0, x1, y1] = AREA.bbox;
    const i = Math.floor(((X - x0) / (x1 - x0)) * W), j = Math.floor(((y1 - Y) / (y1 - y0)) * H);
    if (i < 0 || j < 0 || i >= W || j >= H) return `<h3>Índice CELESTE</h3><p class="muted">Este punto está fuera del área del índice.</p>`;
    const k = j * W + i;
    const st = steps[cur];
    const v = st.index[k];
    if (!Number.isFinite(v)) return `<h3>Índice CELESTE</h3><p class="muted">El índice se calcula sobre Costa Rica y su franja costera. Toca un punto dentro del país.</p>`;
    const ck = Math.min(CHd - 1, Math.floor(j / 3)) * CWd + Math.min(CWd - 1, Math.floor(i / 3));
    const wsum = COMPS.reduce((s, c) => s + c.w, 0) || 1;
    const series = steps.map((s) => (s && Number.isFinite(s.index[k]) ? s.index[k] : null));
    let peak = NOW_I;
    for (let q = NOW_I; q < series.length; q++) if (series[q] != null && series[q] > series[peak]) peak = q;
    const raw = (c) => (c.key === "rain" ? st.rain[k] : st.coarse[c.key][ck]);
    const parts = COMPS.map((c) => ({ c, raw: raw(c), pts: (100 * c.w * c.score(raw(c))) / wsum }));
    const maxPts = Math.max(1, ...parts.map((p) => p.pts));
    const past = series.slice(0, NOW_I).filter((x) => x != null);
    const pastMax = past.length ? Math.max(...past) : null;
    return `
      <h3>Índice CELESTE · ${fmtLead(st.min).toLowerCase()}, ${C.fmtHour.format(st.time)}</h3>
      <div class="idx-now">
        <span class="idx-badge" style="background:${C.bandColor(IDX, v)};color:${inkOn(v)}">${C.fmtNum.format(v)}</span>
        <div><b>${className(v)}</b><span class="muted">${pastMax != null ? `Máximo de las últimas 6 horas: ${C.fmtNum.format(pastMax)}. ` : ""}Próximas 6 horas: hasta ${C.fmtNum.format(series[peak])} a las ${C.fmtHour.format(steps[peak].time)}</span></div>
      </div>
      <p class="chart-title">Últimas 6 horas y próximas 6</p>
      ${seriesChart(series)}
      <p class="chart-title">Qué pesa en este momento</p>
      <div class="parts">${parts.map((p) => `
        <div class="part">
          <span class="part-name">${p.c.name}<br><span class="muted">${p.c.fmt.format(p.raw)} ${p.c.unit}</span></span>
          <span class="part-bar"><span style="width:${(p.pts / maxPts) * 100}%"></span></span>
          <b>+${C.fmtNum.format(p.pts)}</b>
        </div>`).join("")}</div>
      <p class="source">${radW[k] > 0.5 && st.source !== "modelo" ? `Lluvia: radar de COCESNA${calib && calib.used ? " calibrado con estaciones del IMN" : ""}${st.source === "proyectado" ? ", proyectado," : ""} y modelo.` : "Lluvia: modelo numérico (fuera del alcance del radar o más allá de 3 horas)."} Es una estimación automática; para avisos oficiales consulta al IMN y a la CNE.</p>`;
  });

  function seriesChart(vals) {
    const CW = 340, CH = 116, PL = 26, PR = 6, PT = 8, PB = 20;
    const iw = CW - PL - PR, ih = CH - PT - PB, bw = iw / vals.length;
    const y = (v) => PT + ih - (clamp(v, 0, 100) / 100) * ih;
    let g = "";
    [0, 50, 100].forEach((t) => { g += `<line class="grid" x1="${PL}" x2="${CW - PR}" y1="${y(t)}" y2="${y(t)}"/><text x="${PL - 5}" y="${y(t) + 3.5}" text-anchor="end">${t}</text>`; });
    const xNow = PL + NOW_I * bw + bw / 2;
    g += `<line x1="${xNow}" x2="${xNow}" y1="${PT}" y2="${PT + ih}" stroke="currentColor" stroke-width="1" stroke-dasharray="3 3" opacity="0.5"/>`;
    vals.forEach((v, i) => {
      if (v == null) return;
      const x = PL + i * bw + 1, w = Math.max(2, bw - 2), top = y(v), h = Math.max(1, PT + ih - top), r = Math.min(2, h, w / 2);
      g += `<rect class="hit" x="${PL + i * bw}" y="${PT}" width="${bw}" height="${ih}" data-tip="${fmtLead(STEPS[i])}, ${C.fmtHour.format(steps[i].time)}: ${C.fmtNum.format(v)} (${className(v).toLowerCase()})"/>`;
      g += `<path d="M${x},${PT + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${PT + ih} Z" fill="${C.bandColor(IDX, v)}" opacity="${i < NOW_I ? 0.6 : 1}" ${i === cur ? 'stroke="currentColor" stroke-width="1.2"' : ""}/>`;
    });
    [[0, "−6 h"], [NOW_I, "Ahora"], [STEPS.length - 1, "+6 h"]].forEach(([i, t]) => {
      g += `<text x="${PL + i * bw + bw / 2}" y="${CH - 5}" text-anchor="${i === 0 ? "start" : i === STEPS.length - 1 ? "end" : "middle"}">${t}</text>`;
    });
    return `<svg class="chart" viewBox="0 0 ${CW} ${CH}" role="img" aria-label="Índice CELESTE en las últimas 6 horas y las próximas 6">${g}</svg>`;
  }
})();
