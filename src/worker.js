// CelesteApp — Worker de Cloudflare
// - Sirve los archivos estáticos de /public
// - Puente (proxy) hacia el radar de COCESNA, que solo responde por HTTP
// - Contraseña opcional: si existe el secreto SITE_PASSWORD, el sitio la pide

const COCESNA = "http://rainweb.cocesna.org:8080";

// Productos de radar permitidos y el estilo con que se dibujan
const RADAR_LAYERS = {
  LNB_CAPPI_Z_450Km_1Km_cappi_dBZ: "NEXRAD_dBZ",
  "LNB_CMAX_Z_450Km_0Km-18Km_cmax_dBZ": "NEXRAD_dBZ",
};

const COOKIE = "celeste_acceso";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Acceso con contraseña (solo si está configurada)
    if (env.SITE_PASSWORD) {
      if (url.pathname === "/entrar" && request.method === "POST") {
        return login(request, env);
      }
      const ok = await hasAccess(request, env);
      if (!ok) {
        if (url.pathname.startsWith("/api/")) {
          return json({ error: "Se necesita la contraseña." }, 401);
        }
        return loginPage(url.searchParams.get("e") === "1");
      }
    }

    try {
      if (url.pathname === "/api/radar/tiempos") return radarTimes(ctx);
      if (url.pathname === "/api/radar/mapa") return radarMap(url, ctx);
      if (url.pathname === "/api/radar/datos") return radarData(url, ctx);
      if (url.pathname === "/api/gibs/mapa") return gibsMap(url, ctx);
      if (url.pathname === "/api/gibs/paleta") return gibsPalette(url, ctx);
      if (url.pathname === "/api/celeste/modelo") return modelGrid(ctx);
      if (url.pathname === "/api/estaciones/imn") return imnStations(url, ctx);
      if (url.pathname === "/api/radar/imn") return imnRadar(ctx);
      if (url.pathname === "/api/imn/regiones") return imnRegions(ctx);
      if (url.pathname === "/api/estaciones/panama") return panamaStations(ctx);
      if (url.pathname === "/api/estaciones/aeropuertos") return airports(ctx);
      if (url.pathname === "/api/salud") return json({ ok: true, hora: new Date().toISOString() });
    } catch (err) {
      return json({ error: "El servicio de radar no respondió.", detalle: String(err) }, 502);
    }

    const res = await env.ASSETS.fetch(request);
    return withHeaders(res);
  },
};

// ---------- Radar ----------

