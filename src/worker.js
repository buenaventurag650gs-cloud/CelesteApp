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
