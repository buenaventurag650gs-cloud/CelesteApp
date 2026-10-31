/* Estaciones de medición: IMN (lluvia por hora), IMHPA Panamá (lluvia de 24 h) y aeropuertos (METAR).
   Se muestran como capa y alimentan la calibración de la lluvia del radar en el índice CELESTE. */
(function () {
  "use strict";
  const C = window.Celeste;
  if (!C) return;
  const { map, $ } = C;

  // ---------- Datos ----------
  let cache = null, cacheAt = 0, loading = null;

  async function load() {
    if (cache && Date.now() - cacheAt < 10 * 60000) return cache;
    if (loading) return loading;
    loading = (async () => {
      const meta = await fetch("/datos/estaciones-imn.json").then((r) => r.json());
      const list = meta.estaciones.map(([n, t, lat, lon, q]) => ({ n, t, lat, lon, q, rows: [] }));
      const chunks = [];
      for (let i = 0; i < list.length; i += 12) chunks.push(list.slice(i, i + 12)); // el plan gratuito de Cloudflare limita las consultas por solicitud
      const [batches, pa, air] = await Promise.all([
        Promise.all(chunks.map((c) => fetch(`/api/estaciones/imn?t=${c.map((s) => s.t).join(",")}`).then((r) => r.json()).catch(() => ({ estaciones: {} })))),
        fetch("/api/estaciones/panama").then((r) => r.json()).catch(() => ({ estaciones: [] })),
        fetch("/api/estaciones/aeropuertos").then((r) => r.json()).catch(() => ({ aeropuertos: [] })),
      ]);
      const byT = new Map(list.map((s) => [s.t, s]));
      batches.forEach((b) => Object.entries(b.estaciones || {}).forEach(([t, rows]) => {
        const s = byT.get(t);
        if (s) s.rows = rows.map(([iso, r, tp]) => [Date.parse(iso), r, tp]).filter((x) => Number.isFinite(x[0])).sort((a, b) => b[0] - a[0]);
      }));
      cache = {
        imn: list.filter((s) => s.rows.length),
        pa: (pa.estaciones || []).map(([n, lat, lon, mm, iso]) => ({ n, lat, lon, mm, time: iso ? Date.parse(iso) : null })),
        air: air.aeropuertos || [],
      };
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
      if (t <= endMs + 10 * 60000 && t > endMs - hours * 3600000 + 10 * 60000) { sum += r; n++; }
    }
    return n ? sum : null;
  }

  C.stations = { load, accum };

  // ---------- Capa ----------
  map.createPane("estaciones").style.zIndex = 455;
  map.getPane("estaciones").style.opacity = 0.85;
  map.getPane("estaciones").classList.add("capa-datos");
  // Dibujante propio, creado desde el inicio para que conozca el área visible
  const rend = L.canvas({ pane: "estaciones", padding: 0.3 }).addTo(map);

  const RAIN = C.PAL.rain.colors;
  const PALS = {
    1: { levels: [0.5, 1, 2, 4, 8, 15, 30, 50], colors: RAIN, units: "mm en la última hora", fmt: C.fmtNum1 },
    6: { levels: [1, 3, 6, 12, 25, 40, 60, 90], colors: RAIN, units: "mm en las últimas 6 horas", fmt: C.fmtNum },
    24: { levels: [1, 5, 10, 20, 40, 60, 90, 120], colors: RAIN, units: "mm en las últimas 24 horas", fmt: C.fmtNum },
  };
  let hours = 1;
  let group = null;
  let active = false;
  let box = null;

  const WX = [
    [/TS/, "Tormenta"], [/\+SHRA|\+RA/, "Lluvia fuerte"], [/SHRA/, "Chubascos"], [/-RA|-SHRA/, "Lluvia débil"],
    [/RA/, "Lluvia"], [/DZ/, "Llovizna"], [/VCSH/, "Chubascos cerca"], [/FG/, "Niebla"], [/BR/, "Neblina"], [/HZ/, "Bruma"],
  ];
  const wxText = (wx) => (WX.find(([re]) => re.test(wx || "")) || [null, "Sin lluvia"])[1];

  // ---------- Superficie interpolada ----------
  // Las estaciones no se dibujan como puntos: su lluvia se traslada a una superficie continua
  // (promedio ponderado con núcleo gaussiano de 10 km, hasta 28 km de cada estación),
  // y se dibuja con los mismos polígonos suavizados y la misma paleta que el radar.
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
  const KERNEL_KM = 10, CUTOFF_KM = 28, MIN_W = 0.15;
  let surf = null; // {grid, ws, points}

  function surface(points) {
    const acc = new Float32Array(N), ws = new Float32Array(N);
    const [x0, y0, x1, y1] = AREA.bbox;
    const cellKm = (x1 - x0) / W / 1000 * Math.cos(9.7 * Math.PI / 180);
    const rad = Math.ceil(CUTOFF_KM / cellKm);
    points.forEach((p) => {
      const [X, Y] = C.merc(p.lat, p.lon);
      const ci = Math.floor(((X - x0) / (x1 - x0)) * W), cj = Math.floor(((y1 - Y) / (y1 - y0)) * H);
      const kx = 111.32 * Math.cos(p.lat * Math.PI / 180);
      for (let j = Math.max(0, cj - rad); j <= Math.min(H - 1, cj + rad); j++) {
        for (let i = Math.max(0, ci - rad); i <= Math.min(W - 1, ci + rad); i++) {
          const k = j * W + i;
          const dx = (cellLng[k] - p.lon) * kx, dy = (cellLat[k] - p.lat) * 110.6;
          const d2 = dx * dx + dy * dy;
          if (d2 > CUTOFF_KM * CUTOFF_KM) continue;
          const w = p.w * Math.exp(-d2 / (2 * KERNEL_KM * KERNEL_KM));
          acc[k] += w * p.v; ws[k] += w;
        }
      }
    });
    const raw = new Float32Array(N);
    for (let k = 0; k < N; k++) raw[k] = ws[k] >= MIN_W ? acc[k] / ws[k] : NaN;
    return { grid: C.blur(raw, W, H, 1.5), ws, points };
  }

  function collect(data) {
    const now = Date.now();
    const pts = [];
    let nImn = 0, nPa = 0;
    data.imn.forEach((s) => {
      const latest = s.rows[0] && s.rows[0][0];
      if (!latest || now - latest > 3 * 3600000) return;
      const v = accum(s, hours, latest);
      if (v == null) return;
      pts.push({ lat: s.lat, lon: s.lon, v, w: s.q ? 1 : 0.5, n: s.n, src: "IMN", time: latest });
      nImn++;
    });
    if (hours === 24) data.pa.forEach((s) => {
      if (s.mm == null || (s.time && now - s.time > 6 * 3600000)) return;
      pts.push({ lat: s.lat, lon: s.lon, v: s.mm, w: 1, n: s.n, src: "IMHPA", time: s.time });
      nPa++;
    });
    return { pts, nImn, nPa };
  }

  function draw(data) {
    if (group) map.removeLayer(group);
    group = L.layerGroup();
    const p = PALS[hours];
    const { pts, nImn, nPa } = collect(data);
    surf = surface(pts);
    L.geoJSON(C.polygons(surf.grid, W, H, AREA.bbox, p), {
      pane: "estaciones", renderer: rend, interactive: false, smoothFactor: 0.4,
      style: (f) => ({ fillColor: f.properties.c, fillOpacity: 1, color: f.properties.c, weight: 0.8, opacity: 1 }),
    }).addTo(group);
    // Contorno del área con información (dentro: hay estaciones cerca, aunque no haya llovido)
    const cov = new Float32Array(N);
    for (let k = 0; k < N; k++) cov[k] = surf.ws[k] >= MIN_W ? 1 : 0;
    const covS = C.blur(cov, W, H, 2);
    L.geoJSON(C.polygons(covS, W, H, AREA.bbox, { levels: [0.5], colors: ["#000"] }), {
      pane: "estaciones", renderer: rend, interactive: false, smoothFactor: 0.6,
      style: () => ({ fill: false, color: "#5d7488", weight: 1, opacity: 0.8, dashArray: "4 4" }),
    }).addTo(group);
    if (active) group.addTo(map);
    const wet = data.air.filter((a) => !/Sin lluvia|Neblina|Bruma/.test(wxText(a.wx)));
    const airTxt = data.air.length ? ` Aeropuertos: ${wet.length ? wet.map((a) => `${a.id} ${wxText(a.wx).toLowerCase()}`).join(", ") : "sin lluvia"}.` : "";
    const st = $(".stamp", box);
    if (st) st.textContent = `Superficie de ${nImn} estaciones del IMN${hours === 24 ? ` y ${nPa} de Panamá` : ""}. Datos preliminares en tiempo real.${airTxt}`;
    const lg = $(".est-legend", box);
    if (lg) lg.innerHTML = C.legendHTML(p);
  }

  function extraHTML() {
    return `<div class="seg est-seg" role="radiogroup" aria-label="Período de lluvia">
        <button type="button" role="radio" data-h="1" aria-checked="true">Última hora</button>
        <button type="button" role="radio" data-h="6" aria-checked="false">6 horas</button>
        <button type="button" role="radio" data-h="24" aria-checked="false">24 horas</button>
      </div>
      <div class="est-legend"></div>
      <p class="stamp">Cargando estaciones…</p>
      <p class="layer-desc">La línea punteada encierra la zona con estaciones cercanas: dentro de ella, sin color significa que no llovió. Panamá solo publica 24 horas.</p>`;
  }

  // Valor de la superficie al tocar un punto
  C.pointHooks.push((lat, lng) => {
    if (!active || !surf || document.body.classList.contains("modo-indice")) return "";
    const [X, Y] = C.merc(lat, lng);
    const [x0, y0, x1, y1] = AREA.bbox;
    const i = Math.floor(((X - x0) / (x1 - x0)) * W), j = Math.floor(((y1 - Y) / (y1 - y0)) * H);
    if (i < 0 || j < 0 || i >= W || j >= H) return "";
    const v = surf.grid[j * W + i];
    const p = PALS[hours];
    let near = null, nd = Infinity;
    surf.points.forEach((s) => {
      const d = Math.hypot((s.lon - lng) * 111.32 * Math.cos(lat * Math.PI / 180), (s.lat - lat) * 110.6);
      if (d < nd) { nd = d; near = s; }
    });
    const txt = Number.isFinite(v) ? (v >= p.levels[0] ? `${C.fmtNum1.format(v)} ${p.units}` : `Sin lluvia (${p.units.replace("mm ", "")})`) : "Sin estaciones cerca";
    return `<h3>Estaciones de lluvia</h3><div class="values"><div class="value-row"><span class="swatch" style="background:${Number.isFinite(v) ? C.bandColor(p, v) || "transparent" : "transparent"}"></span><span class="value-name">Estimado en este punto</span><b>${txt}</b></div>${near ? `<div class="value-row"><span class="swatch"></span><span class="value-name">Más cercana: ${near.n} (${near.src}), a ${C.fmtNum.format(nd)} km</span><b>${C.fmtNum1.format(near.v)} mm</b></div>` : ""}</div>`;
  });

  C.ext = C.ext || {};
  C.ext.estaciones = async (on, b) => {
    active = on;
    box = b;
    const extra = $(".layer-extra", box);
    if (on && !extra.dataset.ready) {
      extra.insertAdjacentHTML("afterbegin", extraHTML());
      extra.dataset.ready = "1";
      extra.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-h]");
        if (!btn) return;
        hours = parseInt(btn.dataset.h, 10);
        extra.querySelectorAll("[data-h]").forEach((x) => x.setAttribute("aria-checked", String(x === btn)));
        if (cache) draw(cache);
      });
    }
    if (!on) { if (group) map.removeLayer(group); return; }
    try { draw(await load()); }
    catch (e) { const st = $(".stamp", box); if (st) st.textContent = "No se pudieron cargar las estaciones. Vuelve a intentarlo en unos minutos."; }
  };
})();
