/* Lluvia medida en estaciones: IMN (lluvia por hora), IMHPA Panamá (24 h) y aeropuertos (METAR).
   No se dibujan puntos: la información se traslada a superficies continuas con la misma paleta y
   polígonos suavizados que el radar. Modo principal: serie horaria de −6 h a +6 h.
   - Pasado: lluvia medida cada hora, interpolada (núcleo gaussiano de 10 km, alcance 28 km).
   - Futuro: lluvia del modelo numérico corregida con el sesgo local que muestran las estaciones en las
     últimas 3 horas; en las primeras 2 horas se mezcla con la persistencia de la última hora medida.
   También alimenta la calibración del radar en el índice CELESTE. */
(function () {
  "use strict";
  const C = window.Celeste;
  if (!C) return;
  const { map, $ } = C;
  const H1 = 3600000;
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

  // ---------- Datos ----------
  let cache = null, cacheAt = 0, loading = null;

  async function load() {
    if (cache && Date.now() - cacheAt < 10 * 60000) return cache;
    if (loading) return loading;
    loading = (async () => {
      const meta = await fetch("/datos/estaciones-imn.json").then((r) => r.json());
      const all = meta.estaciones.map(([n, t, lat, lon, q]) => ({ n, t, lat, lon, q, rows: [], cols: [], filas: [] }));
      const list = all.filter((s) => s.t);
      const chunks = [];
      for (let i = 0; i < list.length; i += 12) chunks.push(list.slice(i, i + 12)); // límite de subconsultas del plan gratuito
      const [batches, pa, air] = await Promise.all([
        Promise.all(chunks.map((c) => fetch(`/api/estaciones/imn?t=${c.map((s) => s.t).join(",")}`).then((r) => r.json()).catch(() => ({ estaciones: {} })))),
        fetch("/api/estaciones/panama").then((r) => r.json()).catch(() => ({ estaciones: [] })),
        fetch("/api/estaciones/aeropuertos").then((r) => r.json()).catch(() => ({ aeropuertos: [] })),
      ]);
      // Panamá (IMHPA): serie horaria de lluvia de cada estación (lotes de 12 por el límite de subconsultas)
      const paList = (pa.estaciones || []).map(([n, lat, lon, mm, iso, v, id]) => ({ n, lat, lon, mm, time: iso ? Date.parse(iso) : null, v: v || {}, id, q: 1, src: "IMHPA", rows: [] }));
      const paIds = paList.filter((s) => s.id && s.v.lluvia);
      const paChunks = [];
      for (let i = 0; i < paIds.length; i += 12) paChunks.push(paIds.slice(i, i + 12));
      const paSeries = await Promise.all(paChunks.map((c) => fetch(`/api/estaciones/panama/serie?e=${c.map((s) => s.id).join(",")}`).then((r) => r.json()).catch(() => ({ estaciones: {} }))));
      const paById = new Map(paList.map((s) => [s.id, s]));
      paSeries.forEach((b) => Object.entries(b.estaciones || {}).forEach(([id, d]) => {
        const s = paById.get(id);
        if (!s || !d.filas) return;
        const tp = s.v.temp ? s.v.temp[0] : null;
        s.rows = d.filas.map(([iso, r], i) => [Date.parse(iso), r, i === 0 ? tp : null]).filter((x) => Number.isFinite(x[0])).sort((a, b) => b[0] - a[0]);
      }));
      const byT = new Map(list.map((s) => [s.t, s]));
      batches.forEach((b) => Object.entries(b.estaciones || {}).forEach(([t, d]) => {
        const s = byT.get(t);
        if (!s) return;
        const rows = Array.isArray(d) ? d : d.filas || [];
        s.cols = Array.isArray(d) ? ["Lluvia", "Temp"] : d.cols || [];
        const iR = s.cols.findIndex((c) => /lluvia/i.test(c));
        const iT = s.cols.findIndex((c) => /^temp/i.test(c));
        s.filas = rows.map((f) => [Date.parse(f[0])].concat(f.slice(1))).filter((x) => Number.isFinite(x[0])).sort((a, b) => b[0] - a[0]);
        // Filas de lluvia y temperatura (solo estaciones que miden lluvia)
        s.rows = iR >= 0 ? s.filas.map((f) => [f[0], f[iR + 1], iT >= 0 ? f[iT + 1] : null]) : [];
      }));
      cache = {
        all,
        imn: list.filter((s) => s.rows.length),
        pa: paList,
        rios: pa.rios || [],
        air: air.aeropuertos || [],
      };
      // Estaciones con lluvia por hora (IMN y Panamá): alimentan la superficie horaria y el índice
      cache.hourly = cache.imn.map((s) => Object.assign(s, { src: "IMN" })).concat(paList.filter((s) => s.rows.length));
      cacheAt = Date.now();
      loading = null;
      return cache;
    })().catch((e) => { loading = null; throw e; });
    return loading;
  }

  // Lluvia acumulada en las horas que terminan en endMs (filas horarias del IMN)
  function accum(s, hours, endMs) {
    let sum = 0, n = 0;
    for (const [t, r] of s.rows) {
      if (r == null) continue;
      if (t <= endMs + 10 * 60000 && t > endMs - hours * H1 + 10 * 60000) { sum += r; n++; }
    }
    return n ? sum : null;
  }
  // Lluvia de la hora que termina en hourMs
  function hourValue(s, hourMs) {
    for (const [t, r] of s.rows) if (Math.abs(t - hourMs) < 10 * 60000) return r;
    return null;
  }

  C.stations = { load, accum };

  // ---------- Rejilla ----------
  const AREA = C.extent(7.9, -86.25, 11.35, -82.45, 320); // ~1,3 km por celda
  const W = AREA.w, H = AREA.h, N = W * H;
  const cellLat = new Float32Array(N), cellLng = new Float32Array(N);
  (function () {
    const [x0, y0, x1, y1] = AREA.bbox;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const [lat, lng] = C.unmerc(x0 + ((i + 0.5) / W) * (x1 - x0), y1 - ((j + 0.5) / H) * (y1 - y0));
      cellLat[j * W + i] = lat; cellLng[j * W + i] = lng;
    }
  })();
  const cellKm = (AREA.bbox[2] - AREA.bbox[0]) / W / 1000 * Math.cos(9.7 * Math.PI / 180);
  const MIN_W = 0.15;

  // Promedio ponderado gaussiano: devuelve el campo y el peso acumulado (dónde hay información)
  function interpolate(points, kernelKm, cutoffKm) {
    const acc = new Float32Array(N), ws = new Float32Array(N);
    const [x0, y0, x1, y1] = AREA.bbox;
    const rad = Math.ceil(cutoffKm / cellKm);
    for (const p of points) {
      const [X, Y] = C.merc(p.lat, p.lon);
      const ci = Math.floor(((X - x0) / (x1 - x0)) * W), cj = Math.floor(((y1 - Y) / (y1 - y0)) * H);
      const kx = 111.32 * Math.cos(p.lat * Math.PI / 180);
      for (let j = Math.max(0, cj - rad); j <= Math.min(H - 1, cj + rad); j++) {
        for (let i = Math.max(0, ci - rad); i <= Math.min(W - 1, ci + rad); i++) {
          const k = j * W + i;
          const dx = (cellLng[k] - p.lon) * kx, dy = (cellLat[k] - p.lat) * 110.6;
          const d2 = dx * dx + dy * dy;
          if (d2 > cutoffKm * cutoffKm) continue;
          const w = p.w * Math.exp(-d2 / (2 * kernelKm * kernelKm));
          acc[k] += w * p.v; ws[k] += w;
        }
      }
    }
    const out = new Float32Array(N);
    for (let k = 0; k < N; k++) out[k] = ws[k] >= MIN_W ? acc[k] / ws[k] : NaN;
    return { grid: out, ws };
  }

  // Modelo (rejilla de 0,3°) en la rejilla de la capa
  function modelField(model, tSec) {
    const { times, lats, lons, vars } = model;
    const arr = vars.precipitation, ny = lats.length, nx = lons.length, step = lats[1] - lats[0];
    let a = 0;
    while (a < times.length - 2 && times[a + 1] <= tSec) a++;
    const f = clamp((tSec - times[a]) / (times[a + 1] - times[a]));
    const out = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const fi = (cellLng[k] - lons[0]) / step, fj = (cellLat[k] - lats[0]) / step;
      const i0 = clamp(Math.floor(fi), 0, nx - 1), j0 = clamp(Math.floor(fj), 0, ny - 1);
      const i1 = Math.min(nx - 1, i0 + 1), j1 = Math.min(ny - 1, j0 + 1);
      const ux = clamp(fi - i0), uy = clamp(fj - j0);
      const v = (ti) => {
        const g = (j, i) => arr[(ti * ny + j) * nx + i] || 0;
        return g(j0, i0) * (1 - ux) * (1 - uy) + g(j0, i1) * ux * (1 - uy) + g(j1, i0) * (1 - ux) * uy + g(j1, i1) * ux * uy;
      };
      out[k] = Math.max(0, v(a) * (1 - f) + v(a + 1) * f);
    }
    return out;
  }
  function sampleAt(grid, lat, lng) {
    const [X, Y] = C.merc(lat, lng);
    const [x0, y0, x1, y1] = AREA.bbox;
    const i = Math.floor(((X - x0) / (x1 - x0)) * W), j = Math.floor(((y1 - Y) / (y1 - y0)) * H);
    if (i < 0 || j < 0 || i >= W || j >= H) return NaN;
    return grid[j * W + i];
  }

  // ---------- Capa ----------
  map.createPane("estaciones").style.zIndex = 455;
  map.getPane("estaciones").style.opacity = 0.85;
  map.getPane("estaciones").classList.add("capa-datos");
  const rend = L.canvas({ pane: "estaciones", padding: 0.3 }).addTo(map);
  const polyStyle = (f) => ({ fillColor: f.properties.c, fillOpacity: 1, color: f.properties.c, weight: 0.8, opacity: 1 });
  const outlineStyle = () => ({ fill: false, color: "#5d7488", weight: 1, opacity: 0.8, dashArray: "4 4" });

  const RAIN = C.PAL.rain.colors;
  const PALS = {
    1: { levels: [0.5, 1, 2, 4, 8, 15, 30, 50], colors: RAIN, units: "mm en la hora", fmt: C.fmtNum1 },
    6: { levels: [1, 3, 6, 12, 25, 40, 60, 90], colors: RAIN, units: "mm en las últimas 6 horas", fmt: C.fmtNum },
    24: { levels: [1, 5, 10, 20, 40, 60, 90, 120], colors: RAIN, units: "mm en las últimas 24 horas", fmt: C.fmtNum },
  };
  let mode = "serie"; // "serie" | 6 | 24
  let group = null;
  let active = false;
  let box = null;

  const WX = [
    [/TS/, "Tormenta"], [/\+SHRA|\+RA/, "Lluvia fuerte"], [/SHRA/, "Chubascos"], [/-RA|-SHRA/, "Lluvia débil"],
    [/RA/, "Lluvia"], [/DZ/, "Llovizna"], [/VCSH/, "Chubascos cerca"], [/FG/, "Niebla"], [/BR/, "Neblina"], [/HZ/, "Bruma"],
  ];
  const wxText = (wx) => (WX.find(([re]) => re.test(wx || "")) || [null, "Sin lluvia"])[1];

  function drawSurface(grid, ws, p, withOutline) {
    if (group) map.removeLayer(group);
    group = L.layerGroup();
    L.geoJSON(C.polygons(C.blur(grid, W, H, 1.5), W, H, AREA.bbox, p), { pane: "estaciones", renderer: rend, interactive: false, smoothFactor: 0.4, style: polyStyle }).addTo(group);
    if (withOutline && ws) {
      const cov = new Float32Array(N);
      for (let k = 0; k < N; k++) cov[k] = ws[k] >= MIN_W ? 1 : 0;
      L.geoJSON(C.polygons(C.blur(cov, W, H, 2), W, H, AREA.bbox, { levels: [0.5], colors: ["#000"] }), { pane: "estaciones", renderer: rend, interactive: false, smoothFactor: 0.6, style: outlineStyle }).addTo(group);
    }
    if (active) group.addTo(map);
  }

  // ---------- Modo acumulado (6 h / 24 h) ----------
  let static_ = null;
  function drawStatic(data) {
    const hours = mode;
    const now = Date.now();
    const pts = [];
    let nImn = 0, nPa = 0;
    data.hourly.forEach((s) => {
      const latest = s.rows[0] && s.rows[0][0];
      if (!latest || now - latest > 3 * H1) return;
      const v = accum(s, hours, latest);
      if (v == null) return;
      pts.push({ lat: s.lat, lon: s.lon, v, w: s.q ? 1 : 0.5, n: s.n, src: s.src });
      if (s.src === "IMHPA") nPa++; else nImn++;
    });
    if (hours === 24) data.pa.forEach((s) => {
      if (s.rows.length) return; // ya entró con su serie horaria
      if (s.mm == null || (s.time && now - s.time > 6 * H1)) return;
      pts.push({ lat: s.lat, lon: s.lon, v: s.mm, w: 1, n: s.n, src: "IMHPA" });
      nPa++;
    });
    const r = interpolate(pts, 10, 28);
    static_ = { ...r, pts, p: PALS[hours] };
    drawSurface(r.grid, r.ws, PALS[hours], true);
    setStamp(`Superficie de ${nImn} estaciones del IMN y ${nPa} de Panamá.${airText(data)}`);
    setLegend(PALS[hours]);
  }

  // ---------- Serie horaria −6 h … +6 h ----------
  const SERIE = Array.from({ length: 13 }, (_, i) => i - 6); // horas relativas a la última hora medida
  let serie = null; // {t0, steps:[{h, time, grid, ws, kind}], points:[...], nStations, bias}
  let cur = 6;

  async function buildSerie(data) {
    const model = await fetch("/api/celeste/modelo").then((r) => r.json());
    // Última hora con datos en la mayoría de estaciones
    const counts = new Map();
    data.imn.forEach((s) => s.rows.slice(0, 3).forEach(([t]) => counts.set(t, (counts.get(t) || 0) + 1)));
    const t0 = [...counts.entries()].filter(([, n]) => n >= Math.max(10, data.imn.length * 0.5)).map(([t]) => t).sort((a, b) => b - a)[0]
      || Math.max(...data.imn.map((s) => s.rows[0][0]));
    const steps = [];
    // Pasado y ahora: lluvia medida en cada hora
    for (const h of SERIE.filter((x) => x <= 0)) {
      const tm = t0 + h * H1;
      const pts = [];
      data.hourly.forEach((s) => { const v = hourValue(s, tm); if (v != null) pts.push({ lat: s.lat, lon: s.lon, v, w: s.q ? 1 : 0.5, n: s.n, src: s.src }); });
      const r = interpolate(pts, 10, 28);
      steps.push({ h, time: new Date(tm), grid: r.grid, ws: r.ws, kind: h === 0 ? "ahora" : "medido", n: pts.length });
    }
    // Sesgo local del modelo: lluvia medida / lluvia del modelo en las últimas 3 horas, en cada estación
    const biasPts = [];
    data.hourly.forEach((s) => {
      if (!s.q) return;
      let o = 0, m = 0, n = 0;
      for (let h = 0; h > -3; h--) {
        const tm = t0 + h * H1;
        const v = hourValue(s, tm);
        if (v == null) continue;
        const mf = modelAtPoint(model, tm / 1000, s.lat, s.lon);
        o += v; m += mf; n++;
      }
      if (n >= 2) biasPts.push({ lat: s.lat, lon: s.lon, v: Math.log(clamp((o + 0.5) / (m + 0.5), 0.25, 4)), w: 1 });
    });
    const bias = interpolate(biasPts, 25, 60);
    const last = steps[steps.length - 1];
    // Futuro: modelo corregido; las primeras horas se mezclan con la persistencia de la última hora medida
    for (const h of SERIE.filter((x) => x > 0)) {
      const tm = t0 + h * H1;
      const mod = modelField(model, tm / 1000);
      const wPersist = clamp(1 - h / 3);
      const g = new Float32Array(N);
      for (let k = 0; k < N; k++) {
        const b = Number.isFinite(bias.grid[k]) ? Math.exp(bias.grid[k] * clamp(bias.ws[k] / 0.6)) : 1;
        const adj = mod[k] * b;
        const per = Number.isFinite(last.grid[k]) ? last.grid[k] : adj;
        g[k] = wPersist * per + (1 - wPersist) * adj;
      }
      steps.push({ h, time: new Date(tm), grid: g, ws: null, kind: "pronostico" });
    }
    const pointsNow = [];
    data.hourly.forEach((s) => { const v = hourValue(s, t0); if (v != null) pointsNow.push({ lat: s.lat, lon: s.lon, v, n: s.n, src: s.src }); });
    steps.forEach((st) => {
      const sample = [];
      for (let k = 0; k < N; k += 4) if (Number.isFinite(st.grid[k])) sample.push(st.grid[k]);
      sample.sort((a, b) => a - b);
      st.p90 = sample[Math.floor(sample.length * 0.95)] || 0;
    });
    serie = { t0, steps, nStations: last.n, nPa: pointsNow.filter((p) => p.src === "IMHPA").length, biasN: biasPts.length, points: pointsNow, builtAt: Date.now() };
  }

  function modelAtPoint(model, tSec, lat, lon) {
    const { times, lats, lons, vars } = model;
    const arr = vars.precipitation, ny = lats.length, nx = lons.length, step = lats[1] - lats[0];
    let a = 0;
    while (a < times.length - 2 && times[a + 1] <= tSec) a++;
    const f = clamp((tSec - times[a]) / (times[a + 1] - times[a]));
    const fi = clamp((lon - lons[0]) / step, 0, nx - 1), fj = clamp((lat - lats[0]) / step, 0, ny - 1);
    const i0 = Math.floor(fi), j0 = Math.floor(fj), i1 = Math.min(nx - 1, i0 + 1), j1 = Math.min(ny - 1, j0 + 1), ux = fi - i0, uy = fj - j0;
    const v = (ti) => { const g = (j, i) => arr[(ti * ny + j) * nx + i] || 0; return g(j0, i0) * (1 - ux) * (1 - uy) + g(j0, i1) * ux * (1 - uy) + g(j1, i0) * (1 - ux) * uy + g(j1, i1) * ux * uy; };
    return Math.max(0, v(a) * (1 - f) + v(a + 1) * f);
  }

  const leadText = (h) => (h === 0 ? "Última hora" : `${h < 0 ? "−" : "+"}${Math.abs(h)} h`);
  const kindText = (st) => ({ medido: "medido en estaciones", ahora: "medido en estaciones", pronostico: st.h <= 2 ? "pronóstico: persistencia y modelo corregido" : "pronóstico: modelo corregido con estaciones" })[st.kind];

  function showSerie(i, off) {
    if (!serie) return;
    cur = clamp(i, 0, serie.steps.length - 1);
    const st = serie.steps[cur];
    drawSurface(st.grid, st.ws, PALS[1], st.kind !== "pronostico");
    C.setOff(map.getPane("estaciones"), off);
  }

  // Fila de la superficie horaria en la línea de tiempo (cada paso es la lluvia de la hora que termina ahí)
  function registerTime() {
    if (!serie || !active || mode !== "serie") return;
    const byT = new Map(serie.steps.map((st, i) => [st.time.getTime(), i]));
    C.time.register("estaciones", {
      label: "Lluvia de estaciones hora a hora (derivado)", short: "Est. ±6 h", icon: C.icon("surface"), order: 3,
      times: [...byT.keys()], tol: 35 * 60000, step: H1,
      fc: (t) => t > serie.t0,
      value: (t) => clamp(Math.log1p(serie.steps[byT.get(t)].p90) / Math.log1p(15)),
      show: (t, off) => showSerie(byT.get(t), off),
    });
  }

  // La serie para el índice CELESTE (se calcula si hace falta)
  let serieProm = null;
  async function getSerie() {
    if (serie && Date.now() - serie.builtAt < 10 * 60000) return serie;
    if (!serieProm) serieProm = load().then(buildSerie).then(() => serie).finally(() => { serieProm = null; });
    return serieProm;
  }
  C.stations.serie = getSerie;
  C.stations.AREA = { w: W, h: H, bbox: AREA.bbox, MIN_W };

  // ---------- Panel ----------
  const setStamp = (t) => { const el = box && $(".stamp", box); if (el) el.textContent = t; };
  const setLegend = (p) => { const el = box && $(".est-legend", box); if (el) el.innerHTML = C.legendHTML(p); };
  function airText(data) {
    if (!data.air.length) return "";
    const wet = data.air.filter((a) => !/Sin lluvia|Neblina|Bruma/.test(wxText(a.wx)));
    return ` Aeropuertos: ${wet.length ? wet.map((a) => `${a.id} ${wxText(a.wx).toLowerCase()}`).join(", ") : "sin lluvia"}.`;
  }

  async function render() {
    const data = await load();
    if (mode === "serie") {
      setStamp("Calculando la serie horaria…");
      await getSerie();
      showSerie(6);
      registerTime();
      setLegend(PALS[1]);
      setStamp(`${serie.nStations} estaciones con dato en la última hora (${serie.nStations - serie.nPa} del IMN y ${serie.nPa} de Panamá). Pronóstico corregido con el sesgo local de ${serie.biasN} estaciones. Usa la línea de tiempo de abajo.${airText(data)}`);
    } else {
      C.time.unregister("estaciones");
      C.setOff(map.getPane("estaciones"), false);
      drawStatic(data);
    }
  }

  function extraHTML() {
    return `<div class="seg est-seg" role="radiogroup" aria-label="Modo de la capa de estaciones">
        <button type="button" role="radio" data-m="serie" aria-checked="true">Por hora ±6 h</button>
        <button type="button" role="radio" data-m="6" aria-checked="false">6 horas</button>
        <button type="button" role="radio" data-m="24" aria-checked="false">24 horas</button>
      </div>
      <div class="est-legend"></div>
      <p class="stamp">Cargando estaciones…</p>
      <p class="layer-desc">Derivado de las estaciones del IMN y de Panamá. La línea punteada encierra la zona con estaciones cercanas: dentro de ella, sin color significa que no llovió. El pronóstico usa el modelo corregido con lo que miden las estaciones.</p>`;
  }

  C.ext = C.ext || {};
  C.ext.estaciones = async (on, b) => {
    active = on;
    box = b;
    const extra = $(".layer-extra", box);
    if (on && !extra.dataset.ready) {
      extra.insertAdjacentHTML("afterbegin", extraHTML());
      extra.dataset.ready = "1";
      extra.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-m]");
        if (!btn) return;
        mode = btn.dataset.m === "serie" ? "serie" : parseInt(btn.dataset.m, 10);
        extra.querySelectorAll("[data-m]").forEach((x) => x.setAttribute("aria-checked", String(x === btn)));
        render().catch(() => setStamp("No se pudieron cargar las estaciones."));
      });
    }
    if (!on) {
      if (group) map.removeLayer(group);
      C.time.unregister("estaciones");
      C.setOff(map.getPane("estaciones"), false);
      return;
    }
    try { await render(); }
    catch (e) { setStamp("No se pudieron cargar las estaciones. Vuelve a intentarlo en unos minutos."); }
  };

  // ---------- Al tocar un punto ----------
  C.pointHooks.push((lat, lng) => {
    if (!active || document.body.classList.contains("modo-indice")) return "";
    if (mode === "serie" && serie) {
      const vals = serie.steps.map((s) => sampleAt(s.grid, lat, lng));
      const v = vals[cur];
      const p = PALS[1];
      const st = serie.steps[cur];
      let near = null, nd = Infinity;
      serie.points.forEach((s) => { const d = Math.hypot((s.lon - lng) * 111.32 * Math.cos(lat * Math.PI / 180), (s.lat - lat) * 110.6); if (d < nd) { nd = d; near = s; } });
      const past = vals.slice(0, 7).filter(Number.isFinite).reduce((a, b) => a + b, 0);
      const fut = vals.slice(7).filter(Number.isFinite).reduce((a, b) => a + b, 0);
      return `<h3>Lluvia medida en estaciones</h3>
        <div class="values">
          <div class="value-row"><span class="swatch" style="background:${Number.isFinite(v) ? C.bandColor(p, v) || "transparent" : "transparent"}"></span><span class="value-name">${leadText(st.h)} en este punto</span><b>${Number.isFinite(v) ? (v >= p.levels[0] ? `${C.fmtNum1.format(v)} mm` : "Sin lluvia") : "Sin estaciones cerca"}</b></div>
          <div class="value-row"><span class="swatch"></span><span class="value-name">Últimas 7 horas medidas / próximas 6</span><b>${C.fmtNum.format(past)} / ${C.fmtNum.format(fut)} mm</b></div>
          ${near ? `<div class="value-row"><span class="swatch"></span><span class="value-name">Estación más cercana: ${near.n}, a ${C.fmtNum.format(nd)} km</span><b>${C.fmtNum1.format(near.v)} mm</b></div>` : ""}
        </div>
        <p class="chart-title">Lluvia por hora (mm)</p>${serieChart(vals)}`;
    }
    if (static_) {
      const v = sampleAt(static_.grid, lat, lng);
      const p = static_.p;
      return `<h3>Lluvia medida en estaciones</h3><div class="values"><div class="value-row"><span class="swatch" style="background:${Number.isFinite(v) ? C.bandColor(p, v) || "transparent" : "transparent"}"></span><span class="value-name">Estimado en este punto</span><b>${Number.isFinite(v) ? (v >= p.levels[0] ? `${C.fmtNum1.format(v)} ${p.units}` : "Sin lluvia") : "Sin estaciones cerca"}</b></div></div>`;
    }
    return "";
  });

  function serieChart(vals) {
    const CW = 340, CH = 110, PL = 26, PR = 6, PT = 8, PB = 20;
    const iw = CW - PL - PR, ih = CH - PT - PB, bw = iw / vals.length;
    const max = Math.max(2, ...vals.filter(Number.isFinite)) * 1.1;
    const y = (v) => PT + ih - (v / max) * ih;
    let g = "";
    [0, max / 2, max].forEach((t) => { g += `<line class="grid" x1="${PL}" x2="${CW - PR}" y1="${y(t)}" y2="${y(t)}"/><text x="${PL - 5}" y="${y(t) + 3.5}" text-anchor="end">${C.fmtNum.format(t)}</text>`; });
    const xNow = PL + 6 * bw + bw;
    g += `<line x1="${xNow}" x2="${xNow}" y1="${PT}" y2="${PT + ih}" stroke="currentColor" stroke-width="1" stroke-dasharray="3 3" opacity="0.5"/>`;
    vals.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const x = PL + i * bw + 2, w = bw - 4, top = y(v), h = Math.max(1, PT + ih - top), r = Math.min(3, h, w / 2);
      const st = serie.steps[i];
      g += `<rect class="hit" x="${PL + i * bw}" y="${PT}" width="${bw}" height="${ih}" data-tip="${leadText(st.h)}: ${C.fmtNum1.format(v)} mm (${st.kind === "pronostico" ? "pronóstico" : "medido"})"/>`;
      g += `<path class="bar" d="M${x},${PT + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${PT + ih} Z" opacity="${st.kind === "pronostico" ? 0.5 : 1}" ${i === cur ? 'stroke="currentColor" stroke-width="1.2"' : ""}/>`;
    });
    [[0, "−6 h"], [6, "Última"], [12, "+6 h"]].forEach(([i, t]) => { g += `<text x="${PL + i * bw + bw / 2}" y="${CH - 5}" text-anchor="${i === 0 ? "start" : i === 12 ? "end" : "middle"}">${t}</text>`; });
    return `<svg class="chart" viewBox="0 0 ${CW} ${CH}" role="img" aria-label="Lluvia por hora en este punto, medida y pronosticada">${g}</svg>`;
  }
})();