async function radarTimes(ctx) {
  const cache = caches.default;
  const key = new Request("https://celeste.cache/radar/tiempos");
  const hit = await cache.match(key);
  if (hit) return hit;

  const up = await fetch(`${COCESNA}/rainweb/RestService/getTimeDimension`, {
    headers: { "User-Agent": "CelesteApp/0.1 (visor climatico)", Accept: "application/json" },
  });
  const type = up.headers.get("content-type") || "";
  if (!up.ok || !type.includes("json")) {
    return json({ error: "El radar de COCESNA no entregó la lista de imágenes." }, 502);
  }
  const all = await up.json();
  const out = {};
  for (const layer of Object.keys(RADAR_LAYERS)) {
    const list = (all[layer] || []).filter(Boolean).sort();
    out[layer] = list.slice(-36); // ~6 horas, una imagen cada 10 min
  }
  const res = json({ capas: out, consultado: new Date().toISOString() }, 200, {
    "Cache-Control": "public, max-age=60",
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

async function radarMap(url, ctx) {
  const layer = url.searchParams.get("capa");
  const time = url.searchParams.get("hora");
  const bbox = url.searchParams.get("bbox");
  const w = parseInt(url.searchParams.get("ancho") || "900", 10);
  const h = parseInt(url.searchParams.get("alto") || "800", 10);

  if (!RADAR_LAYERS[layer]) return json({ error: "Capa de radar no permitida." }, 400);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(time || "")) {
    return json({ error: "Hora inválida." }, 400);
  }
  const nums = (bbox || "").split(",").map(Number);
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
    return json({ error: "Área inválida." }, 400);
  }
  if (!(w > 0 && w <= 2048 && h > 0 && h <= 2048)) return json({ error: "Tamaño inválido." }, 400);

  const params = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    VERSION: "1.1.1",
    LAYERS: layer,
    STYLES: RADAR_LAYERS[layer],
    FORMAT: "image/png",
    TRANSPARENT: "true",
    SRS: "EPSG:3857",
    BBOX: nums.join(","),
    WIDTH: String(w),
    HEIGHT: String(h),
    TIME: time,
  });
  const upstream = `${COCESNA}/geoserver/geosolutions/wms?${params}`;

  const cache = caches.default;
  const key = new Request(`https://celeste.cache/radar/mapa?${params}`);
  const hit = await cache.match(key);
  if (hit) return hit;

  const up = await fetch(upstream, { headers: { "User-Agent": "CelesteApp/0.1 (visor climatico)" } });
  const type = up.headers.get("content-type") || "";
  if (!up.ok || !type.startsWith("image/")) {
    return json({ error: "El radar no entregó la imagen." }, 502);
  }
  // Una imagen de una hora fija no cambia: se guarda un día
  const res = new Response(up.body, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=86400, immutable",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// Radar como datos: el valor en dBZ se codifica en escala de grises
// (0 dBZ -> 1, 85 dBZ -> 255) para que la página lea la intensidad real.
function valueSLD(layer) {
  return `<?xml version="1.0" encoding="UTF-8"?><StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc"><NamedLayer><Name>geosolutions:${layer}</Name><UserStyle><FeatureTypeStyle><Rule><RasterSymbolizer><ColorMap type="ramp"><ColorMapEntry color="#000000" quantity="-32" opacity="0"/><ColorMapEntry color="#000000" quantity="0" opacity="0"/><ColorMapEntry color="#010101" quantity="0.01" opacity="1"/><ColorMapEntry color="#FFFFFF" quantity="85" opacity="1"/></ColorMap></RasterSymbolizer></Rule></FeatureTypeStyle></UserStyle></NamedLayer></StyledLayerDescriptor>`;
}

function checkMapParams(url) {
  const bbox = (url.searchParams.get("bbox") || "").split(",").map(Number);
  const w = parseInt(url.searchParams.get("ancho") || "0", 10);
  const h = parseInt(url.searchParams.get("alto") || "0", 10);
  if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) return { error: "Área inválida." };
  if (!(w > 0 && w <= 1024 && h > 0 && h <= 1024)) return { error: "Tamaño inválido." };
  return { bbox: bbox.join(","), w, h };
}

async function cachedImage(key, upstream, init, maxAge, ctx) {
  const cache = caches.default;
  const k = new Request(key);
  const hit = await cache.match(k);
  if (hit) return hit;
  const up = await fetch(upstream, init);
  const type = up.headers.get("content-type") || "";
  if (!up.ok || !type.startsWith("image/")) return json({ error: "La fuente no entregó la imagen." }, 502);
  const res = new Response(up.body, {
    headers: { "Content-Type": type, "Cache-Control": `public, max-age=${maxAge}`, "X-Robots-Tag": "noindex, nofollow" },
  });
  ctx.waitUntil(cache.put(k, res.clone()));
  return res;
}

async function radarData(url, ctx) {
  const layer = url.searchParams.get("capa");
  const time = url.searchParams.get("hora");
  if (!RADAR_LAYERS[layer]) return json({ error: "Capa de radar no permitida." }, 400);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(time || "")) return json({ error: "Hora inválida." }, 400);
  const p = checkMapParams(url);
  if (p.error) return json(p, 400);
  const params = new URLSearchParams({
    SERVICE: "WMS", REQUEST: "GetMap", VERSION: "1.1.1", LAYERS: layer, FORMAT: "image/png", TRANSPARENT: "true",
    SRS: "EPSG:3857", BBOX: p.bbox, WIDTH: String(p.w), HEIGHT: String(p.h), TIME: time,
  });
  const upstream = `${COCESNA}/geoserver/geosolutions/wms?${params}&SLD_BODY=${encodeURIComponent(valueSLD(layer))}`;
  return cachedImage(`https://celeste.cache/radar/datos?${params}`, upstream,
    { headers: { "User-Agent": "CelesteApp/0.1 (visor climatico)" } }, 86400, ctx);
}

