/* Índice CELESTE
   Un solo mapa que pondera lluvia, potencial de tormenta, ráfagas, probabilidad de lluvia y calor.
   Situación actual + pronóstico inmediato a 6 horas:
   - 0–3 h: el radar se proyecta hacia adelante según el movimiento medido entre imágenes recientes
     (correlación por bloques + advección semilagrangiana), con decaimiento y difuminado crecientes.
   - Luego se mezcla gradualmente con el modelo numérico (Open-Meteo), que cubre todo el país. */
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
  const STEPS = Array.from({ length: 13 }, (_, i) => i * 30); // minutos: ahora … +6 h
  const RADAR_CENTER = [12.141, -86.168]; // zona de Managua (aprox.)
  const RADAR_RANGE = 430; // km útiles
  const BLEND_END = 180; // a los 180 min el radar ya no pesa

  // ---------- Paleta y clases ----------
  const IDX = {
    levels: C.steps(0, 90, 10),
    colors: C.ramp(["#dff1fa", "#a9dcef", "#9fd7b9", "#f2df7a", "#f4b25a", "#ea7b45", "#d9434b", "#a8285f", "#6e1f6e"], 10),
    units: "Índice CELESTE, de 0 a 100",
    clamp: true,
    fmt: C.fmtNum,
    words: ["Tranquilo", "Inestable", "Lluvioso", "Tormentoso", "Severo"],
  };
  const CLASSES = [[0, "Tranquilo"], [20, "Inestable"], [40, "Lluvioso"], [60, "Tormentoso"], [80, "Severo"]];
  const className = (v) => CLASSES.filter((c) => v >= c[0]).pop()[1];

  // ---------- Componentes y ponderación ----------
  const COMPS = [
    { key: "rain", name: "Lluvia", w: 45, unit: "mm/h", fmt: C.fmtNum1, score: (v) => Math.min(1, Math.log1p(Math.max(0, v)) / Math.log1p(25)) },
    { key: "cape", name: "Potencial de tormenta", w: 20, unit: "J/kg", fmt: C.fmtNum, score: (v) => clamp(v / 2500) },
    { key: "gust", name: "Ráfagas de viento", w: 15, unit: "km/h", fmt: C.fmtNum, score: (v) => clamp((v - 25) / 55) },
    { key: "pp", name: "Probabilidad de lluvia", w: 10, unit: "%", fmt: C.fmtNum, score: (v) => clamp(v / 100) },
    { key: "heat", name: "Calor", w: 10, unit: "°C de sensación", fmt: C.fmtNum, score: (v) => clamp((v - 30) / 10) },
  ];
  try {
    const saved = JSON.parse(store.get("celeste-pesos") || "null");
    if (saved) COMPS.forEach((c) => { if (Number.isFinite(saved[c.key])) c.w = saved[c.key]; });
  } catch (e) { /* pesos por defecto */ }

  // ---------- Capa ----------
  map.createPane("indice").style.zIndex = 435;
  map.getPane("indice").style.opacity = 0.82;
  const renderer = L.canvas({ pane: "indice", padding: 0.4 });
  const layerOf = (geo) => L.geoJSON(geo, {
    pane: "indice", renderer, interactive: false, smoothFactor: 0.4,
    style: (f) => ({ fillColor: f.properties.c, fillOpacity: 1, color: f.properties.c, weight: 0.8, opacity: 1 }),
  });

  // ---------- Estado ----------
  let active = false;
  let steps = []; // {min, time, comps:{}, index, layer, p90, max}
  let cur = 0;
  let t0 = null;
  let radarOK = false;
  let computing = false;
  let computedAt = 0;
  let timer = null, refresh = null;

  // ---------- Geometría precalculada ----------
  const cellLat = new Float32Array(N), cellLng = new Float32Array(N);
  const radX = new Float32Array(N), radY = new Float32Array(N), radW = new Float32Array(N);
  (function precompute() {
    const [x0, y0, x1, y1] = AREA.bbox;
    const rb = C.RADAR_AREA.bbox, rw = C.RADAR_AREA.w, rh = C.RADAR_AREA.h;
    const toRad = Math.PI / 180;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        const X = x0 + ((i + 0.5) / W) * (x1 - x0);
        const Y = y1 - ((j + 0.5) / H) * (y1 - y0);
        const [lat, lng] = C.unmerc(X, Y);
        cellLat[k] = lat; cellLng[k] = lng;
        radX[k] = ((X - rb[0]) / (rb[2] - rb[0])) * rw - 0.5;
        radY[k] = ((rb[3] - Y) / (rb[3] - rb[1])) * rh - 0.5;
        const dLat = (lat - RADAR_CENTER[0]) * 111.2;
        const dLng = (lng - RADAR_CENTER[1]) * 111.2 * Math.cos(lat * toRad);
        const d = Math.sqrt(dLat * dLat + dLng * dLng);
        radW[k] = clamp((RADAR_RANGE - d) / 30); // borde suave de 30 km
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
  function modelField(model, name, tSec, positive) {
    const c = new Float32Array(CWd * CHd);
    for (let q = 0; q < c.length; q++) { const v = modelAt(model, name, tSec, coarseLat[q], coarseLng[q]); c[q] = positive ? Math.max(0, v) : v; }
    return C.resample(c, CWd, CHd, W, H);
  }

  function bilinear(g, w, h, x, y) {
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    return g[y0 * w + x0] * (1 - fx) * (1 - fy) + g[y0 * w + x1] * fx * (1 - fy) + g[y1 * w + x0] * (1 - fx) * fy + g[y1 * w + x1] * fx * fy;
  }

  // ---------- Movimiento de la lluvia ----------
  const F = 4; // reducción para estimar movimiento
  const B = 8; // tamaño de bloque (en celdas reducidas, ~32 km)
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
            sad += 0.0005 * (dx * dx + dy * dy) * energy; // prefiere desplazamientos cortos ante empates
            cost[(dy + S) * (2 * S + 1) + dx + S] = sad;
            if (sad < best) { best = sad; bdx = dx; bdy = dy; }
          }
        }
        // Ajuste subpíxel con una parábola en cada eje
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
    // Descarta vectores muy distintos de la mediana (ecos espurios)
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
    // Interpolación temporal lineal entre horas y espacial bilineal en la rejilla de 0,3°
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

  // ---------- Cálculo ----------
  // Cede el control al navegador entre pasos sin depender de setTimeout (que se frena en segundo plano)
  const chan = new MessageChannel();
  const waiting = [];
  chan.port1.onmessage = () => { const r = waiting.shift(); if (r) r(); };
  const pause = () => new Promise((r) => { waiting.push(r); chan.port2.postMessage(0); });

  async function run() {
    if (computing) return;
    computing = true;
    setStatus("Leyendo radar y modelo…");
    try {
      const [radar, model] = await Promise.all([loadRadar().catch(() => null), loadMask(), fetch("/api/celeste/modelo").then((r) => {
        if (!r.ok) throw new Error("modelo");
        return r.json();
      })]).then(([r, , m]) => [r, m]);
      radarOK = !!radar;
      t0 = radar ? new Date(radar.time) : new Date(Math.floor(Date.now() / 600000) * 600000);
      setStatus(radarOK ? "Calculando el movimiento de la lluvia…" : "Sin radar en este momento: se usa solo el modelo.");
      await pause();

      let motion = null;
      if (radar && radar.prev.length) {
        const fields = [radar.prev[1], radar.prev[0], radar.latest].filter(Boolean).map((r) => ({ d: downsample(r.grid, r.w, r.h), t: r.t }));
        let sx = 0, sy = 0, n = 0, combo = null;
        for (let i = 0; i < fields.length - 1; i++) {
          const m = fillAndSmooth(blockMotion(fields[i].d, fields[i + 1].d));
          const dt = (fields[i + 1].t - fields[i].t) / 60000;
          if (!(dt > 0)) continue;
          const k = F / dt; // celdas reducidas por intervalo → celdas completas por minuto
          if (!combo) combo = { vx: new Float32Array(m.vx.length), vy: new Float32Array(m.vy.length), nbx: m.nbx, nby: m.nby };
          for (let q = 0; q < m.vx.length; q++) { combo.vx[q] += m.vx[q] * k; combo.vy[q] += m.vy[q] * k; }
          sx += m.mx * k; sy += m.my * k; n++;
        }
        if (combo && n) {
          for (let q = 0; q < combo.vx.length; q++) { combo.vx[q] /= n; combo.vy[q] /= n; }
          motion = { ...combo, meanX: sx / n, meanY: sy / n };
        }
      }

      // Limpia lo anterior
      steps.forEach((s) => s.layer && map.removeLayer(s.layer));
      steps = [];

      const latest = radar ? radar.latest : null;
      const rw = C.RADAR_AREA.w, rh = C.RADAR_AREA.h;
      for (let si = 0; si < STEPS.length; si++) {
        const L = STEPS[si];
        const tSec = t0.getTime() / 1000 + L * 60;
        const comps = { rain: new Float32Array(N) };
        const radarRain = new Float32Array(N);
        const decay = Math.exp(-L / 150);
        const wTime = clamp(1 - L / BLEND_END);
        const useRadar = !!latest && wTime > 0;
        for (let k = 0; useRadar && k < N; k++) {
          // Lluvia del radar proyectada
          if (useRadar && radW[k] > 0) {
            let x = radX[k], y = radY[k];
            if (motion && L > 0) {
              const bx = x / (F * B) - 0.5, by = y / (F * B) - 0.5;
              const vx = bilinearClamp(motion.vx, motion.nbx, motion.nby, bx, by);
              const vy = bilinearClamp(motion.vy, motion.nbx, motion.nby, bx, by);
              x -= vx * L; y -= vy * L;
            }
            radarRain[k] = bilinear(latest.grid, rw, rh, x, y) * decay;
          }
        }
        // Difuminado creciente: la incertidumbre aumenta con el plazo
        const rr = useRadar ? C.blur(radarRain, W, H, 0.9 + (L / 60) * 1.6) : radarRain;
        const mr = modelField(model, "precipitation", tSec + 1800, true);
        comps.cape = modelField(model, "cape", tSec, true);
        comps.gust = modelField(model, "wind_gusts_10m", tSec + 1800, true);
        comps.pp = modelField(model, "precipitation_probability", tSec + 1800, true);
        comps.heat = modelField(model, "apparent_temperature", tSec, false);
        for (let k = 0; k < N; k++) {
          const wr = latest ? radW[k] * wTime : 0;
          comps.rain[k] = wr * (Number.isFinite(rr[k]) ? rr[k] : 0) + (1 - wr) * (Number.isFinite(mr[k]) ? mr[k] : 0);
        }
        const st = { min: L, time: new Date(t0.getTime() + L * 60000), comps };
        steps.push(st);
        computeIndex(st);
        if (si === 0) { drawBars(); show(0); $("#idxTimeline").hidden = !active; }
        else drawBars();
        await pause();
      }
      computedAt = Date.now();
      const motionTxt = motion ? ` La lluvia se desplaza hacia ${direction(motion.meanX, motion.meanY)} a unos ${C.fmtNum.format(speedKmh(motion.meanX, motion.meanY))} km/h.` : "";
      setStatus(radarOK
        ? `Radar de las ${C.fmtHour.format(t0)} y modelo de las ${C.fmtHour.format(new Date(model.times[1] * 1000))}${motionTxt}`
        : "Sin radar en este momento: el índice usa solo el modelo numérico.");
      $("#idxTimeline").hidden = !active;
    } catch (err) {
      setStatus("No se pudo calcular el índice. Vuelve a intentarlo en unos minutos.");
      C.toast("No se pudo calcular el índice CELESTE en este momento.");
    }
    computing = false;
  }

  function bilinearClamp(g, w, h, x, y) {
    return bilinear(g, w, h, clamp(x, 0, w - 1), clamp(y, 0, h - 1));
  }

  // Tamaño real de una celda del radar (en km) para traducir la velocidad
  const radarCellKm = (() => {
    const [x0, , x1] = C.RADAR_AREA.bbox;
    return ((x1 - x0) / C.RADAR_AREA.w / 1000) * Math.cos(9.7 * Math.PI / 180);
  })();
  const speedKmh = (vx, vy) => Math.hypot(vx, vy) * radarCellKm * 60;
  function direction(vx, vy) {
    const ang = (Math.atan2(vx, -vy) * 180 / Math.PI + 360) % 360; // 0 = norte (y crece hacia el sur)
    return ["el norte", "el noreste", "el este", "el sureste", "el sur", "el suroeste", "el oeste", "el noroeste"][Math.round(ang / 45) % 8];
  }

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
      times.forEach((t) => { if (t[1] < last[1] && (!best || Math.abs(t[1] - target) < Math.abs(best[1] - target))) best = t; });
      return best && Math.abs(best[1] - target) < 15 * 60000 ? best : null;
    };
    const p30 = pick(30), p60 = pick(60);
    const [latest, a, b] = await Promise.all([
      C.radarRain(last[0]),
      p30 ? C.radarRain(p30[0]).catch(() => null) : null,
      p60 ? C.radarRain(p60[0]).catch(() => null) : null,
    ]);
    latest.t = last[1];
    if (a) a.t = p30[1];
    if (b) b.t = p60[1];
    return { time: last[0], latest, prev: [a, b].filter(Boolean) };
  }

  function computeIndex(st) {
    const wsum = COMPS.reduce((s, c) => s + c.w, 0) || 1;
    const idx = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      if (mask && !mask[k]) { idx[k] = NaN; continue; }
      let s = 0;
      for (const c of COMPS) if (c.w) s += c.w * c.score(st.comps[c.key][k]);
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
    st.layer = null; // se dibuja cuando se muestra
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

  function stepLabel(st) {
    return st.min === 0 ? "Ahora" : `+${st.min % 60 ? (st.min / 60).toFixed(1).replace(".", ",") : st.min / 60} h`;
  }

  function drawBars() {
    bars.innerHTML = "";
    STEPS.forEach((m, i) => {
      const st = steps[i];
      const b = document.createElement("span");
      b.className = "tl-bar" + (st ? "" : " loading") + (i === cur ? " current" : "");
      if (st) {
        b.style.height = `${6 + 28 * clamp(st.p90 / 80)}px`;
        b.style.background = i === cur ? "" : C.bandColor(IDX, st.p90);
        b.title = `${stepLabel(st)}, ${C.fmtHour.format(st.time)}: el 10 % del país supera ${C.fmtNum.format(st.p90)}; máximo ${C.fmtNum.format(st.max)}`;
      } else b.style.height = "4px";
      bars.appendChild(b);
    });
    bars.setAttribute("aria-valuemax", String(STEPS.length - 1));
    if (steps.length) {
      $("#idxStart").textContent = C.fmtHour.format(steps[0].time);
      $("#idxEnd").textContent = C.fmtHour.format(new Date(t0.getTime() + STEPS[STEPS.length - 1] * 60000));
    }
  }

  function show(i) {
    if (!steps.length) return;
    i = clamp(i, 0, steps.length - 1);
    const prev = steps[cur];
    cur = i;
    const st = steps[cur];
    if (active) { const lyr = ensureLayer(st); if (!map.hasLayer(lyr)) lyr.addTo(map); }
    if (prev && prev !== st && prev.layer) map.removeLayer(prev.layer);
    [...bars.children].forEach((b, j) => {
      b.classList.toggle("current", j === cur);
      if (steps[j]) b.style.background = j === cur ? "" : C.bandColor(IDX, steps[j].p90);
    });
    $("#idxTime").textContent = `${stepLabel(st)} · ${C.fmtHour.format(st.time)}`;
    $("#idxAgo").textContent = st.min === 0 ? (radarOK ? `radar ${C.ago(st.time)}` : "modelo") : st.min <= BLEND_END ? "radar proyectado + modelo" : "modelo";
    bars.setAttribute("aria-valuenow", String(cur));
    bars.setAttribute("aria-valuetext", `${stepLabel(st)}, ${C.fmtHour.format(st.time)}`);
  }

  function play() {
    if (timer || steps.length < 2) return;
    btnPlay.classList.add("playing");
    btnPlay.setAttribute("aria-label", "Pausar el pronóstico");
    const step = () => {
      const next = cur >= steps.length - 1 ? 0 : cur + 1;
      show(next);
      timer = setTimeout(step, next === steps.length - 1 ? 1800 : 700);
    };
    timer = setTimeout(step, 200);
  }
  function stop() {
    clearTimeout(timer); timer = null;
    btnPlay.classList.remove("playing");
    btnPlay.setAttribute("aria-label", "Reproducir el pronóstico");
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
  const DEFAULTS = Object.fromEntries(COMPS.map((c) => [c.key, c.w]));
  const SUGGESTED = { rain: 45, cape: 20, gust: 15, pp: 10, heat: 10 };
  let reweightTimer = null;
  function reweight() {
    clearTimeout(reweightTimer);
    reweightTimer = setTimeout(() => {
      steps.forEach(computeIndex);
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
  void DEFAULTS;

  $("#idxLegend").innerHTML = C.legendHTML(IDX);
  renderWeights();

  // ---------- Activar / desactivar ----------
  function setActive(on) {
    active = on;
    document.body.classList.toggle("modo-indice", on);
    document.querySelectorAll("[data-indice-btn]").forEach((b) => b.setAttribute("aria-pressed", String(on)));
    $("#idxPanel").hidden = !on;
    $("#idxTimeline").hidden = !on || !steps.length;
    if (on) {
      if (!steps.length || Date.now() - computedAt > 10 * 60000) run();
      else { show(cur); }
      clearInterval(refresh);
      refresh = setInterval(() => { if (active) run(); }, 10 * 60000);
    } else {
      stop();
      clearInterval(refresh);
      steps.forEach((s) => s.layer && map.removeLayer(s.layer));
    }
  }
  document.querySelectorAll("[data-indice-btn]").forEach((b) => b.addEventListener("click", () => {
    setActive(!active);
    if (active && window.innerWidth < 820) { $("#panel").classList.add("open"); }
  }));

  // ---------- Al tocar un punto ----------
  C.pointHooks.push((lat, lng) => {
    if (!active || !steps.length) return "";
    const [X, Y] = C.merc(lat, lng);
    const [x0, y0, x1, y1] = AREA.bbox;
    const i = Math.floor(((X - x0) / (x1 - x0)) * W), j = Math.floor(((y1 - Y) / (y1 - y0)) * H);
    if (i < 0 || j < 0 || i >= W || j >= H) return `<h3>Índice CELESTE</h3><p class="muted">Este punto está fuera del área del índice.</p>`;
    const k = j * W + i;
    const st = steps[cur];
    const v = st.index[k];
    if (!Number.isFinite(v)) return `<h3>Índice CELESTE</h3><p class="muted">El índice se calcula sobre Costa Rica y su franja costera. Toca un punto dentro del país.</p>`;
    const wsum = COMPS.reduce((s, c) => s + c.w, 0) || 1;
    const series = steps.map((s) => (Number.isFinite(s.index[k]) ? s.index[k] : 0));
    const peak = series.indexOf(Math.max(...series));
    const parts = COMPS.map((c) => ({ c, raw: st.comps[c.key][k], pts: (100 * c.w * c.score(st.comps[c.key][k])) / wsum }));
    const maxPts = Math.max(1, ...parts.map((p) => p.pts));
    return `
      <h3>Índice CELESTE · ${stepLabel(st).toLowerCase()}, ${C.fmtHour.format(st.time)}</h3>
      <div class="idx-now">
        <span class="idx-badge" style="background:${C.bandColor(IDX, v)}">${C.fmtNum.format(v)}</span>
        <div><b>${className(v)}</b><span class="muted">El punto más alto de las próximas 6 horas: ${C.fmtNum.format(series[peak])} a las ${C.fmtHour.format(steps[peak].time)}</span></div>
      </div>
      <p class="chart-title">Próximas 6 horas</p>
      ${seriesChart(series)}
      <p class="chart-title">Qué pesa en este momento</p>
      <div class="parts">${parts.map((p) => `
        <div class="part">
          <span class="part-name">${p.c.name}<br><span class="muted">${p.c.fmt.format(p.raw)} ${p.c.unit}</span></span>
          <span class="part-bar"><span style="width:${(p.pts / maxPts) * 100}%"></span></span>
          <b>+${C.fmtNum.format(p.pts)}</b>
        </div>`).join("")}</div>
      <p class="source">${radarW(k) > 0.5 && st.min <= BLEND_END ? "Lluvia: radar de COCESNA proyectado y modelo." : "Lluvia: modelo numérico (fuera del alcance del radar o después de 3 h)."} Es una estimación automática; para avisos oficiales consulta al IMN y a la CNE.</p>`;
  });
  const radarW = (k) => radW[k];

  function seriesChart(vals) {
    const CW = 340, CH = 110, PL = 26, PR = 6, PT = 6, PB = 20;
    const iw = CW - PL - PR, ih = CH - PT - PB, bw = iw / vals.length;
    const y = (v) => PT + ih - (clamp(v, 0, 100) / 100) * ih;
    let g = "";
    [0, 50, 100].forEach((t) => { g += `<line class="grid" x1="${PL}" x2="${CW - PR}" y1="${y(t)}" y2="${y(t)}"/><text x="${PL - 5}" y="${y(t) + 3.5}" text-anchor="end">${t}</text>`; });
    vals.forEach((v, i) => {
      const x = PL + i * bw + 2, w = bw - 4, top = y(v), h = Math.max(1, PT + ih - top), r = Math.min(3, h, w / 2);
      g += `<rect class="hit" x="${PL + i * bw}" y="${PT}" width="${bw}" height="${ih}" data-tip="${stepLabel(steps[i])}, ${C.fmtHour.format(steps[i].time)}: ${C.fmtNum.format(v)} (${className(v).toLowerCase()})"/>`;
      g += `<path d="M${x},${PT + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${PT + ih} Z" fill="${C.bandColor(IDX, v)}" ${i === cur ? 'stroke="currentColor" stroke-width="1.5"' : ""}/>`;
      if (i % 2 === 0) g += `<text x="${PL + i * bw + bw / 2}" y="${CH - 5}" text-anchor="middle">${i === 0 ? "Ahora" : `+${steps[i].min / 60}h`}</text>`;
    });
    return `<svg class="chart" viewBox="0 0 ${CW} ${CH}" role="img" aria-label="Índice CELESTE en las próximas 6 horas">${g}</svg>`;
  }
})();
