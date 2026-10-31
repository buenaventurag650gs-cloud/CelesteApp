/* Celeste — visor climático de Costa Rica
   Las capas de datos (radar, lluvia, mar, suelo, vegetación, partículas) se leen como
   valores, se suavizan y se dibujan como polígonos vectoriales con una paleta propia. */
(function () {
  "use strict";

  // ---------- Utilidades ----------
  const $ = (s, el = document) => el.querySelector(s);
  const TZ = "America/Costa_Rica";
  const fmtHour = new Intl.DateTimeFormat("es-CR", { hour: "numeric", minute: "2-digit", timeZone: TZ });
  const fmtDay = new Intl.DateTimeFormat("es-CR", { weekday: "short", day: "numeric", timeZone: TZ });
  const fmtNum = new Intl.NumberFormat("es-CR", { maximumFractionDigits: 0 });
  const fmtNum1 = new Intl.NumberFormat("es-CR", { maximumFractionDigits: 1 });
  const fmtNum2 = new Intl.NumberFormat("es-CR", { maximumFractionDigits: 2 });
  const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const MONTHS_LONG = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } },
  };

  function toast(msg, ms = 4500) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), ms);
  }

  function ago(date) {
    const min = Math.round((Date.now() - date.getTime()) / 60000);
    if (min < 1) return "ahora mismo";
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `hace ${h} h ${m} min` : `hace ${h} h`;
  }
  function isToday(date) {
    return date.toLocaleDateString("es-CR", { timeZone: TZ }) === new Date().toLocaleDateString("es-CR", { timeZone: TZ });
  }
  function yesterdayUTC() {
    return new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  }

  // Web Mercator
  const R = 6378137;
  const merc = (lat, lng) => [(lng * Math.PI / 180) * R, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R];
  const unmerc = (x, y) => [(2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI, (x / R) * 180 / Math.PI];

  function extent(south, west, north, east, width) {
    const sw = merc(south, west), ne = merc(north, east);
    const w = width;
    const h = Math.round(width * (ne[1] - sw[1]) / (ne[0] - sw[0]));
    return { bbox: [sw[0], sw[1], ne[0], ne[1]], w, h, bounds: L.latLngBounds([south, west], [north, east]) };
  }

  // ---------- Paletas (una sola familia visual) ----------
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const toHex = (a) => "#" + a.map((v) => v.toString(16).padStart(2, "0")).join("");
  function ramp(stops, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : (i / (n - 1)) * (stops.length - 1);
      const a = Math.floor(t), b = Math.min(stops.length - 1, a + 1), f = t - a;
      const A = hex(stops[a]), B = hex(stops[b]);
      out.push(toHex(A.map((v, k) => Math.round(v + (B[k] - v) * f))));
    }
    return out;
  }
  const steps = (a, b, s) => { const r = []; for (let v = a; v <= b + 1e-9; v += s) r.push(+v.toFixed(4)); return r; };

  const RAIN_COLORS = ["#a6d8f2", "#78c0ea", "#4aa6e0", "#2f8fd3", "#1f66b5", "#3a3f9c", "#6e2a92", "#b0237a"];
  const THERMAL = ["#2c4f8f", "#3f7fbf", "#6fb3d6", "#a8dcd1", "#e8efb0", "#f7d07a", "#f09a4f", "#d9583a", "#a8263a"];

  const PAL = {
    rain: { levels: [0.5, 1, 2, 4, 8, 15, 30, 50], colors: RAIN_COLORS, units: "mm/h", words: ["Débil", "Moderada", "Fuerte", "Muy fuerte"], fmt: fmtNum1 },
    rainDay: { levels: [1, 5, 10, 20, 40, 60, 90, 120], colors: RAIN_COLORS, units: "mm en el día", words: ["Poca", "Moderada", "Mucha", "Extrema"], fmt: fmtNum },
    sst: { levels: steps(24, 31, 0.5), colors: ramp(THERMAL, 15), units: "°C", clamp: true, fmt: fmtNum1 },
    ssta: { levels: steps(-3.25, 2.75, 0.5), colors: ramp(["#2b5c9e", "#7fa7d6", "#d9d9d9", "#e8957a", "#b23a3a"], 13), units: "°C respecto a lo normal", clamp: true, fmt: fmtNum1, signed: true, words: ["Más frío", "Normal", "Más caliente"] },
    lst: { levels: steps(14, 46, 2), colors: ramp(THERMAL, 17), units: "°C", clamp: true, fmt: fmtNum },
    ndvi: { levels: steps(0, 0.85, 0.05), colors: ramp(["#a6784f", "#c9a86a", "#e3d692", "#b9d77d", "#7fbf5f", "#3f9a49", "#1d6b35"], 18), units: "índice de verdor", clamp: true, fmt: fmtNum2, words: ["Seco o sin vegetación", "Muy verde"] },
    aod: { levels: steps(0.1, 1, 0.1), colors: ramp(["#efe9f6", "#cbbbe2", "#a78fcd", "#8463b8", "#6440a0", "#45237f"], 10), units: "espesor óptico", fmt: fmtNum2, words: ["Aire limpio", "Muy cargado"] },
  };

  function bandColor(p, v) {
    if (!Number.isFinite(v)) return null;
    let c = null;
    for (let i = 0; i < p.levels.length; i++) if (v >= p.levels[i]) c = p.colors[i];
    return c;
  }

  function legendHTML(p) {
    const n = p.levels.length;
    const first = p.fmt.format(p.levels[0]);
    const mid = p.fmt.format(p.levels[Math.floor(n / 2)]);
    const last = p.fmt.format(p.levels[n - 1]);
    const sign = (s, v) => (p.signed && v > 0 ? "+" : "") + s;
    return `<div class="scale" aria-hidden="true">${p.colors.map((c) => `<span style="background:${c}"></span>`).join("")}</div>
      <div class="scale-labels"><span>${sign(first, p.levels[0])}</span><span>${sign(mid, p.levels[Math.floor(n / 2)])}</span><span>${sign(last, p.levels[n - 1])}${p.clamp ? "" : "+"}</span></div>
      <div class="scale-units">${p.units}</div>${p.words ? `<div class="scale-words">${p.words.map((w) => `<span>${w}</span>`).join("")}</div>` : ""}`;
  }

  // ---------- Motor de campos: imagen → valores → suavizado → polígonos ----------
  async function readPixels(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    let cv;
    if (typeof OffscreenCanvas !== "undefined") cv = new OffscreenCanvas(bmp.width, bmp.height);
    else { cv = document.createElement("canvas"); cv.width = bmp.width; cv.height = bmp.height; }
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, px: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
  }

  // Remuestreo bilineal que respeta los huecos (NaN)
  function resample(src, sw, sh, tw, th) {
    if (sw === tw && sh === th) return src;
    const out = new Float32Array(tw * th);
    for (let y = 0; y < th; y++) {
      const sy = ((y + 0.5) * sh) / th - 0.5;
      const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(sh - 1, y0 + 1), fy = Math.min(1, Math.max(0, sy - y0));
      for (let x = 0; x < tw; x++) {
        const sx = ((x + 0.5) * sw) / tw - 0.5;
        const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(sw - 1, x0 + 1), fx = Math.min(1, Math.max(0, sx - x0));
        let acc = 0, ws = 0;
        const add = (v, w) => { if (Number.isFinite(v) && w > 0) { acc += v * w; ws += w; } };
        add(src[y0 * sw + x0], (1 - fx) * (1 - fy));
        add(src[y0 * sw + x1], fx * (1 - fy));
        add(src[y1 * sw + x0], (1 - fx) * fy);
        add(src[y1 * sw + x1], fx * fy);
        out[y * tw + x] = ws >= 0.3 ? acc / ws : NaN;
      }
    }
    return out;
  }

  // Desenfoque gaussiano separable que no mezcla huecos con datos
  function blur(src, w, h, sigma) {
    if (!(sigma > 0)) return src;
    const rad = Math.ceil(sigma * 3);
    const k = [];
    let ks = 0;
    for (let i = -rad; i <= rad; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); ks += v; }
    for (let i = 0; i < k.length; i++) k[i] /= ks;
    const n = w * h;
    const val = new Float32Array(n), msk = new Float32Array(n);
    for (let i = 0; i < n; i++) { const ok = Number.isFinite(src[i]); val[i] = ok ? src[i] : 0; msk[i] = ok ? 1 : 0; }
    const tv = new Float32Array(n), tm = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let a = 0, b = 0;
        for (let j = -rad; j <= rad; j++) {
          const xx = Math.min(w - 1, Math.max(0, x + j));
          const kk = k[j + rad];
          a += val[y * w + xx] * kk; b += msk[y * w + xx] * kk;
        }
        tv[y * w + x] = a; tm[y * w + x] = b;
      }
    }
    const out = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let a = 0, b = 0;
        for (let j = -rad; j <= rad; j++) {
          const yy = Math.min(h - 1, Math.max(0, y + j));
          const kk = k[j + rad];
          a += tv[yy * w + x] * kk; b += tm[yy * w + x] * kk;
        }
        const i = y * w + x;
        out[i] = b > 0.32 && msk[i] + b > 0.55 ? a / b : NaN;
      }
    }
    return out;
  }

  // Isobandas → GeoJSON en coordenadas geográficas
  function polygons(grid, w, h, bbox, p) {
    const [x0, y0, x1, y1] = bbox;
    const vals = new Float64Array(w * h);
    const lo = p.levels[0];
    for (let i = 0; i < vals.length; i++) {
      const v = grid[i];
      vals[i] = Number.isFinite(v) ? (p.clamp ? Math.max(v, lo) : v) : -1e9;
    }
    const gen = d3.contours().size([w, h]).smooth(true).thresholds(p.levels);
    const project = ([x, y]) => {
      const ll = unmerc(x0 + (x / w) * (x1 - x0), y1 - (y / h) * (y1 - y0));
      return [ll[1], ll[0]];
    };
    const features = [];
    gen(vals).forEach((g, i) => {
      if (!g.coordinates.length) return;
      features.push({
        type: "Feature",
        properties: { c: p.colors[i], i },
        geometry: { type: "MultiPolygon", coordinates: g.coordinates.map((poly) => poly.map((ring) => ring.map(project))) },
      });
    });
    return { type: "FeatureCollection", features };
  }

  function sampleGrid(f, lat, lng) {
    if (!f || !f.grid) return NaN;
    const [X, Y] = merc(lat, lng);
    const [x0, y0, x1, y1] = f.bbox;
    const px = Math.floor(((X - x0) / (x1 - x0)) * f.w);
    const py = Math.floor(((y1 - Y) / (y1 - y0)) * f.h);
    if (px < 0 || py < 0 || px >= f.w || py >= f.h) return NaN;
    return f.grid[py * f.w + px];
  }

  // Paletas de color de GIBS (rgb → valor)
  const paletteCache = new Map();
  async function gibsLookup(id) {
    if (paletteCache.has(id)) return paletteCache.get(id);
    const prom = fetch(`/api/gibs/paleta?capa=${encodeURIComponent(id)}`).then((r) => {
      if (!r.ok) throw new Error("paleta");
      return r.json();
    }).then((data) => {
      const map = new Map();
      const list = [];
      const kelvin = /k/i.test(data.unidades) && !/km/i.test(data.unidades);
      data.entradas.forEach(([r, g, b, transp, lo, hi]) => {
        let v;
        if (transp) v = NaN;
        else if (lo == null && hi == null) v = NaN;
        else if (lo == null || lo <= -1e29) v = hi;
        else if (hi == null || hi >= 1e29) v = lo;
        else v = (lo + hi) / 2;
        map.set((r << 16) | (g << 8) | b, v);
        if (Number.isFinite(v)) list.push([r, g, b, v]);
      });
      // Color más cercano de la paleta (para mosaicos remuestreados, que mezclan colores vecinos)
      const near = new Map();
      const nearest = (r, g, b) => {
        const k = (r << 16) | (g << 8) | b;
        if (map.has(k)) return map.get(k);
        if (near.has(k)) return near.get(k);
        let best = NaN, bd = 30 * 30 * 3;
        for (const e of list) { const d = (e[0] - r) ** 2 + (e[1] - g) ** 2 + (e[2] - b) ** 2; if (d < bd) { bd = d; best = e[3]; } }
        near.set(k, best);
        return best;
      };
      return { map, kelvin, nearest };
    });
    paletteCache.set(id, prom);
    return prom;
  }

  // ---------- Tema y mapa ----------
  const root = document.documentElement;
  const savedTheme = store.get("celeste-tema");
  if (savedTheme === "light" || savedTheme === "dark") root.dataset.theme = savedTheme;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : media.matches);

  const map = L.map("map", {
    center: [9.85, -84.15],
    zoom: window.innerWidth < 820 ? 7 : 8,
    minZoom: 6,
    maxZoom: 16,
    zoomControl: false,
  });
  L.control.zoom({ position: "topright", zoomInTitle: "Acercar", zoomOutTitle: "Alejar" }).addTo(map);
  // Mi ubicación: pide permiso, centra el mapa, abre la ficha del lugar y avisa a los módulos (alertas)
  let userMarker = null;
  const locHooks = [];
  function locate(opts = {}) {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { if (!opts.silent) toast("Este navegador no permite conocer la ubicación."); resolve(null); return; }
      navigator.geolocation.getCurrentPosition((pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        try { localStorage.setItem("celeste-ubicacion", JSON.stringify({ lat, lng, t: Date.now() })); } catch (e) { /* sin almacenamiento */ }
        if (userMarker) map.removeLayer(userMarker);
        userMarker = L.marker([lat, lng], { icon: L.divIcon({ className: "", html: '<div class="yo"><span></span></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), keyboard: false, zIndexOffset: 1000, title: "Tu ubicación" }).addTo(map);
        userMarker.on("click", () => map.fire("click", { latlng: L.latLng(lat, lng) }));
        if (!opts.noPan) map.setView([lat, lng], Math.max(map.getZoom(), 10));
        locHooks.forEach((h) => { try { h(lat, lng, accuracy); } catch (e) { /* módulo con error */ } });
        if (opts.open) map.fire("click", { latlng: L.latLng(lat, lng) });
        resolve({ lat, lng, accuracy });
      }, (err) => {
        if (!opts.silent) toast(err.code === 1 ? "No diste permiso para usar tu ubicación. Puedes activarlo en el candado de la barra de direcciones." : "No se pudo obtener tu ubicación.");
        resolve(null);
      }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 5 * 60000 });
    });
  }
  const LocCtl = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const b = L.DomUtil.create("button", "loc-btn");
      b.type = "button";
      b.title = "Mi ubicación";
      b.setAttribute("aria-label", "Ver mi ubicación");
      b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7.5"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/></svg>';
      L.DomEvent.disableClickPropagation(b);
      L.DomEvent.on(b, "click", () => locate({ open: true }));
      return b;
    },
  });
  new LocCtl().addTo(map);
  map.attributionControl.setPrefix(false);
  map.createPane("clima").style.zIndex = 405;
  map.getPane("clima").classList.add("capa-datos");
  map.createPane("etiquetas").style.zIndex = 640;
  map.getPane("etiquetas").style.pointerEvents = "none";

  const ESRI = "Mapas: Esri, HERE, Garmin, &copy; colaboradores de <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a>";
  const ESRI_SAT = "Imágenes: Esri, Maxar, Earthstar Geographics";
  const ARC = (path) => `https://server.arcgisonline.com/ArcGIS/rest/services/${path}/MapServer/tile/{z}/{y}/{x}`;
  let baseKey = store.get("celeste-fondo") || "calles";
  let baseLayer = null, labelLayer = null;

  function setBase(key) {
    baseKey = key;
    store.set("celeste-fondo", key);
    if (baseLayer) map.removeLayer(baseLayer);
    if (labelLayer) map.removeLayer(labelLayer);
    const dark = isDark();
    if (key === "satelite") {
      baseLayer = L.tileLayer(ARC("World_Imagery"), { attribution: ESRI_SAT, maxZoom: 19 });
      labelLayer = L.tileLayer(ARC("Reference/World_Boundaries_and_Places"), { pane: "etiquetas", attribution: ESRI, maxZoom: 19 });
    } else if (key === "relieve") {
      baseLayer = L.tileLayer(ARC("Elevation/World_Hillshade"), { attribution: ESRI, maxZoom: 16, className: dark ? "relieve-oscuro" : "" });
      labelLayer = L.tileLayer(ARC(`Canvas/World_${dark ? "Dark" : "Light"}_Gray_Reference`), { pane: "etiquetas", attribution: ESRI, maxZoom: 16 });
    } else {
      baseLayer = L.tileLayer(ARC(`Canvas/World_${dark ? "Dark" : "Light"}_Gray_Base`), { attribution: ESRI, maxZoom: 16 });
      labelLayer = L.tileLayer(ARC(`Canvas/World_${dark ? "Dark" : "Light"}_Gray_Reference`), { pane: "etiquetas", attribution: ESRI, maxZoom: 16 });
    }
    baseLayer.addTo(map);
    labelLayer.addTo(map);
    document.querySelectorAll("#baseSeg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.base === key)));
  }
  $("#baseSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-base]");
    if (b) setBase(b.dataset.base);
  });
  $("#btnTheme").addEventListener("click", () => {
    root.dataset.theme = isDark() ? "light" : "dark";
    store.set("celeste-tema", root.dataset.theme);
    setBase(baseKey);
  });
  media.addEventListener("change", () => { if (!root.dataset.theme) setBase(baseKey); });

  // ---------- Definición de capas ----------
  const GIBS_ATTR = "<a href='https://earthdata.nasa.gov/gibs'>NASA GIBS</a>";
  const GIBS_WMTS = (id, level) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${id}/default/default/GoogleMapsCompatible_Level${level}/{z}/{y}/{x}.png`;

  // Área de las capas de datos: Costa Rica con mar alrededor
  const FIELD_AREA = [4.8, -90.5, 13.8, -78.5];

  // Iconos por tipo de capa (trazo, 24×24)
  const ICONS = {
    radar: '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M12 12 L18.5 5.5"/><path d="M7.8 16.2a6 6 0 1 1 8.5 0"/><path d="M4.9 19.1a10 10 0 1 1 14.2 0"/>',
    station: '<path d="M12 21V9"/><path d="M8 21h8"/><path d="M12 9l-5-2 5-2 5 2z"/><circle cx="7" cy="7" r="1.3"/><circle cx="17" cy="7" r="1.3"/><path d="M12 13h4l1.5 2"/>',
    surface: '<path d="M3 17c3-4 5 2 9-2s6 0 9-3"/><path d="M3 12c3-4 5 2 9-2s6 0 9-3"/><path d="M12 21v-3M8 21v-1.5M16 21v-2"/>',
    satellite: '<rect x="9" y="9" width="6" height="6" rx="1" transform="rotate(45 12 12)"/><path d="M5.5 5.5l3 3M15.5 15.5l3 3"/><rect x="2.5" y="2.5" width="4" height="4" transform="rotate(45 4.5 4.5)"/><rect x="17.5" y="17.5" width="4" height="4" transform="rotate(45 19.5 19.5)"/><path d="M17 4a4 4 0 0 1 3 3"/>',
    cloud: '<path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 11a3.5 3.5 0 0 0 1 7z"/>',
    drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
    wave: '<path d="M3 9c2.5-2 4.5-2 7 0s4.5 2 7 0 3-1 4-1"/><path d="M3 15c2.5-2 4.5-2 7 0s4.5 2 7 0 3-1 4-1"/>',
    thermo: '<path d="M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0z"/><path d="M12 9v7"/>',
    leaf: '<path d="M5 19c0-9 6-14 15-14 0 9-5 15-14 15"/><path d="M5 19l8-8"/>',
    dust: '<circle cx="6" cy="8" r="1.2"/><circle cx="12" cy="6" r="1.2"/><circle cx="18" cy="9" r="1.2"/><circle cx="9" cy="13" r="1.2"/><circle cx="15" cy="14" r="1.2"/><circle cx="7" cy="18" r="1.2"/><circle cx="17" cy="19" r="1.2"/>',
    flame: '<path d="M12 3c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2.5 1.5-4 2.5-5 .3 2 1.2 3 2 3 0-3-1-5.5.5-8z"/>',
    region: '<path d="M4 6l5-2 6 2 5-2v14l-5 2-6-2-5 2z"/><path d="M9 4v14M15 6v14" stroke-dasharray="2 2"/>',
  };
  const icon = (k) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[k] || ""}</svg>`;
  // Fuentes: sigla, país y color de la ficha
  const SOURCES = {
    cocesna: { name: "COCESNA", cc: "NI", cls: "src-ni", title: "Radar de COCESNA en Nicaragua" },
    imn: { name: "IMN", cc: "CR", cls: "src-cr", title: "Instituto Meteorológico Nacional de Costa Rica" },
    imhpa: { name: "IMHPA", cc: "PA", cls: "src-pa", title: "Instituto de Meteorología e Hidrología de Panamá" },
    nasa: { name: "NASA", cc: "", cls: "src-nasa", title: "NASA GIBS" },
    noaa: { name: "NOAA", cc: "", cls: "src-nasa", title: "NOAA GOES-Este vía NASA GIBS" },
    snit: { name: "SNIT", cc: "CR", cls: "src-cr", title: "Sistema Nacional de Información Territorial (nodo IMN)" },
  };
  const chip = (k) => { const s = SOURCES[k]; return s ? `<span class="src ${s.cls}" title="${s.title}">${s.name}${s.cc ? `<i>${s.cc}</i>` : ""}</span>` : ""; };

  // Lluvia estimada por la temperatura de los topes de nube (auto-estimador de Vicente et al., 1998):
  // nubes con topes por debajo de −32 °C se asocian a lluvia convectiva, más intensa cuanto más frías.
  const goesRain = (c) => {
    if (!Number.isFinite(c)) return 0;
    // Umbral conservador (−38 °C, con transición hasta −45 °C) para no confundir yunques de cirros con lluvia
    const k = c + 273.15;
    if (k >= 235) return 0;
    return Math.min(72, 1.1183e11 * Math.exp(-3.6382e-2 * Math.pow(k, 1.2))) * Math.min(1, (235 - k) / 7);
  };
  const CR_AREA = [7.4, -86.8, 11.8, -81.8];

  // Jerarquía: categoría (tipo de dato) → capa oficial (dato crudo, con su fuente) → capas derivadas.
  // idx: la capa entra en el índice CELESTE. time: la capa tiene fila en la línea de tiempo.
  const GROUPS = [
    {
      title: "Radares",
      icon: "radar",
      layers: [
        { key: "radar", tech: "Reflectividad CAPPI a 1 km (dBZ) del radar de COCESNA en Managua, cada 10 min. Se convierte a lluvia con Marshall-Palmer (Z = 200·R^1,6; sin eco bajo 7 dBZ), rejilla de ~1 km, suavizado gaussiano (σ ≈ 1,3 km) e isobandas. Alcance útil ~430 km. En el índice se ajusta con las estaciones (sesgo medio de 3 h).", type: "radar", icon: "radar", src: "cocesna", idx: true, time: true, name: "Radar regional", desc: "Lluvia del radar de COCESNA cada 10 minutos. Cubre el norte y el centro del país.", on: true, opacity: 0.8, pal: "rain" },
        { key: "radarimn", tech: "Imagen pública del radar del IMN (Aranjuez). Se decodifica su escala de colores a dBZ, se georreferencia con proyección azimutal (4,14 px/km), se enmascaran textos y líneas, se filtran píxeles aislados y se aplica la misma Z-R que COCESNA. Entra al índice solo si la imagen tiene menos de 30 min.", type: "ext", icon: "radar", src: "imn", idx: "pausa", pane: "radarimn", name: "Radar del Valle Central", desc: "Radar del IMN en Aranjuez. Misma unidad, escala y suavizado que el de COCESNA.", opacity: 0.8 },
      ],
    },
    {
      title: "Estaciones",
      icon: "station",
      layers: [
        {
          key: "redimn", tech: "153 estaciones automáticas del IMN: tablas horarias de lluvia, temperatura, viento, presión y radiación (datos preliminares, sin control de calidad). Área de influencia: polígonos de Thiessen limitados a 25 km. 46 ubicaciones son aproximadas (por nombre y cantón), porque el IMN no publica coordenadas.", type: "ext", icon: "station", src: "imn", idx: true, time: true, pane: "redimn", name: "Estaciones automáticas", desc: "Las 153 estaciones: ubicación, área de influencia y todo lo que reportan cada hora.", opacity: 1,
          children: [
            { key: "estaciones", tech: "Superficie derivada: interpolación gaussiana (núcleo 10 km, alcance 28 km) de la lluvia horaria del IMN y del IMHPA, de −6 h a la última hora medida. Pronóstico a +6 h: modelo Open-Meteo × sesgo local log(medido/modelo) de las últimas 3 h (núcleo 25 km), mezclado con persistencia en las primeras 2 h. La línea punteada marca dónde hay estaciones cerca.", type: "ext", icon: "surface", from: ["imn", "imhpa"], idx: true, time: true, pane: "estaciones", name: "Lluvia hora a hora ±6 h", desc: "Lo medido en las estaciones, interpolado a una superficie continua, y su pronóstico corregido.", opacity: 0.85 },
          ],
        },
        { key: "redpa", tech: "Estaciones satelitales del IMHPA (occidente de Panamá y franja fronteriza). Lluvia cada 15 min agregada a horas (se corrige la hora local UTC−5); además temperatura, humedad, viento, ráfaga, presión, radiación y niveles de ríos y embalses. Uso con cita de la fuente (Ley 209 de 2021).", type: "ext", icon: "station", src: "imhpa", idx: true, time: true, pane: "redpa", name: "Estaciones de Panamá y la frontera sur", desc: "Occidente de Panamá: lluvia por hora, temperatura, humedad, viento, presión y niveles de ríos. Informan la zona sur de Costa Rica.", opacity: 1 },
      ],
    },
    {
      title: "Satélite",
      icon: "satellite",
      layers: [
        {
          key: "ir", tech: "GOES-Este ABI banda 13 (10,3 µm): temperatura de brillo de los topes de nube, cada 10 min con ~20 min de retraso, vía NASA GIBS.", short: "GOES IR", type: "tiles", icon: "cloud", src: "noaa", time: true, tStep: 10, window: 6.5, id: "GOES-East_ABI_Band13_Clean_Infrared", level: 6, name: "Nubes por temperatura (GOES-Este)", desc: "Infrarrojo cada 10 minutos. Los topes más fríos son las tormentas más altas.", opacity: 0.7,
          children: [
            { key: "goesrain", tech: "Capa derivada con el auto-estimador de Vicente et al. (1998): R = 1,1183·10¹¹·exp(−3,6382·10⁻²·T^1,2), con T en kelvin; solo topes por debajo de −38 °C (transición hasta −45 °C), tope de 72 mm/h. Sobreestima bajo yunques de cirros: en el índice se ajusta con las estaciones.", type: "field", icon: "drop", from: ["noaa"], idx: true, time: true, tStep: 10, window: 6.5, id: "GOES-East_ABI_Band13_Clean_Infrared", tileLevel: 6, level: 6, conv: goesRain, area: CR_AREA, short: "GOES lluvia", name: "Lluvia estimada por nubes frías", desc: "Se deriva de la temperatura de los topes: más fríos, lluvia más intensa. Cubre todo el país; es la estimación más gruesa.", opacity: 0.75, pal: "rain", srcWidth: 330, sigma: 2.4 },
          ],
        },
        { key: "imerg30", tech: "NASA GPM IMERG (corrida temprana), 0,1° cada 30 min con ~5 h de retraso. Combina sensores de microondas pasivas e infrarrojo calibrados.", short: "IMERG", type: "field", icon: "drop", src: "nasa", idx: true, time: true, tStep: 30, window: 12, id: "IMERG_Precipitation_Rate_30min", name: "Lluvia estimada IMERG", desc: "NASA, cada 30 minutos con unas 5 horas de retraso. Cubre todo el país y el mar.", opacity: 0.75, pal: "rain", srcWidth: 124, sigma: 6 },
        { key: "geocolor", tech: "GOES-Este GeoColor (CIRA/NOAA): color real de día; de noche, infrarrojo y luces urbanas. Cada 10 min.", short: "GOES color", type: "tiles", icon: "satellite", src: "noaa", time: true, tStep: 10, window: 6.5, id: "GOES-East_ABI_GeoColor", level: 7, name: "Satélite en color real", desc: "GOES-Este cada 10 minutos. De noche muestra luces y nubes bajas.", opacity: 0.9 },
        { key: "imergday", tech: "NASA IMERG, tasa media del día anterior multiplicada por 24 h.", type: "field", icon: "drop", src: "nasa", id: "IMERG_Precipitation_Rate", name: "Lluvia del último día", desc: "IMERG, total del día anterior.", opacity: 0.75, pal: "rainDay", srcWidth: 124, sigma: 6, scale: 24 },
        { key: "dust", tech: "GOES-Este Dust RGB: combinación de diferencias entre bandas de 12,3, 11,2 y 10,3 µm; el polvo aparece rosado.", short: "Polvo", type: "tiles", icon: "dust", src: "noaa", time: true, tStep: 10, window: 6.5, id: "GOES-East_ABI_Dust", level: 7, name: "Polvo del Sahara", desc: "GOES-Este. El polvo aparece en tonos rosados.", opacity: 0.75 },
      ],
    },
    {
      title: "Mar y tierra",
      more: true,
      layers: [
        { key: "sst", tech: "GHRSST MUR L4 (JPL), 0,01°, análisis diario.", type: "field", icon: "wave", src: "nasa", id: "GHRSST_L4_MUR_Sea_Surface_Temperature", name: "Temperatura del mar", desc: "GHRSST, diaria.", opacity: 0.8, pal: "sst", srcWidth: 860, sigma: 1.6 },
        { key: "ssta", tech: "Anomalía de GHRSST MUR respecto a su climatología; sirve para seguir El Niño y La Niña.", type: "field", icon: "wave", src: "nasa", id: "GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies", name: "Mar más caliente o más frío de lo normal", desc: "Anomalía diaria. Sirve para seguir El Niño y La Niña.", opacity: 0.8, pal: "ssta", srcWidth: 860, sigma: 1.6 },
        { key: "lst", tech: "MODIS Terra, temperatura de la superficie de día, compuesto de 8 días a 1 km.", type: "field", icon: "thermo", src: "nasa", id: "MODIS_Terra_L3_Land_Surface_Temp_8Day_Day", name: "Temperatura del suelo de día", desc: "MODIS, promedio de 8 días. Muestra islas de calor.", opacity: 0.75, pal: "lst", srcWidth: 860, sigma: 1.4 },
        { key: "ndvi", tech: "VIIRS SNPP, índice de vegetación (NDVI) de 16 días a 500 m.", type: "field", icon: "leaf", src: "nasa", id: "VIIRS_SNPP_L3_NDVI_16Day", name: "Verdor de la vegetación", desc: "VIIRS, 16 días. Bajo en zonas secas o deforestadas.", opacity: 0.75, pal: "ndvi", srcWidth: 860, sigma: 1.4 },
        { key: "aod", tech: "MODIS MAIAC, espesor óptico de aerosoles a 550 nm, diario.", type: "field", icon: "dust", src: "nasa", id: "MODIS_Combined_MAIAC_L2G_AerosolOpticalDepth", name: "Partículas en el aire", desc: "MODIS, diaria. Humo, polvo y contaminación.", opacity: 0.75, pal: "aod", srcWidth: 680, sigma: 2 },
        { key: "fires", tech: "VIIRS NOAA-20, anomalías térmicas de 375 m detectadas el día anterior.", type: "fires", icon: "flame", src: "nasa", name: "Focos de incendio", desc: "VIIRS, focos detectados ayer.", opacity: 1 },
      ],
    },
    {
      title: "Referencia",
      more: true,
      layers: [
        { key: "regiones", tech: "Capa reg_climaticas_imn del nodo IMN del SNIT (servicio WFS del SINIA), simplificada.", type: "ext", icon: "region", src: "snit", name: "Regiones climáticas del IMN", desc: "Las siete regiones oficiales en que el IMN agrupa sus estaciones.", opacity: 1, noOpacity: true },
      ],
    },
  ];

  const ALL = GROUPS.flatMap((g) => g.layers.flatMap((l) => [l, ...(l.children || [])]));
  ALL.forEach((d) => { (d.children || []).forEach((c) => (c.parent = d)); });
  // Capa interna (no se muestra): temperatura de topes de GOES en °C, para lluvia y nubosidad del índice
  ALL.push({ key: "goestemp", type: "hidden", id: "GOES-East_ABI_Band13_Clean_Infrared", tileLevel: 6, level: 6, area: CR_AREA, pal: "lst", srcWidth: 330 });
  let zBase = 410;
  ALL.forEach((def) => {
    if (def.type === "field" || def.type === "radar") {
      def.pane = `campo-${def.key}`;
      map.createPane(def.pane).style.zIndex = def.type === "radar" ? 430 : zBase++;
      map.getPane(def.pane).style.opacity = def.opacity;
      map.getPane(def.pane).classList.add("capa-datos");
      def.renderer = L.canvas({ pane: def.pane, padding: 0.4 });
    }
  });

  function polyLayer(def, geo) {
    return L.geoJSON(geo, {
      pane: def.pane,
      renderer: def.renderer,
      interactive: false,
      smoothFactor: 0.4,
      style: (f) => ({ fillColor: f.properties.c, fillOpacity: 1, color: f.properties.c, weight: 0.8, opacity: 1 }),
    });
  }

  // ---------- Capas de datos de GIBS ----------
  const fields = new Map(); // key -> {grid,w,h,bbox,layer,def,time}
  const TL = () => window.CelesteTime;
  const isoMin = (t) => new Date(t).toISOString().slice(0, 19) + "Z";
  const setOff = (el, off) => { if (el) el.classList.toggle("td-fuera", !!off); };

  // Imagen de GIBS decodificada a valores (por capa, hora y área), con caché
  const decoded = new Map();
  // Mosaicos WMTS de GIBS (para capas que el WMS no sirve, como GOES): se arma la imagen con las teselas
  const R_EARTH = 20037508.342789;
  async function tileBitmap(url) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(url);
        if (r.ok && (r.headers.get("content-type") || "").startsWith("image/")) return await createImageBitmap(await r.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      } catch (e) { /* reintento */ }
      await new Promise((res) => setTimeout(res, 400 * (i + 1)));
    }
    return null;
  }
  async function wmtsDecoded(def, time) {
    const z = def.tileLevel, n = 2 ** z;
    const [s, w, nn, e] = def.area || FIELD_AREA;
    const tyOf = (lat) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
    const tx0 = Math.floor(((w + 180) / 360) * n), tx1 = Math.floor(((e + 180) / 360) * n);
    const ty0 = tyOf(nn), ty1 = tyOf(s);
    const Wp = (tx1 - tx0 + 1) * 256, Hp = (ty1 - ty0 + 1) * 256;
    const cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(Wp, Hp) : Object.assign(document.createElement("canvas"), { width: Wp, height: Hp });
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    const jobs = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const url = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${def.id}/default/${time || "default"}/GoogleMapsCompatible_Level${def.level}/${z}/${ty}/${tx}.png`;
      jobs.push(tileBitmap(url).then((bmp) => { if (bmp) ctx.drawImage(bmp, (tx - tx0) * 256, (ty - ty0) * 256); return !!bmp; }));
    }
    const ok = await Promise.all(jobs);
    if (!ok.some(Boolean)) throw new Error("sin teselas");
    const lk = await gibsLookup(def.id);
    const px = ctx.getImageData(0, 0, Wp, Hp).data;
    const raw = new Float32Array(Wp * Hp);
    let found = 0;
    for (let i = 0, j = 0; i < raw.length; i++, j += 4) {
      let v = px[j + 3] > 0 ? lk.nearest(px[j], px[j + 1], px[j + 2]) : NaN;
      if (Number.isFinite(v)) { found++; if (def.conv) v = def.conv(v); } else if (def.pal.startsWith("rain")) v = 0;
      raw[i] = v;
    }
    const bbox = [(tx0 / n) * 2 * R_EARTH - R_EARTH, R_EARTH - ((ty1 + 1) / n) * 2 * R_EARTH, ((tx1 + 1) / n) * 2 * R_EARTH - R_EARTH, R_EARTH - (ty0 / n) * 2 * R_EARTH];
    return { raw, w: Wp, h: Hp, bbox, found };
  }

  function gibsDecoded(def, time) {
    if (def.tileLevel) {
      const key = `wmts|${def.key}|${time || ""}`;
      if (!decoded.has(key)) {
        const prom = wmtsDecoded(def, time);
        prom.catch(() => decoded.delete(key));
        decoded.set(key, prom);
        if (decoded.size > 60) decoded.delete(decoded.keys().next().value);
      }
      return decoded.get(key);
    }
    const [s, w, n, e] = def.area || FIELD_AREA;
    const src = extent(s, w, n, e, def.srcWidth);
    const key = `${def.id}|${def.key}|${time || ""}`;
    if (decoded.has(key)) return decoded.get(key);
    const url = `/api/gibs/mapa?capa=${def.id}&bbox=${src.bbox.map((v) => v.toFixed(1)).join(",")}&ancho=${src.w}&alto=${src.h}${time ? `&hora=${time}` : ""}`;
    const prom = Promise.all([gibsLookup(def.id), readPixels(url)]).then(([lk, img]) => {
      const isRain = def.pal.startsWith("rain");
      const raw = new Float32Array(img.w * img.h);
      let found = 0;
      for (let i = 0, j = 0; i < raw.length; i++, j += 4) {
        let v = NaN;
        if (img.px[j + 3] > 0) {
          const k = (img.px[j] << 16) | (img.px[j + 1] << 8) | img.px[j + 2];
          if (lk.map.has(k)) { v = lk.map.get(k); found++; }
        }
        if (Number.isFinite(v)) {
          if (lk.kelvin && v > 150) v -= 273.15;
          if (def.conv) v = def.conv(v);
          if (def.scale) v *= def.scale;
        } else if (isRain) v = 0;
        raw[i] = v;
      }
      return { raw, w: img.w, h: img.h, bbox: src.bbox, found };
    });
    prom.catch(() => decoded.delete(key));
    decoded.set(key, prom);
    if (decoded.size > 60) decoded.delete(decoded.keys().next().value);
    return prom;
  }

  // Remuestreo a otra rejilla (otra área), bilineal y tolerante a vacíos
  function regrid(d, tgt) {
    const out = new Float32Array(tgt.w * tgt.h);
    const [x0, y0, x1, y1] = tgt.bbox, [sx0, sy0, sx1, sy1] = d.bbox;
    for (let j = 0; j < tgt.h; j++) {
      const Y = y1 - ((j + 0.5) / tgt.h) * (y1 - y0);
      const fy = ((sy1 - Y) / (sy1 - sy0)) * d.h - 0.5;
      for (let i = 0; i < tgt.w; i++) {
        const X = x0 + ((i + 0.5) / tgt.w) * (x1 - x0);
        const fx = ((X - sx0) / (sx1 - sx0)) * d.w - 0.5;
        const ix = Math.floor(fx), iy = Math.floor(fy), ux = fx - ix, uy = fy - iy;
        let s = 0, ws = 0;
        for (const [dx, dy, wt] of [[0, 0, (1 - ux) * (1 - uy)], [1, 0, ux * (1 - uy)], [0, 1, (1 - ux) * uy], [1, 1, ux * uy]]) {
          const xx = Math.min(d.w - 1, Math.max(0, ix + dx)), yy = Math.min(d.h - 1, Math.max(0, iy + dy));
          const v = d.raw[yy * d.w + xx];
          if (Number.isFinite(v)) { s += v * wt; ws += wt; }
        }
        out[j * tgt.w + i] = ws > 0.2 ? s / ws : NaN;
      }
    }
    return out;
  }
  // Rejilla de una capa de GIBS sobre cualquier área (la usa el índice)
  async function gibsGrid(key, time, tgt, sigmaKm) {
    const def = ALL.find((d) => d.key === key);
    const d = await gibsDecoded(def, time);
    const g = regrid(d, tgt);
    const kmPx = ((tgt.bbox[2] - tgt.bbox[0]) / tgt.w / 1000) * Math.cos(9.8 * Math.PI / 180);
    return { grid: blur(g, tgt.w, tgt.h, (sigmaKm || 3) / kmPx), found: d.found };
  }
  async function gibsTimes(def) {
    const r = await fetch(`/api/gibs/tiempos?capa=${encodeURIComponent(def.id)}`);
    if (!r.ok) throw new Error("tiempos");
    const j = await r.json();
    const from = Date.now() - (def.window || 6) * 3600000;
    return (j.tiempos || []).map(Date.parse).filter((t) => t >= from);
  }

  const frameCache = new Map(); // key -> Map(time -> {grid, layer})
  async function loadField(def, box, time) {
    const stamp = $(".stamp", box);
    const [s, w, n, e] = def.area || FIELD_AREA;
    const tgt = extent(s, w, n, e, 620);
    const want = time || "";
    def._want = want;
    let fc = frameCache.get(def.key);
    if (!fc) { fc = new Map(); frameCache.set(def.key, fc); }
    try {
      let fr = fc.get(want);
      if (!fr) {
        if (!fc.size) stamp.textContent = "Procesando la capa…";
        const d = await gibsDecoded(def, time);
        const up = def.tileLevel ? regrid(d, tgt) : resample(d.raw, d.w, d.h, tgt.w, tgt.h);
        const grid = blur(up, tgt.w, tgt.h, def.sigma * (tgt.w / 620));
        fr = { grid, layer: polyLayer(def, polygons(grid, tgt.w, tgt.h, tgt.bbox, PAL[def.pal])), found: d.found };
        fc.set(want, fr);
        if (fc.size > 30) { const k0 = fc.keys().next().value; const o = fc.get(k0); if (o.layer && map.hasLayer(o.layer)) map.removeLayer(o.layer); fc.delete(k0); }
      }
      if (!def._on || def._want !== want) return;
      const old = fields.get(def.key);
      if (old?.layer && old.layer !== fr.layer) map.removeLayer(old.layer);
      if (!map.hasLayer(fr.layer)) fr.layer.addTo(map);
      fields.set(def.key, { grid: fr.grid, w: tgt.w, h: tgt.h, bbox: tgt.bbox, layer: fr.layer, def, time });
      stamp.textContent = !fr.found ? "No hay datos sobre Costa Rica en esta imagen." : time ? `Imagen de las ${fmtHour.format(new Date(time))} (${ago(new Date(time))}). Usa la línea de tiempo para ver las anteriores.` : "Imagen más reciente disponible.";
    } catch (err) {
      if (def._want === want) stamp.textContent = "No se pudo cargar esta imagen. Vuelve a intentarlo en unos minutos.";
    }
  }

  // Capas con tiempo (campos o mosaicos): se registran en la línea de tiempo
  const tileFrames = new Map(); // key -> Map(iso -> tileLayer)
  async function enableTimed(def, box) {
    let times = [];
    try { times = await gibsTimes(def); } catch (e) { times = []; }
    if (!def._on) return;
    if (!times.length) { // sin lista de horas: la imagen más reciente
      if (def.type === "field") loadField(def, box);
      else showTile(def, null, false);
      return;
    }
    const lbl = def.name.replace(/\s*\(.*\)$/, "");
    TL().register(def.key, {
      label: def.name, short: def.short || lbl, icon: icon(def.icon), times, tol: Math.max(def.tStep * 0.6, def.tStep <= 10 ? 16 : 0) * 60000, step: def.tStep * 60000, order: def.order || ORDER[def.key] || 50,
      show: (t, off) => {
        if (def.type === "field") { loadField(def, box, isoMin(t)); setOff(map.getPane(def.pane), off); }
        else showTile(def, isoMin(t), off);
      },
    });
  }
  function showTile(def, iso, off) {
    let fm = tileFrames.get(def.key);
    if (!fm) { fm = new Map(); tileFrames.set(def.key, fm); }
    const k = iso || "latest";
    let layer = fm.get(k);
    if (!layer) {
      layer = makeTiles(def, iso);
      layer.on("tileerror", () => { if (!def._warned) { def._warned = true; toast(`Algunas partes de "${def.name}" no cargaron. Puede que aún no haya imagen.`); } });
      fm.set(k, layer);
      if (fm.size > 8) { const k0 = fm.keys().next().value; map.removeLayer(fm.get(k0)); fm.delete(k0); }
    }
    if (!map.hasLayer(layer)) layer.addTo(map);
    fm.forEach((l, kk) => l.setOpacity(kk === k ? def.opacity : 0));
    tiles.set(def.key, layer);
    setOff(layer.getContainer(), off);
  }
  const ORDER = { radar: 1, redimn: 2, estaciones: 3, redpa: 4, ir: 5, goesrain: 6, imerg30: 7, geocolor: 8, dust: 9 };

  function makeTiles(def, iso) {
    if (def.type === "tiles") {
      const url = iso ? `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${def.id}/default/${iso}/GoogleMapsCompatible_Level${def.level}/{z}/{y}/{x}.png` : GIBS_WMTS(def.id, def.level);
      return L.tileLayer(url, {
        pane: "clima", maxNativeZoom: def.level, maxZoom: 16, opacity: def.opacity, attribution: GIBS_ATTR,
        className: "imagen-suave", errorTileUrl: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
      });
    }
    if (def.type === "fires") {
      return L.tileLayer.wms("https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi", {
        pane: "clima", layers: "VIIRS_NOAA20_Thermal_Anomalies_375m_All", format: "image/png", transparent: true,
        version: "1.3.0", TIME: yesterdayUTC(), attribution: GIBS_ATTR, opacity: def.opacity,
      });
    }
    return null;
  }

  const tiles = new Map();

  const IDX_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/></svg>';
  function layerBox(def, sub) {
    const box = document.createElement("div");
    box.className = `layer${sub ? " sub" : ""}`;
    box.dataset.key = def.key;
    const id = `chk-${def.key}`;
    const legend = def.pal ? legendHTML(PAL[def.pal]) : "";
    const tags = [
      sub ? `<span class="tag tag-der" title="Mapa calculado a partir de ${def.from.map((f) => SOURCES[f].name).join(" y ")}">Derivado · ${def.from.map((f) => SOURCES[f].name).join(" + ")}</span>` : chip(def.src),
      def.idx ? `<span class="tag tag-idx${def.idx === "pausa" ? " pausa" : ""}" title="${def.idx === "pausa" ? "Entra en el índice cuando su imagen esté al día" : "Entra en el índice CELESTE"}">${IDX_ICON}Índice</span>` : "",
      def.time ? '<span class="tag tag-time" title="Tiene línea de tiempo"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></svg></span>' : "",
    ].join("");
    box.innerHTML = `
      <label class="layer-row" for="${id}">
        <input type="checkbox" id="${id}">
        <span class="layer-ico" aria-hidden="true">${icon(def.icon)}</span>
        <span class="layer-txt"><span class="layer-name">${def.name}</span><span class="layer-tags">${tags}</span></span>
        <button type="button" class="info-btn" aria-expanded="false" aria-label="Qué es esta capa" title="Qué es esta capa">i</button>
      </label>
      <div class="layer-info" hidden><p>${def.desc}</p>${def.tech ? `<p class="tech">${def.tech}</p>` : ""}</div>
      <div class="layer-extra">
        ${def.type === "radar" ? productButtons() : ""}
        ${legend}
        ${def.noOpacity ? "" : `<div class="opacity"><span>Opacidad</span><input type="range" min="0.2" max="1" step="0.05" value="${def.opacity}" aria-label="Opacidad de ${def.name}"></div>`}
        ${def.type === "radar" || def.type === "field" ? `<div class="stamp"${def.type === "radar" ? ' id="radarStamp"' : ""}></div>` : ""}
      </div>`;
    const chk = $("input[type=checkbox]", box);
    chk.addEventListener("change", () => toggle(def, chk.checked, box));
    const ib = $(".info-btn", box), info = $(".layer-info", box);
    ib.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); info.hidden = !info.hidden; ib.setAttribute("aria-expanded", String(!info.hidden)); });
    const op = $(".opacity input", box);
    if (op) op.addEventListener("input", (e) => {
      def.opacity = parseFloat(e.target.value);
      if (def.pane) map.getPane(def.pane).style.opacity = def.opacity;
      else { const fm = tileFrames.get(def.key); if (fm) { const cur = tiles.get(def.key); fm.forEach((l) => l.setOpacity(l === cur ? def.opacity : 0)); } else tiles.get(def.key)?.setOpacity(def.opacity); }
    });
    return box;
  }

  function renderPanel() {
    const wrap = $("#layerGroups");
    wrap.innerHTML = "";
    let more = null;
    GROUPS.forEach((g) => {
      const sec = document.createElement("section");
      sec.className = `group${g.more ? "" : " group-core"}`;
      sec.innerHTML = `<h2>${g.icon ? icon(g.icon) : ""}<span>${g.title}</span></h2>`;
      g.layers.forEach((def) => {
        const fam = document.createElement("div");
        fam.className = "family";
        fam.appendChild(layerBox(def, false));
        if (def.children) {
          const kids = document.createElement("div");
          kids.className = "children";
          def.children.forEach((c) => kids.appendChild(layerBox(c, true)));
          fam.appendChild(kids);
        }
        sec.appendChild(fam);
      });
      if (g.more) {
        if (!more) {
          more = document.createElement("details");
          more.className = "more-layers";
          more.innerHTML = `<summary><span>Más capas</span><span class="more-hint">Mar, tierra y referencia</span></summary>`;
          wrap.appendChild(more);
        }
        more.appendChild(sec);
      } else wrap.appendChild(sec);
    });
    ALL.filter((d) => d.on).forEach((d) => {
      const box = document.querySelector(`.layer[data-key="${d.key}"]`);
      $("input[type=checkbox]", box).checked = true;
      toggle(d, true, box);
    });
  }

  function productButtons() {
    return `<div class="product" role="group" aria-label="Producto de radar">
        <button type="button" data-prod="LNB_CAPPI_Z_450Km_1Km_cappi_dBZ" aria-pressed="true">Lluvia cerca del suelo</button>
        <button type="button" data-prod="LNB_CMAX_Z_450Km_0Km-18Km_cmax_dBZ" aria-pressed="false">Máximo en las nubes</button>
      </div>`;
  }

  function toggle(def, on, box) {
    box.classList.toggle("on", on);
    def._on = on;
    if (def.type === "radar") { on ? radar.enable() : radar.disable(); return; }
    if (def.type === "ext") { window.Celeste.ext?.[def.key]?.(on, box); return; }
    if (def.type === "field") {
      if (on) { if (def.time) enableTimed(def, box); else loadField(def, box); }
      else {
        TL().unregister(def.key);
        const f = fields.get(def.key); if (f?.layer) map.removeLayer(f.layer); fields.delete(def.key);
        const fc = frameCache.get(def.key); if (fc) fc.forEach((fr) => fr.layer && map.removeLayer(fr.layer));
        setOff(map.getPane(def.pane), false);
      }
      return;
    }
    if (on) {
      if (def.time) { enableTimed(def, box); return; }
      const layer = makeTiles(def);
      layer.on("tileerror", () => {
        if (!layer._warned) { layer._warned = true; toast(`Algunas partes de "${def.name}" no cargaron. Puede que aún no haya imagen reciente.`); }
      });
      layer.addTo(map);
      tiles.set(def.key, layer);
    } else {
      TL().unregister(def.key);
      const fm = tileFrames.get(def.key);
      if (fm) { fm.forEach((l) => map.removeLayer(l)); tileFrames.delete(def.key); }
      const l = tiles.get(def.key);
      if (l) map.removeLayer(l);
      tiles.delete(def.key);
    }
  }

  // ---------- Radar (polígonos animados) ----------
  const radarDef = ALL.find((d) => d.key === "radar");
  const radar = (() => {
    const area = extent(7.55, -86.5, 11.75, -82.25, 480); // ~1 km por píxel, la resolución del radar
    const bboxStr = area.bbox.map((n) => n.toFixed(1)).join(",");
    const FRAMES = 32; // 6 horas: cada 10 min las últimas 2 h y cada 30 min antes
    const p = PAL.rain;
    const RADAR_ATTR = "Radar: <a href='http://rainweb.cocesna.org:8080/rainweb/site'>COCESNA</a>";

    let product = "LNB_CAPPI_Z_450Km_1Km_cappi_dBZ";
    let enabled = false;
    let frames = []; // {time, geo, layer, grid, cover, loaded}
    let idx = -1;
    let refresh = null;
    let gen = 0;

    const setStamp = (t) => { const el = $("#radarStamp"); if (el) el.textContent = t; };

    // dBZ → mm/h (Marshall-Palmer, Z = 200 R^1.6)
    const toRain = (dbz) => (dbz < 7 ? 0 : Math.pow(Math.pow(10, dbz / 10) / 200, 0.625));

    async function build(f, myGen) {
      try {
        const q = new URLSearchParams({ capa: product, hora: f.time, bbox: bboxStr, ancho: area.w, alto: area.h });
        const img = await readPixels(`/api/radar/datos?${q}`);
        if (myGen !== gen) return;
        const raw = new Float32Array(img.w * img.h);
        let wet = 0;
        for (let i = 0, j = 0; i < raw.length; i++, j += 4) {
          const v = img.px[j + 3] > 128 ? toRain(((img.px[j] - 1) * 85) / 254) : 0;
          raw[i] = v;
          if (v >= p.levels[0]) wet++;
        }
        f.cover = wet / raw.length;
        f.grid = blur(raw, img.w, img.h, 1.3);
        f.layer = polyLayer(radarDef, polygons(f.grid, img.w, img.h, area.bbox, p));
        f.loaded = true;
        if (frames[idx] === f) f.layer.addTo(map);
      } catch (e) {
        f.loaded = true;
        f.cover = 0;
      }
      drawBars();
    }

    // Fila del radar en la línea de tiempo (altura = área con lluvia)
    function drawBars() {
      if (!enabled || !frames.length) return;
      const covers = frames.filter((f) => f.loaded).map((f) => f.cover || 0);
      const max = Math.max(0.002, ...covers);
      const byT = new Map(frames.map((f) => [Date.parse(f.time), f]));
      const def = {
        label: "Radar regional (COCESNA)", short: "Radar", icon: icon("radar"), order: 1,
        times: [...byT.keys()], tol: 6 * 60000, step: 10 * 60000,
        value: (t) => { const f = byT.get(t); return f && f.loaded ? (f.cover || 0) / max : 0.05; },
        show: (t, off) => { const i = frames.findIndex((f) => Date.parse(f.time) === t); if (i >= 0) show(i); setOff(map.getPane(radarDef.pane), off); },
      };
      if (!window.CelesteTime.has("radar")) window.CelesteTime.register("radar", def);
      else { window.CelesteTime.register("radar", def); }
    }

    function show(i) {
      if (!frames.length) return;
      i = Math.max(0, Math.min(frames.length - 1, i));
      const prev = frames[idx];
      idx = i;
      const cur = frames[idx];
      if (cur.layer && !map.hasLayer(cur.layer)) cur.layer.addTo(map);
      if (prev && prev !== cur && prev.layer) map.removeLayer(prev.layer);
    }

    function clearFrames() {
      frames.forEach((f) => { if (f.layer) map.removeLayer(f.layer); });
      frames = [];
      idx = -1;
    }

    async function load(keepPosition) {
      try {
        const r = await fetch("/api/radar/tiempos", { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const data = await r.json();
        const all = data.capas[product] || [];
        const lastT = all.length ? Date.parse(all[all.length - 1]) : 0;
        const times = all.filter((t) => { const age = lastT - Date.parse(t); return age <= 6 * 3600000 + 60000 && (age <= 2 * 3600000 + 60000 || Math.round(age / 60000) % 30 === 0); });
        if (!times.length) throw new Error("sin imágenes");
        if (!keepPosition) { gen++; clearFrames(); }
        const keep = new Set(times);
        frames = frames.filter((f) => { if (keep.has(f.time)) return true; if (f.layer) map.removeLayer(f.layer); return false; });
        if (idx >= frames.length) idx = frames.length - 1;
        const known = new Set(frames.map((f) => f.time));
        const fresh = [];
        times.forEach((t) => { if (!known.has(t)) { const f = { time: t, loaded: false, cover: 0 }; frames.push(f); fresh.push(f); } });
        frames.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
        while (frames.length > FRAMES) { const old = frames.shift(); if (old.layer) map.removeLayer(old.layer); if (idx > 0) idx--; }
        if (idx < 0) idx = frames.length - 1;
        drawBars();
        // La imagen más reciente primero, para que se vea de inmediato
        const myGen = gen;
        fresh.reverse().forEach((f) => build(f, myGen));
        const last = new Date(frames[frames.length - 1].time);
        setStamp(`Última imagen: ${fmtHour.format(last)} (${ago(last)}). Usa la línea de tiempo de abajo para ver las 3 horas anteriores.`);
      } catch (e) {
        setStamp("El radar de COCESNA no respondió. Vuelve a intentarlo en unos minutos.");
        if (!keepPosition) toast("No se pudo cargar el radar de COCESNA en este momento.");
      }
    }

    document.addEventListener("click", (e) => {
      const b = e.target.closest("[data-prod]");
      if (!b || b.dataset.prod === product) return;
      document.querySelectorAll("[data-prod]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      product = b.dataset.prod;
      if (enabled) load(false);
    });

    return {
      enable() {
        enabled = true;
        map.attributionControl.addAttribution(RADAR_ATTR);
        load(false);
        clearInterval(refresh);
        refresh = setInterval(() => load(true), 5 * 60 * 1000);
      },
      disable() {
        enabled = false;
        map.attributionControl.removeAttribution(RADAR_ATTR);
        gen++;
        clearInterval(refresh);
        clearFrames();
        window.CelesteTime.unregister("radar");
        setOff(map.getPane(radarDef.pane), false);
      },
      current() {
        const f = frames[idx];
        return f && f.grid ? { grid: f.grid, w: area.w, h: area.h, bbox: area.bbox, time: f.time } : null;
      },
    };
  })();

  // Radar como rejilla de lluvia (mm/h), para el índice CELESTE
  const RADAR_AREA = extent(7.55, -86.5, 11.75, -82.25, 480);
  async function radarRain(time, product = "LNB_CAPPI_Z_450Km_1Km_cappi_dBZ") {
    const q = new URLSearchParams({ capa: product, hora: time, bbox: RADAR_AREA.bbox.map((n) => n.toFixed(1)).join(","), ancho: RADAR_AREA.w, alto: RADAR_AREA.h });
    const img = await readPixels(`/api/radar/datos?${q}`);
    const grid = new Float32Array(img.w * img.h);
    for (let i = 0, j = 0; i < grid.length; i++, j += 4) {
      const dbz = ((img.px[j] - 1) * 85) / 254;
      grid[i] = img.px[j + 3] > 128 && dbz >= 7 ? Math.pow(Math.pow(10, dbz / 10) / 200, 0.625) : 0;
    }
    return { grid, w: img.w, h: img.h, bbox: RADAR_AREA.bbox };
  }

  // ---------- Panel del punto ----------
  const WMO = {
    0: "Despejado", 1: "Mayormente despejado", 2: "Parcialmente nublado", 3: "Nublado",
    45: "Niebla", 48: "Niebla", 51: "Llovizna débil", 53: "Llovizna", 55: "Llovizna intensa",
    56: "Llovizna helada", 57: "Llovizna helada", 61: "Lluvia débil", 63: "Lluvia moderada", 65: "Lluvia fuerte",
    66: "Lluvia helada", 67: "Lluvia helada", 71: "Nieve", 73: "Nieve", 75: "Nieve", 77: "Granizo fino",
    80: "Chubascos débiles", 81: "Chubascos", 82: "Chubascos fuertes", 85: "Nieve", 86: "Nieve",
    95: "Tormenta", 96: "Tormenta con granizo", 99: "Tormenta con granizo",
  };

  let pin = null;
  let pointReq = 0;
  let ptPlace = "", ptElev = "";
  let lastPoint = null, refreshTimer = null;
  const hooksHTML = (lat, lng) => `${(window.Celeste.pointHooks || []).map((h) => h(lat, lng)).join("")}${document.body.classList.contains("modo-indice") ? "" : layerValuesHTML(lat, lng)}`;
  // Vuelve a dibujar la parte de la ficha que depende del mapa (hora elegida, capas activas)
  function refreshPoint() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      const el = $("#ptHooks");
      if (!el || !lastPoint || $("#point").hidden) return;
      el.innerHTML = hooksHTML(lastPoint.lat, lastPoint.lng);
      wireTips(el);
    }, 120);
  }
  // Nombre del lugar (con caché por punto redondeado)
  const placeCache = new Map();
  function placeName(lat, lng) {
    const k = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    if (!placeCache.has(k)) placeCache.set(k, fetch(`/api/lugar?lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    return placeCache.get(k);
  }

  function openPoint() {
    $("#point").hidden = false;
    document.body.classList.add("point-open");
    $("#panel").classList.remove("open");
    $("#btnOpenPanel").setAttribute("aria-expanded", "false");
  }
  function closePoint() {
    $("#point").hidden = true;
    document.body.classList.remove("point-open");
    if (pin) { map.removeLayer(pin); pin = null; }
  }
  $("#btnClosePoint").addEventListener("click", closePoint);

  function coordText(lat, lng) {
    return `${fmtNum1.format(Math.abs(lat))}° ${lat >= 0 ? "N" : "S"}, ${fmtNum1.format(Math.abs(lng))}° ${lng >= 0 ? "E" : "O"}`;
  }

  // Valores de las capas activas en el punto tocado
  function layerValuesHTML(lat, lng) {
    const rows = [];
    if (radarDef._on) {
      const c = radar.current();
      const v = sampleGrid(c, lat, lng);
      if (c) {
        const txt = Number.isFinite(v) && v >= PAL.rain.levels[0] ? `${fmtNum1.format(v)} mm/h` : "Sin lluvia";
        rows.push(row(PAL.rain, v, "Radar", `${txt}, ${fmtHour.format(new Date(c.time))}`));
      }
    }
    fields.forEach((f) => {
      const p = PAL[f.def.pal];
      const v = sampleGrid(f, lat, lng);
      let txt;
      if (!Number.isFinite(v)) txt = "Sin datos aquí";
      else if (f.def.pal.startsWith("rain") && v < p.levels[0]) txt = "Sin lluvia";
      else txt = `${p.signed && v > 0 ? "+" : ""}${p.fmt.format(v)} ${p.units}`;
      rows.push(row(p, v, f.def.name, txt));
    });
    if (!rows.length) return "";
    return `<h3>Capas activas en este punto</h3><div class="values">${rows.join("")}</div>`;
    function row(p, v, name, txt) {
      const c = bandColor(p, p.clamp && Number.isFinite(v) ? Math.max(v, p.levels[0]) : v);
      return `<div class="value-row"><span class="swatch" style="background:${c || "transparent"}"></span><span class="value-name">${name}</span><b>${txt}</b></div>`;
    }
  }

  map.on("click", (e) => {
    const { lat, lng } = e.latlng;
    const req = ++pointReq;
    ptPlace = ""; ptElev = "";
    if (pin) map.removeLayer(pin);
    pin = L.marker([lat, lng], { icon: L.divIcon({ className: "", html: '<div class="pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), keyboard: false }).addTo(map);
    openPoint();
    $("#ptTitle").textContent = "Buscando el lugar…";
    $("#ptMeta").textContent = coordText(lat, lng);
    placeName(lat, lng).then((pl) => {
      if (req !== pointReq) return;
      $("#ptTitle").textContent = pl && pl.nombre ? pl.nombre : coordText(lat, lng);
      ptPlace = pl && pl.nombre ? [pl.detalle, coordText(lat, lng)].filter(Boolean).join(" · ") : coordText(lat, lng);
      $("#ptMeta").textContent = ptPlace + (ptElev ? ` · ${ptElev}` : "");
    });
    lastPoint = { lat, lng };
    $("#ptBody").innerHTML = `
      <div id="ptHooks">${hooksHTML(lat, lng)}</div>
      <h3>Ahora</h3><div id="ptNow" class="loading-line">Cargando el pronóstico…</div>
      <h3>Próximos 7 días</h3><div id="ptDays"></div>
      <h3>Clima de este punto, 2005–2024</h3><div id="ptClim" class="loading-line">Calculando 20 años de datos…</div>`;
    wireTips($("#ptBody"));

    const la = lat.toFixed(3), lo = lng.toFixed(3);
    const fUrl = `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max&timezone=${encodeURIComponent(TZ)}&forecast_days=7`;
    const cUrl = `https://archive-api.open-meteo.com/v1/archive?latitude=${la}&longitude=${lo}&start_date=2005-01-01&end_date=2024-12-31&daily=precipitation_sum,temperature_2m_max,temperature_2m_min&timezone=${encodeURIComponent(TZ)}`;

    fetch(fUrl).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((f) => {
      if (req === pointReq) renderForecast(f);
    }).catch(() => {
      if (req !== pointReq) return;
      $("#ptNow").innerHTML = '<p class="err">No se pudo cargar el pronóstico. Toca el punto otra vez para reintentar.</p>';
      $("#ptMeta").textContent = "";
    });
    fetch(cUrl).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((c) => {
      if (req === pointReq) renderClimate(c);
    }).catch(() => {
      if (req !== pointReq) return;
      $("#ptClim").innerHTML = '<p class="err">No se pudo cargar el clima histórico. Toca el punto otra vez para reintentar.</p>';
    });
  });

  function renderForecast(f) {
    const c = f.current;
    ptElev = `${fmtNum.format(f.elevation)} m s. n. m.`;
    $("#ptMeta").textContent = `${ptPlace || ""}${ptPlace ? " · " : ""}${ptElev}`;
    $("#ptNow").className = "";
    $("#ptNow").innerHTML = `
      <div class="now">
        <div class="now-temp">${fmtNum.format(c.temperature_2m)}°</div>
        <div><div class="now-desc">${WMO[c.weather_code] || "—"}</div><div class="muted" style="font-size:13px">Según el modelo, ${fmtHour.format(new Date())}</div></div>
      </div>
      <div class="now-grid">
        <div><b>${fmtNum1.format(c.precipitation)} mm</b><span>Lluvia última hora</span></div>
        <div><b>${fmtNum.format(c.relative_humidity_2m)} %</b><span>Humedad</span></div>
        <div><b>${fmtNum.format(c.wind_speed_10m)} km/h</b><span>Viento</span></div>
      </div>`;
    const d = f.daily;
    const rows = d.time.map((t, i) => {
      const date = new Date(`${t}T12:00:00-06:00`);
      const name = i === 0 ? "Hoy" : i === 1 ? "Mañana" : fmtDay.format(date);
      const prob = d.precipitation_probability_max?.[i];
      return `<tr>
        <td>${name}<br><span class="desc">${WMO[d.weather_code[i]] || ""}</span></td>
        <td class="rain">${fmtNum1.format(d.precipitation_sum[i])} mm${prob != null ? `<br><span class="desc">${prob} % prob.</span>` : ""}</td>
        <td>${fmtNum.format(d.temperature_2m_min[i])}° / <b>${fmtNum.format(d.temperature_2m_max[i])}°</b></td>
      </tr>`;
    }).join("");
    $("#ptDays").innerHTML = `<table class="days"><tbody>${rows}</tbody></table>
      <p class="source">Pronóstico: Open-Meteo (modelos globales). Para avisos oficiales consulta al IMN.</p>`;
  }

  function renderClimate(c) {
    const d = c.daily;
    const years = new Set();
    const rain = Array.from({ length: 12 }, () => 0);
    const tmax = Array.from({ length: 12 }, () => [0, 0]);
    const tmin = Array.from({ length: 12 }, () => [0, 0]);
    d.time.forEach((t, i) => {
      const m = parseInt(t.slice(5, 7), 10) - 1;
      years.add(t.slice(0, 4));
      if (d.precipitation_sum[i] != null) rain[m] += d.precipitation_sum[i];
      if (d.temperature_2m_max[i] != null) { tmax[m][0] += d.temperature_2m_max[i]; tmax[m][1]++; }
      if (d.temperature_2m_min[i] != null) { tmin[m][0] += d.temperature_2m_min[i]; tmin[m][1]++; }
    });
    const n = years.size || 1;
    const mRain = rain.map((v) => v / n);
    const mMax = tmax.map(([s, k]) => (k ? s / k : null));
    const mMin = tmin.map(([s, k]) => (k ? s / k : null));
    const total = mRain.reduce((a, b) => a + b, 0);
    const wet = mRain.indexOf(Math.max(...mRain));
    const dry = mRain.filter((v) => v < 60).length;

    $("#ptClim").className = "";
    $("#ptClim").innerHTML = `
      <div class="facts">
        <div><b>${fmtNum.format(total)} mm</b><span>Lluvia al año</span></div>
        <div><b>${MONTHS_LONG[wet]}</b><span>Mes más lluvioso</span></div>
        <div><b>${dry}</b><span>${dry === 1 ? "Mes seco" : "Meses secos"} (menos de 60 mm)</span></div>
      </div>
      <p class="chart-title">Lluvia promedio por mes (mm)</p>
      ${barChart(mRain)}
      <p class="chart-title">Temperatura mínima y máxima promedio (°C)</p>
      ${rangeChart(mMin, mMax)}
      <details class="table-view"><summary>Ver como tabla</summary>
        <table><thead><tr><th>Mes</th><th>Lluvia</th><th>Mín.</th><th>Máx.</th></tr></thead><tbody>
        ${MONTHS.map((m, i) => `<tr><td>${m}</td><td>${fmtNum.format(mRain[i])} mm</td><td>${fmtNum1.format(mMin[i])}°</td><td>${fmtNum1.format(mMax[i])}°</td></tr>`).join("")}
        </tbody></table></details>
      <p class="source">Datos: reanálisis ERA5 y ERA5-Land (Copernicus) vía Open-Meteo, celda de unos 10 km. En montaña puede diferir de una estación local.</p>`;
    wireTips($("#ptClim"));
  }

  // Gráficos en SVG (una serie cada uno, sin doble eje)
  const CW = 340, CH = 150, PL = 30, PR = 6, PT = 8, PB = 20;
  function niceMax(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v || 1)));
    return [1, 2, 2.5, 5, 10].find((k) => k * p >= v) * p;
  }
  function barChart(vals) {
    const max = niceMax(Math.max(...vals) * 1.05);
    const iw = CW - PL - PR, ih = CH - PT - PB, bw = iw / 12;
    const y = (v) => PT + ih - (v / max) * ih;
    let g = "";
    [0, 0.5, 1].forEach((k) => {
      const yy = y(max * k);
      g += `<line class="grid" x1="${PL}" x2="${CW - PR}" y1="${yy}" y2="${yy}"/><text x="${PL - 5}" y="${yy + 3.5}" text-anchor="end">${fmtNum.format(max * k)}</text>`;
    });
    vals.forEach((v, i) => {
      const x = PL + i * bw + 2, w = bw - 4, top = y(v), h = Math.max(0, PT + ih - top), r = Math.min(4, h, w / 2);
      const path = h > 0 ? `M${x},${PT + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${PT + ih} Z` : "";
      g += `<rect class="hit" x="${PL + i * bw}" y="${PT}" width="${bw}" height="${ih}" data-tip="${MONTHS_LONG[i]}: ${fmtNum.format(v)} mm"/>`;
      g += `<path class="bar" d="${path}"/>`;
      g += `<text x="${PL + i * bw + bw / 2}" y="${CH - 5}" text-anchor="middle">${MONTHS[i][0]}</text>`;
    });
    return `<svg class="chart" viewBox="0 0 ${CW} ${CH}" role="img" aria-label="Lluvia promedio por mes">${g}</svg>`;
  }
  function rangeChart(mins, maxs) {
    const lo = Math.floor(Math.min(...mins) - 1), hi = Math.ceil(Math.max(...maxs) + 1);
    const iw = CW - PL - PR, ih = CH - PT - PB, bw = iw / 12;
    const y = (v) => PT + ih - ((v - lo) / (hi - lo)) * ih;
    let g = "";
    [lo, Math.round((lo + hi) / 2), hi].forEach((t) => {
      g += `<line class="grid" x1="${PL}" x2="${CW - PR}" y1="${y(t)}" y2="${y(t)}"/><text x="${PL - 5}" y="${y(t) + 3.5}" text-anchor="end">${t}°</text>`;
    });
    mins.forEach((mn, i) => {
      const mx = maxs[i];
      const x = PL + i * bw + bw / 2 - 4;
      g += `<rect class="hit" x="${PL + i * bw}" y="${PT}" width="${bw}" height="${ih}" data-tip="${MONTHS_LONG[i]}: ${fmtNum1.format(mn)}° a ${fmtNum1.format(mx)}°"/>`;
      g += `<rect class="range" x="${x}" y="${y(mx)}" width="8" height="${Math.max(2, y(mn) - y(mx))}" rx="4"/>`;
      g += `<text x="${PL + i * bw + bw / 2}" y="${CH - 5}" text-anchor="middle">${MONTHS[i][0]}</text>`;
    });
    return `<svg class="chart" viewBox="0 0 ${CW} ${CH}" role="img" aria-label="Temperatura mínima y máxima promedio por mes">${g}</svg>`;
  }

  let tipEl = null;
  function wireTips(scope) {
    scope.querySelectorAll("[data-tip]").forEach((el) => {
      el.addEventListener("pointerenter", (e) => {
        tipEl = tipEl || Object.assign(document.createElement("div"), { className: "tip" });
        document.body.appendChild(tipEl);
        tipEl.textContent = el.dataset.tip;
        moveTip(e);
      });
      el.addEventListener("pointermove", moveTip);
      el.addEventListener("pointerleave", () => tipEl && tipEl.remove());
    });
  }
  function moveTip(e) {
    if (!tipEl) return;
    const w = tipEl.offsetWidth;
    tipEl.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, e.clientX - w / 2))}px`;
    tipEl.style.top = `${e.clientY - 40}px`;
  }

  // ---------- Panel móvil ----------
  $("#btnOpenPanel").addEventListener("click", () => {
    const p = $("#panel");
    const open = !p.classList.contains("open");
    p.classList.toggle("open", open);
    $("#btnOpenPanel").setAttribute("aria-expanded", String(open));
    if (open) closePoint();
  });
  $("#btnClosePanel").addEventListener("click", () => {
    $("#panel").classList.remove("open");
    $("#btnOpenPanel").setAttribute("aria-expanded", "false");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closePoint(); $("#panel").classList.remove("open"); }
  });

  // ---------- Inicio ----------
  window.Celeste = {
    map, $, PAL, ramp, steps, extent, merc, unmerc, resample, blur, polygons, legendHTML, bandColor,
    readPixels, fmtHour, fmtDay, fmtNum, fmtNum1, fmtNum2, ago, icon, isToday, toast, openPoint, closePoint, wireTips,
    RADAR_AREA, radarRain, gibsGrid, gibsTimes: (key, hours) => gibsTimes(Object.assign({}, ALL.find((d) => d.key === key), hours ? { window: hours } : {})), time: window.CelesteTime, setOff, SOURCES, goesRain, locate, onLocation: (h) => locHooks.push(h), placeName, refreshPoint, pointHooks: [], ext: {},
  };
  setBase(baseKey);
  renderPanel();
})();