// Capas de NASA GIBS que se leen como datos, y la tabla de colores de cada una
const GIBS_LAYERS = {
  IMERG_Precipitation_Rate_30min: "GPM_Precipitation_Rate",
  IMERG_Precipitation_Rate: "GPM_Precipitation_Rate",
  GHRSST_L4_MUR_Sea_Surface_Temperature: "GHRSST_Sea_Surface_Temperature",
  GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies: "GHRSST_Sea_Surface_Temperature_Anomalies",
  MODIS_Terra_L3_Land_Surface_Temp_8Day_Day: "MODIS_Land_Surface_Temp",
  VIIRS_SNPP_L3_NDVI_16Day: "MODIS_L3_NDVI",
  MODIS_Combined_MAIAC_L2G_AerosolOpticalDepth: "MODIS_VIIRS_AOD",
};
const GIBS = "https://gibs.earthdata.nasa.gov";

async function gibsMap(url, ctx) {
  const layer = url.searchParams.get("capa");
  if (!GIBS_LAYERS[layer]) return json({ error: "Capa no permitida." }, 400);
  const p = checkMapParams(url);
  if (p.error) return json(p, 400);
  const time = url.searchParams.get("hora");
  if (time && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/.test(time)) return json({ error: "Hora inválida." }, 400);
  const params = new URLSearchParams({
    SERVICE: "WMS", REQUEST: "GetMap", VERSION: "1.3.0", LAYERS: layer, STYLES: "", FORMAT: "image/png",
    TRANSPARENT: "true", CRS: "EPSG:3857", BBOX: p.bbox, WIDTH: String(p.w), HEIGHT: String(p.h),
  });
  if (time) params.set("TIME", time);
  // Sin hora fija la imagen es "la más reciente": se guarda 30 minutos
  return cachedImage(`https://celeste.cache/gibs/mapa?${params}`, `${GIBS}/wms/epsg3857/best/wms.cgi?${params}`,
    {}, time ? 86400 : 1800, ctx);
}

async function gibsPalette(url, ctx) {
  const layer = url.searchParams.get("capa");
  const name = GIBS_LAYERS[layer];
  if (!name) return json({ error: "Capa no permitida." }, 400);
  const cache = caches.default;
  const key = new Request(`https://celeste.cache/gibs/paleta/${name}`);
  const hit = await cache.match(key);
  if (hit) return hit;
  const up = await fetch(`${GIBS}/colormaps/v1.3/${name}.xml`);
  if (!up.ok) return json({ error: "No se pudo leer la tabla de colores." }, 502);
  const xml = await up.text();
  // Solo el primer ColorMap (el de datos; los siguientes son de "sin datos")
  const units = (xml.match(/<ColorMap[^>]*units="([^"]*)"/) || [])[1] || "";
  const entries = [];
  const re = /<ColorMapEntry\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const a = m[1];
    const rgb = (a.match(/rgb="(\d+),(\d+),(\d+)"/) || []).slice(1).map(Number);
    if (rgb.length !== 3) continue;
    const transparent = /transparent="true"/.test(a);
    const v = (a.match(/value="([^"]*)"/) || [])[1];
    let lo = null, hi = null;
    if (v) {
      const r = v.match(/^[\[\(]\s*([^,]*),\s*([^\]\)]*)[\]\)]$/);
      if (r) { lo = parseNum(r[1]); hi = parseNum(r[2]); }
      else { lo = hi = parseNum(v); }
    }
    entries.push([rgb[0], rgb[1], rgb[2], transparent ? 1 : 0, lo, hi]);
  }
  const res = json({ capa: layer, unidades: units, entradas: entries }, 200, { "Cache-Control": "public, max-age=604800" });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

