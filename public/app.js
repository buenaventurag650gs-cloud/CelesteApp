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
        properties: { c: p.colors[i] },
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
      const kelvin = /k/i.test(data.unidades) && !/km/i.test(data.unidades);
      data.entradas.forEach(([r, g, b, transp, lo, hi]) => {
        let v;
        if (transp) v = NaN;
        else if (lo == null && hi == null) v = NaN;
        else if (lo == null || lo <= -1e29) v = hi;
        else if (hi == null || hi >= 1e29) v = lo;
        else v = (lo + hi) / 2;
        map.set((r << 16) | (g << 8) | b, v);
      });
      return { map, kelvin };
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

  const GROUPS = [
    {
      title: "Lluvia",
      layers: [
        { key: "radar", type: "radar", name: "Radar de lluvia", desc: "COCESNA, cada 10 minutos. Cubre el norte y el centro del país.", on: true, opacity: 0.8, pal: "rain" },
        { key: "imerg30", type: "field", id: "IMERG_Precipitation_Rate_30min", name: "Lluvia estimada por satélite", desc: "NASA IMERG, cada 30 minutos con unas horas de retraso. Cubre todo el país.", opacity: 0.75, pal: "rain", srcWidth: 124, sigma: 6 },
        { key: "estaciones", type: "ext", pane: "estaciones", name: "Estaciones de lluvia", desc: "IMN cada hora, Panamá (IMHPA) y aeropuertos. Lo que de verdad cayó en cada punto.", opacity: 1 },
        { key: "imergday", type: "field", id: "IMERG_Precipitation_Rate", name: "Lluvia del último día", desc: "NASA IMERG, total del día anterior.", opacity: 0.75, pal: "rainDay", srcWidth: 124, sigma: 6, scale: 24 },
      ],
    },
    {
      title: "Nubes",
      layers: [
        { key: "geocolor", type: "tiles", id: "GOES-East_ABI_GeoColor", level: 7, name: "Satélite en color real", desc: "GOES-Este, imagen más reciente. De noche muestra luces y nubes bajas.", opacity: 0.9 },
        { key: "ir", type: "tiles", id: "GOES-East_ABI_Band13_Clean_Infrared", level: 6, name: "Nubes por temperatura", desc: "GOES-Este infrarrojo. Los topes más fríos son las tormentas más altas.", opacity: 0.7 },
        { key: "dust", type: "tiles", id: "GOES-East_ABI_Dust", level: 7, name: "Polvo del Sahara", desc: "GOES-Este. El polvo aparece en tonos rosados.", opacity: 0.75 },
      ],
    },
    {
      title: "Mar y tierra",
      layers: [
        { key: "sst", type: "field", id: "GHRSST_L4_MUR_Sea_Surface_Temperature", name: "Temperatura del mar", desc: "GHRSST, diaria.", opacity: 0.8, pal: "sst", srcWidth: 860, sigma: 1.6 },
        { key: "ssta", type: "field", id: "GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies", name: "Mar más caliente o más frío de lo normal", desc: "Anomalía diaria. Sirve para seguir El Niño y La Niña.", opacity: 0.8, pal: "ssta", srcWidth: 860, sigma: 1.6 },
        { key: "lst", type: "field", id: "MODIS_Terra_L3_Land_Surface_Temp_8Day_Day", name: "Temperatura del suelo de día", desc: "MODIS, promedio de 8 días. Muestra islas de calor.", opacity: 0.75, pal: "lst", srcWidth: 860, sigma: 1.4 },
        { key: "ndvi", type: "field", id: "VIIRS_SNPP_L3_NDVI_16Day", name: "Verdor de la vegetación", desc: "VIIRS, 16 días. Bajo en zonas secas o deforestadas.", opacity: 0.75, pal: "ndvi", srcWidth: 860, sigma: 1.4 },
        { key: "aod", type: "field", id: "MODIS_Combined_MAIAC_L2G_AerosolOpticalDepth", name: "Partículas en el aire", desc: "MODIS, diaria. Humo, polvo y contaminación.", opacity: 0.75, pal: "aod", srcWidth: 680, sigma: 2 },
        { key: "fires", type: "fires", name: "Focos de incendio", desc: "VIIRS, focos detectados ayer.", opacity: 1 },
      ],
    },
  ];

  const ALL = GROUPS.flatMap((g) => g.layers);
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
  const fields = new Map(); // key -> {grid,w,h,bbox,layer,def}

  async function loadField(def, box) {
    const stamp = $(".stamp", box);
    stamp.textContent = "Procesando la capa…";
    const [s, w, n, e] = FIELD_AREA;
    const src = extent(s, w, n, e, def.srcWidth);
    const tgt = extent(s, w, n, e, 620);
    try {
      const [lk, img] = await Promise.all([
        gibsLookup(def.id),
        readPixels(`/api/gibs/mapa?capa=${def.id}&bbox=${src.bbox.map((v) => v.toFixed(1)).join(",")}&ancho=${src.w}&alto=${src.h}`),
      ]);
      const p = PAL[def.pal];
      const isRain = def.pal.startsWith("rain");
      const raw = new Float32Array(img.w * img.h);
      let found = 0;
      for (let i = 0, j = 0; i < raw.length; i++, j += 4) {
        let v = NaN;
        if (img.px[j + 3] > 0) {
          const key = (img.px[j] << 16) | (img.px[j + 1] << 8) | img.px[j + 2];
          if (lk.map.has(key)) { v = lk.map.get(key); found++; }
        }
        if (Number.isFinite(v)) {
          if (lk.kelvin && v > 150) v -= 273.15;
          if (def.scale) v *= def.scale;
        } else if (isRain) v = 0;
        raw[i] = v;
      }
      const up = resample(raw, img.w, img.h, tgt.w, tgt.h);
      const grid = blur(up, tgt.w, tgt.h, def.sigma * (tgt.w / 620));
      const geo = polygons(grid, tgt.w, tgt.h, tgt.bbox, p);
      if (!def._on) return;
      const old = fields.get(def.key);
      if (old?.layer) map.removeLayer(old.layer);
      const layer = polyLayer(def, geo).addTo(map);
      fields.set(def.key, { grid, w: tgt.w, h: tgt.h, bbox: tgt.bbox, layer, def });
      stamp.textContent = found ? "Imagen más reciente disponible." : "No hay datos recientes sobre Costa Rica.";
    } catch (err) {
      stamp.textContent = "No se pudo cargar esta capa. Vuelve a intentarlo en unos minutos.";
    }
  }

  function makeTiles(def) {
    if (def.type === "tiles") {
      return L.tileLayer(GIBS_WMTS(def.id, def.level), {
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

  function renderPanel() {
    const wrap = $("#layerGroups");
    wrap.innerHTML = "";
    GROUPS.forEach((g) => {
      const sec = document.createElement("section");
      sec.className = "group";
      sec.innerHTML = `<h2>${g.title}</h2>`;
      g.layers.forEach((def) => {
        const box = document.createElement("div");
        box.className = "layer";
        box.dataset.key = def.key;
        const id = `chk-${def.key}`;
        const legend = def.pal ? legendHTML(PAL[def.pal]) : "";
        box.innerHTML = `
          <label class="layer-row" for="${id}">
            <input type="checkbox" id="${id}">
            <span><span class="layer-name">${def.name}</span><br><span class="layer-desc">${def.desc}</span></span>
          </label>
          <div class="layer-extra">
            ${def.type === "radar" ? productButtons() : ""}
            ${legend}
            <div class="opacity"><span>Opacidad</span><input type="range" min="0.2" max="1" step="0.05" value="${def.opacity}" aria-label="Opacidad de ${def.name}"></div>
            ${def.type === "radar" || def.type === "field" ? `<div class="stamp"${def.type === "radar" ? ' id="radarStamp"' : ""}></div>` : ""}
          </div>`;
        sec.appendChild(box);
        const chk = $("input[type=checkbox]", box);
        chk.addEventListener("change", () => toggle(def, chk.checked, box));
        $(".opacity input", box).addEventListener("input", (e) => {
          def.opacity = parseFloat(e.target.value);
          if (def.pane) map.getPane(def.pane).style.opacity = def.opacity;
          else tiles.get(def.key)?.setOpacity(def.opacity);
        });
      });
      wrap.appendChild(sec);
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
      if (on) loadField(def, box);
      else { const f = fields.get(def.key); if (f?.layer) map.removeLayer(f.layer); fields.delete(def.key); }
      return;
    }
    if (on) {
      const layer = makeTiles(def);
      layer.on("tileerror", () => {
        if (!layer._warned) { layer._warned = true; toast(`Algunas partes de "${def.name}" no cargaron. Puede que aún no haya imagen reciente.`); }
      });
      layer.addTo(map);
      tiles.set(def.key, layer);
    } else {
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
    const FRAMES = 18; // 3 horas
    const p = PAL.rain;
    const RADAR_ATTR = "Radar: <a href='http://rainweb.cocesna.org:8080/rainweb/site'>COCESNA</a>";

    let product = "LNB_CAPPI_Z_450Km_1Km_cappi_dBZ";
    let enabled = false;
    let frames = []; // {time, geo, layer, grid, cover, loaded}
    let idx = -1;
    let timer = null, refresh = null;
    let gen = 0;

    const tl = $("#timeline");
    const bars = $("#tlBars");
    const btnPlay = $("#btnPlay");
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

    function drawBars() {
      bars.innerHTML = "";
      const covers = frames.filter((f) => f.loaded).map((f) => f.cover || 0);
      const max = Math.max(0.002, ...covers);
      const lo = covers.length ? Math.min(...covers) * 0.7 : 0;
      frames.forEach((f, i) => {
        const b = document.createElement("span");
        b.className = "tl-bar" + (f.loaded ? "" : " loading") + (i === idx ? " current" : "");
        const k = max > lo ? ((f.cover || 0) - lo) / (max - lo) : 1;
        b.style.height = f.loaded ? `${6 + 28 * Math.max(0, k)}px` : "4px";
        b.title = f.loaded ? `${fmtHour.format(new Date(f.time))}: lluvia en ${fmtNum1.format((f.cover || 0) * 100)} % del área del radar` : "Procesando…";
        bars.appendChild(b);
      });
      bars.setAttribute("aria-valuemax", String(Math.max(0, frames.length - 1)));
    }

    function label(i) {
      const f = frames[i];
      if (!f) return;
      const d = new Date(f.time);
      $("#tlTime").textContent = (isToday(d) ? "" : fmtDay.format(d) + ", ") + fmtHour.format(d);
      $("#tlAgo").textContent = ago(d);
      bars.setAttribute("aria-valuenow", String(i));
      bars.setAttribute("aria-valuetext", `${fmtHour.format(d)}, ${ago(d)}`);
      $("#tlStart").textContent = fmtHour.format(new Date(frames[0].time));
      $("#tlEnd").textContent = fmtHour.format(new Date(frames[frames.length - 1].time));
    }

    function show(i) {
      if (!frames.length) return;
      i = Math.max(0, Math.min(frames.length - 1, i));
      const prev = frames[idx];
      idx = i;
      const cur = frames[idx];
      if (cur.layer && !map.hasLayer(cur.layer)) cur.layer.addTo(map);
      if (prev && prev !== cur && prev.layer) map.removeLayer(prev.layer);
      [...bars.children].forEach((b, j) => b.classList.toggle("current", j === idx));
      label(idx);
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
        const times = (data.capas[product] || []).slice(-FRAMES);
        if (!times.length) throw new Error("sin imágenes");
        const atEnd = idx === frames.length - 1;
        if (!keepPosition) { gen++; clearFrames(); }
        const known = new Set(frames.map((f) => f.time));
        const fresh = [];
        times.forEach((t) => { if (!known.has(t)) { const f = { time: t, loaded: false, cover: 0 }; frames.push(f); fresh.push(f); } });
        while (frames.length > FRAMES) { const old = frames.shift(); if (old.layer) map.removeLayer(old.layer); if (idx > 0) idx--; }
        drawBars();
        if (!keepPosition || atEnd) show(frames.length - 1);
        // La imagen más reciente primero, para que se vea de inmediato
        const myGen = gen;
        fresh.reverse().forEach((f) => build(f, myGen));
        const last = new Date(frames[frames.length - 1].time);
        setStamp(`Última imagen: ${fmtHour.format(last)} (${ago(last)}).`);
        tl.hidden = false;
      } catch (e) {
        setStamp("El radar de COCESNA no respondió. Vuelve a intentarlo en unos minutos.");
        if (!keepPosition) toast("No se pudo cargar el radar de COCESNA en este momento.");
      }
    }

    function play() {
      if (timer || frames.length < 2) return;
      btnPlay.classList.add("playing");
      btnPlay.setAttribute("aria-label", "Pausar animación del radar");
      const step = () => {
        const next = idx >= frames.length - 1 ? 0 : idx + 1;
        show(next);
        timer = setTimeout(step, next === frames.length - 1 ? 1600 : 450);
      };
      timer = setTimeout(step, 200);
    }
    function pause() {
      clearTimeout(timer); timer = null;
      btnPlay.classList.remove("playing");
      btnPlay.setAttribute("aria-label", "Reproducir animación del radar");
    }
    btnPlay.addEventListener("click", () => (timer ? pause() : play()));

    function pick(e) {
      const r = bars.getBoundingClientRect();
      pause();
      show(Math.floor(((e.clientX - r.left) / r.width) * frames.length));
    }
    let dragging = false;
    bars.addEventListener("pointerdown", (e) => { dragging = true; bars.setPointerCapture(e.pointerId); pick(e); });
    bars.addEventListener("pointermove", (e) => { if (dragging) pick(e); });
    bars.addEventListener("pointerup", () => (dragging = false));
    bars.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") { pause(); show(idx - 1); e.preventDefault(); }
      if (e.key === "ArrowRight") { pause(); show(idx + 1); e.preventDefault(); }
      if (e.key === " ") { timer ? pause() : play(); e.preventDefault(); }
    });

    document.addEventListener("click", (e) => {
      const b = e.target.closest("[data-prod]");
      if (!b || b.dataset.prod === product) return;
      document.querySelectorAll("[data-prod]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      product = b.dataset.prod;
      pause();
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
        pause();
        clearInterval(refresh);
        clearFrames();
        tl.hidden = true;
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
    if (pin) map.removeLayer(pin);
    pin = L.marker([lat, lng], { icon: L.divIcon({ className: "", html: '<div class="pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), keyboard: false }).addTo(map);
    openPoint();
    $("#ptTitle").textContent = coordText(lat, lng);
    $("#ptMeta").textContent = "Consultando…";
    $("#ptBody").innerHTML = `
      ${(window.Celeste.pointHooks || []).map((h) => h(lat, lng)).join("")}
      ${document.body.classList.contains("modo-indice") ? "" : layerValuesHTML(lat, lng)}
      <h3>Ahora</h3><div id="ptNow" class="loading-line">Cargando el pronóstico…</div>
      <h3>Próximos 7 días</h3><div id="ptDays"></div>
      <h3>Clima de este punto, 2005–2024</h3><div id="ptClim" class="loading-line">Calculando 20 años de datos…</div>`;

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
    $("#ptMeta").textContent = `Elevación aproximada: ${fmtNum.format(f.elevation)} m`;
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
    readPixels, fmtHour, fmtDay, fmtNum, fmtNum1, ago, isToday, toast, openPoint, closePoint, wireTips,
    RADAR_AREA, radarRain, pointHooks: [], ext: {},
  };
  setBase(baseKey);
  renderPanel();
})();