function parseNum(s) {
  s = String(s).trim();
  if (/^-?inf$/i.test(s) || s === "+INF") return s.startsWith("-") ? -1e30 : 1e30;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ---------- Modelo numérico para el índice CELESTE ----------
// Rejilla de 0,3° sobre Costa Rica (≈ resolución de los modelos globales).
// Se consulta una vez por hora y se guarda para todos los visitantes.
const MODEL_GRID = { lat0: 7.8, lat1: 11.4, lon0: -86.4, lon1: -82.2, step: 0.3 };
const MODEL_VARS = ["precipitation", "precipitation_probability", "cape", "wind_gusts_10m", "apparent_temperature"];

async function modelGrid(ctx) {
  const hourKey = new Date().toISOString().slice(0, 13);
  const cache = caches.default;
  const key = new Request(`https://celeste.cache/modelo/${hourKey}`);
  const hit = await cache.match(key);
  if (hit) return hit;

  const g = MODEL_GRID;
  const lats = [], lons = [];
  for (let la = g.lat0; la <= g.lat1 + 1e-9; la += g.step) lats.push(+la.toFixed(3));
  for (let lo = g.lon0; lo <= g.lon1 + 1e-9; lo += g.step) lons.push(+lo.toFixed(3));
  const pts = [];
  lats.forEach((la) => lons.forEach((lo) => pts.push([la, lo])));

  const chunks = [];
  for (let i = 0; i < pts.length; i += 100) chunks.push(pts.slice(i, i + 100));
  const results = await Promise.all(chunks.map(async (c) => {
    const q = new URLSearchParams({
      latitude: c.map((p) => p[0]).join(","),
      longitude: c.map((p) => p[1]).join(","),
      hourly: MODEL_VARS.join(","),
      past_hours: "7",
      forecast_hours: "8",
      timezone: "GMT",
      timeformat: "unixtime",
    });
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
    if (!r.ok) throw new Error(`modelo ${r.status}`);
    const j = await r.json();
    return Array.isArray(j) ? j : [j];
  }));
  const all = results.flat();
  if (all.length !== pts.length) return json({ error: "Respuesta incompleta del modelo." }, 502);

  const times = all[0].hourly.time;
  const nt = times.length, ny = lats.length, nx = lons.length;
  const v = {};
  MODEL_VARS.forEach((name) => {
    const arr = new Array(nt * ny * nx);
    all.forEach((p, idx) => {
      const j = Math.floor(idx / nx), i = idx % nx;
      const series = p.hourly[name] || [];
      for (let k = 0; k < nt; k++) {
        const val = series[k];
        arr[(k * ny + j) * nx + i] = val == null ? null : Math.round(val * 10) / 10;
      }
    });
    v[name] = arr;
  });
  const res = json({ lats, lons, times, vars: v, generado: new Date().toISOString() }, 200, { "Cache-Control": "public, max-age=1800" });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// ---------- Estaciones ----------
async function cachedJSON(key, maxAge, ctx, produce) {
  const cache = caches.default;
  const k = new Request(key);
  const hit = await cache.match(k);
  if (hit) return hit;
  const data = await produce();
  const res = json(data, 200, { "Cache-Control": `public, max-age=${maxAge}` });
  ctx.waitUntil(cache.put(k, res.clone()));
  return res;
}

// IMN: tablas horarias de las estaciones automáticas (datos preliminares, sin control de calidad)
function parseIMNDate(s) {
  // "31/10/2026 10:00 a. m."
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])/i);
  if (!m) return null;
  let h = parseInt(m[4], 10) % 12;
  if (m[6].toLowerCase() === "p") h += 12;
  return `${m[3]}-${m[2]}-${m[1]}T${String(h).padStart(2, "0")}:${m[5]}:00-06:00`;
}
// Números en formato del IMN: "1.001,10", "1 006,83", "0,20"
const num = (s) => {
  let v = String(s).replace(/[\s\u00a0\u202f]/g, "");
  if (v.includes(",")) v = v.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

async function imnTable(t, ctx) {
  return cachedJSON(`https://celeste.cache/imn3/${t}`, 600, ctx, async () => {
    const r = await fetch(`https://www.imn.ac.cr/especial/tablas/${t}.html`, { headers: { "User-Agent": "CelesteApp/0.1 (visor climatico)" } });
    if (!r.ok) return { t, filas: [] };
    const html = await r.text();
    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
      [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => c[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim()));
    if (!rows.length) return { t, filas: [] };
    // Todas las variables que publica la estación (temperatura, lluvia, viento, presión, radiación…)
    const cols = rows[0].slice(1).map((h) => h.trim());
    const filas = rows.slice(1, 25).map((c) => [parseIMNDate(c[0] || ""), ...cols.map((_, i) => num(c[i + 1]))]).filter((f) => f[0]);
    return { t, cols, filas };
  });
}

async function imnStations(url, ctx) {
  const list = (url.searchParams.get("t") || "").split(",").filter((t) => /^[a-z0-9]{2,30}$/.test(t)).slice(0, 12); // ≤ 12 × (consulta + caché) dentro del límite de subconsultas
  if (!list.length) return json({ error: "Sin estaciones." }, 400);
  const out = {};
  await Promise.all(list.map(async (t) => {
    try { const r = await imnTable(t, ctx); const j = await r.clone().json(); out[t] = { cols: j.cols || [], filas: j.filas }; } catch (e) { out[t] = { cols: [], filas: [] }; }
  }));
  return json({ estaciones: out }, 200, { "Cache-Control": "public, max-age=300" });
}

// Radar del IMN (Aranjuez, Valle Central): imagen pública; la fecha viene en Last-Modified
async function imnRadar(ctx) {
  const cache = caches.default;
  const key = new Request("https://celeste.cache/radar/imn");
  const hit = await cache.match(key);
  if (hit) return hit;
  const up = await fetch("https://www.imn.ac.cr/imagenes-sat/radar1m10.jpg", { headers: { "User-Agent": "CelesteApp/0.1 (visor climatico)" } });
  const type = up.headers.get("content-type") || "";
  if (!up.ok || !type.startsWith("image/")) return json({ error: "El radar del IMN no respondió." }, 502);
  const res = new Response(up.body, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=120",
      "X-Fecha-Imagen": up.headers.get("last-modified") || "",
      "Access-Control-Expose-Headers": "X-Fecha-Imagen",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// Regiones climáticas oficiales del IMN (nodo IMN del SNIT, servidor SINIA), simplificadas
async function imnRegions(ctx) {
  return cachedJSON("https://celeste.cache/imn/regiones", 604800, ctx, async () => {
    const r = await fetch("https://geodatos.sinia.go.cr/geoserver/IMN/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=IMN:reg_climaticas_imn&outputFormat=application/json&srsName=EPSG:4326");
    if (!r.ok) return { type: "FeatureCollection", features: [] };
    const j = await r.json();
    const round = (ring) => {
      const out = [];
      let last = null;
      for (const [x, y] of ring) {
        const p = [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
        if (!last || p[0] !== last[0] || p[1] !== last[1]) out.push(p);
        last = p;
      }
      return out;
    };
    return {
      type: "FeatureCollection",
      features: j.features.map((f) => ({
        type: "Feature",
        properties: { region: String(f.properties.region || "").replace(/^Regi[oó]n\s*/i, "").replace(/^Central$/, "Valle Central").replace(/^Norte$/, "Zona Norte") },
        geometry: { type: "MultiPolygon", coordinates: (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates).map((poly) => poly.map(round).filter((ring) => ring.length >= 4)) },
      })),
    };
  });
}

// Panamá (IMHPA): lluvia acumulada de 24 horas en estaciones de la región occidental
async function panamaStations(ctx) {
  return cachedJSON("https://celeste.cache/panama/lluvia", 900, ctx, async () => {
    const r = await fetch("https://www.imhpa.gob.pa/es/estaciones-satelitales-data2?sensor=LLUVIA", { headers: { "User-Agent": "CelesteApp/0.1 (visor climatico)" } });
    if (!r.ok) return { estaciones: [] };
    const j = await r.json();
    const est = Object.values(j.estaciones || {}).map((e) => {
      const lat = num(e.latitud), lon = num(e.longitud);
      const m = String(e.sensor_fecha || "").match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP])M/i);
      let iso = null;
      if (m) { let h = parseInt(m[4], 10) % 12; if (m[6].toUpperCase() === "P") h += 12; iso = `${m[3]}-${m[2]}-${m[1]}T${String(h).padStart(2, "0")}:${m[5]}:00-05:00`; }
      return [e.nombre, lat, lon, Number.isFinite(e.sensor_valor_sin_format) ? e.sensor_valor_sin_format : num(e.sensor_valor), iso];
    }).filter((e) => e[1] != null && e[2] != null && e[1] < 10.5 && e[2] < -81.0);
    return { fuente: "IMHPA (Ley 209 de 2021, uso con cita de la fuente)", estaciones: est };
  });
}

// Aeropuertos (METAR): estado del tiempo cada hora
async function airports(ctx) {
  return cachedJSON("https://celeste.cache/metar/cr", 600, ctx, async () => {
    const r = await fetch("https://aviationweather.gov/api/data/metar?bbox=8,-86.2,11.3,-82.5&format=json&hours=3", { headers: { "User-Agent": "CelesteApp/0.1 (visor climatico)" } });
    if (!r.ok) return { aeropuertos: [] };
    const j = await r.json();
    const latest = {};
    j.forEach((m) => { if (!latest[m.icaoId] || m.obsTime > latest[m.icaoId].obsTime) latest[m.icaoId] = m; });
    return {
      aeropuertos: Object.values(latest).map((m) => ({
        id: m.icaoId, nombre: m.name, lat: m.lat, lon: m.lon, hora: m.obsTime, temp: m.temp,
        wx: m.wxString || "", nubes: (m.clouds || []).map((c) => c.cover).join(" "), crudo: m.rawOb,
      })),
    };
  });
}

// ---------- Acceso ----------

async function token(env) {
  const data = new TextEncoder().encode(`celeste:${env.SITE_PASSWORD}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hasAccess(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`${COOKIE}=([a-f0-9]{64})`));
  return !!m && m[1] === (await token(env));
}

async function login(request, env) {
  const form = await request.formData();
  const pass = String(form.get("clave") || "");
  if (pass !== env.SITE_PASSWORD) {
    return new Response(null, { status: 303, headers: { Location: "/?e=1" } });
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": `${COOKIE}=${await token(env)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

function loginPage(error) {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Celeste — Entrar</title>
<style>
:root{--bg:#e9f1f7;--ink:#12324a;--muted:#5d7488;--line:#c7d6e2;--accent:#2f7fc1;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0c1b28;--ink:#e2edf5;--muted:#93a9bb;--line:#24405a;--accent:#6bb4ee;--card:#122739}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
form{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:28px;width:min(340px,calc(100vw - 32px));box-sizing:border-box}
h1{margin:0 0 4px;font-size:26px;letter-spacing:.02em}p{margin:0 0 18px;color:var(--muted);font-size:14px}
input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);font:inherit}
button{margin-top:12px;width:100%;padding:11px;border:0;border-radius:10px;background:var(--accent);color:#fff;font:600 15px system-ui;cursor:pointer}
.e{color:#c0392b;font-size:14px;margin:10px 0 0}
</style></head><body>
<form method="post" action="/entrar"><h1>Celeste</h1><p>El cielo de Costa Rica, en vivo. Este prototipo es privado.</p>
<label for="clave" style="font-size:14px">Contraseña</label>
<input id="clave" name="clave" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Entrar</button>${error ? '<p class="e">La contraseña no coincide. Inténtalo de nuevo.</p>' : ""}</form>
</body></html>`;
  return new Response(html, {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" },
  });
}

// ---------- Utilidades ----------

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "X-Robots-Tag": "noindex, nofollow", ...extra },
  });
}

function withHeaders(res) {
  const r = new Response(res.body, res);
  r.headers.set("X-Robots-Tag", "noindex, nofollow");
  r.headers.set("X-Content-Type-Options", "nosniff");
  r.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return r;
}
