/* Celeste — visor climático de Costa Rica */
(function () {
  "use strict";

  // ---------- Utilidades ----------
  const $ = (s, el = document) => el.querySelector(s);
  const TZ = "America/Costa_Rica";
  const fmtHour = new Intl.DateTimeFormat("es-CR", { hour: "numeric", minute: "2-digit", timeZone: TZ });
  const fmtDay = new Intl.DateTimeFormat("es-CR", { weekday: "short", day: "numeric", timeZone: TZ });
  const fmtNum = new Intl.NumberFormat("es-CR", { maximumFractionDigits: 0 });
  const fmtNum1 = new Intl.NumberFormat("es-CR", { maximumFractionDigits: 1 });
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
    const a = new Date().toLocaleDateString("es-CR", { timeZone: TZ });
    return date.toLocaleDateString("es-CR", { timeZone: TZ }) === a;
  }

  function yesterdayUTC() {
    const d = new Date(Date.now() - 86400000);
    return d.toISOString().slice(0, 10);
  }

  // Web Mercator
  const R = 6378137;
  const merc = (lat, lng) => [
    (lng * Math.PI / 180) * R,
    Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R,
  ];

  // ---------- Tema ----------
  const root = document.documentElement;
  const savedTheme = store.get("celeste-tema");
  if (savedTheme === "light" || savedTheme === "dark") root.dataset.theme = savedTheme;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const isDark = () => root.dataset.theme ? root.dataset.theme === "dark" : media.matches;

  // ---------- Mapa ----------
  const map = L.map("map", {
    center: [9.85, -84.15],
    zoom: window.innerWidth < 820 ? 7 : 8,
    minZoom: 6,
    maxZoom: 13,
    zoomControl: false,
    attributionControl: true,
    worldCopyJump: false,
  });
  L.control.zoom({ position: "topright", zoomInTitle: "Acercar", zoomOutTitle: "Alejar" }).addTo(map);
  map.attributionControl.setPrefix(false);

  map.createPane("clima").style.zIndex = 410;
  map.createPane("radar").style.zIndex = 420;
  map.createPane("etiquetas").style.zIndex = 640;
  map.getPane("etiquetas").style.pointerEvents = "none";

  const CARTO = "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> &copy; <a href='https://carto.com/attributions'>CARTO</a>";
  const ESRI = "Tiles &copy; Esri";
  let baseKey = store.get("celeste-fondo") || "calles";
  let baseLayer = null;
  let labelLayer = null;

  function setBase(key) {
    baseKey = key;
    store.set("celeste-fondo", key);
    if (baseLayer) map.removeLayer(baseLayer);
    if (labelLayer) map.removeLayer(labelLayer);
    const dark = isDark();
    if (key === "satelite") {
      baseLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { attribution: ESRI, maxZoom: 19 });
      labelLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png", { pane: "etiquetas", attribution: CARTO, subdomains: "abcd" });
    } else if (key === "relieve") {
      baseLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}", { attribution: ESRI, maxZoom: 16, className: dark ? "relieve-oscuro" : "" });
      labelLayer = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${dark ? "dark" : "light"}_only_labels/{z}/{x}/{y}{r}.png`, { pane: "etiquetas", attribution: CARTO, subdomains: "abcd" });
    } else {
      baseLayer = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${dark ? "dark" : "light"}_nolabels/{z}/{x}/{y}{r}.png`, { attribution: CARTO, subdomains: "abcd", maxZoom: 19 });
      labelLayer = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${dark ? "dark" : "light"}_only_labels/{z}/{x}/{y}{r}.png`, { pane: "etiquetas", attribution: CARTO, subdomains: "abcd" });
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

  // ---------- Capas ----------
  const GIBS_WMTS = (id, level) =>
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${id}/default/default/GoogleMapsCompatible_Level${level}/{z}/{y}/{x}.png`;
  const GIBS_ATTR = "<a href='https://earthdata.nasa.gov/gibs'>NASA GIBS</a>";
  const LEG = (name) => `https://gibs.earthdata.nasa.gov/legends/${name}.svg`;

  const GROUPS = [
    {
      title: "Lluvia",
      layers: [
        { key: "radar", type: "radar", name: "Radar de lluvia", desc: "COCESNA, cada 10 minutos. Cubre el norte y el centro del país.", on: true, opacity: 0.85 },
        { key: "imerg30", type: "gibs", id: "IMERG_Precipitation_Rate_30min", level: 6, name: "Lluvia estimada por satélite", desc: "NASA IMERG, cada 30 minutos con unas horas de retraso. Cubre todo el país.", legend: LEG("GPM_Precipitation_Rate_H"), opacity: 0.8 },
        { key: "imergday", type: "gibs", id: "IMERG_Precipitation_Rate", level: 6, name: "Lluvia del último día", desc: "NASA IMERG, promedio del día anterior.", legend: LEG("GPM_Precipitation_Rate_H"), opacity: 0.8 },
      ],
    },
    {
      title: "Nubes",
      layers: [
        { key: "geocolor", type: "gibs", id: "GOES-East_ABI_GeoColor", level: 7, name: "Satélite en color real", desc: "GOES-Este, imagen más reciente. De noche muestra luces y nubes bajas.", opacity: 0.9 },
        { key: "ir", type: "gibs", id: "GOES-East_ABI_Band13_Clean_Infrared", level: 6, name: "Nubes por temperatura", desc: "GOES-Este infrarrojo. Los topes más fríos son las tormentas más altas.", legend: LEG("Clean_Longwave_Infrared_Window_Band_H"), opacity: 0.7 },
        { key: "dust", type: "gibs", id: "GOES-East_ABI_Dust", level: 7, name: "Polvo del Sahara", desc: "GOES-Este. El polvo aparece en tonos rosados.", opacity: 0.75 },
      ],
    },
    {
      title: "Mar y tierra",
      layers: [
        { key: "sst", type: "gibs", id: "GHRSST_L4_MUR_Sea_Surface_Temperature", level: 7, name: "Temperatura del mar", desc: "GHRSST, diaria.", legend: LEG("GHRSST_Sea_Surface_Temperature_H"), opacity: 0.8 },
        { key: "ssta", type: "gibs", id: "GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies", level: 7, name: "Mar más caliente o más frío de lo normal", desc: "Anomalía diaria. Sirve para seguir El Niño y La Niña.", legend: LEG("GHRSST_Sea_Surface_Temperature_Anomalies_H"), opacity: 0.8 },
        { key: "lst", type: "gibs", id: "MODIS_Terra_L3_Land_Surface_Temp_8Day_Day", level: 7, name: "Temperatura del suelo de día", desc: "MODIS, promedio de 8 días. Muestra islas de calor.", legend: LEG("MODIS_Land_Surface_Temp_H"), opacity: 0.75 },
        { key: "ndvi", type: "gibs", id: "VIIRS_SNPP_L3_NDVI_16Day", level: 8, name: "Verdor de la vegetación", desc: "VIIRS, 16 días. Bajo en zonas secas o deforestadas.", legend: LEG("MODIS_L3_NDVI_H"), opacity: 0.75 },
        { key: "aod", type: "gibs", id: "MODIS_Combined_MAIAC_L2G_AerosolOpticalDepth", level: 7, name: "Partículas en el aire", desc: "MODIS, diaria. Humo, polvo y contaminación.", legend: LEG("MODIS_VIIRS_AOD_H"), opacity: 0.75 },
        { key: "fires", type: "fires", name: "Focos de incendio", desc: "VIIRS, focos detectados ayer.", opacity: 1 },
      ],
    },
  ];

  const active = new Map(); // key -> leaflet layer

  function makeLayer(def) {
    if (def.type === "gibs") {
      return L.tileLayer(GIBS_WMTS(def.id, def.level), {
        pane: "clima", maxNativeZoom: def.level, maxZoom: 13, opacity: def.opacity, attribution: GIBS_ATTR,
        bounds: [[-85, -180], [85, 180]], errorTileUrl: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
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
        box.innerHTML = `
          <label class="layer-row" for="${id}">
            <input type="checkbox" id="${id}">
            <span><span class="layer-name">${def.name}</span><br><span class="layer-desc">${def.desc}</span></span>
          </label>
          <div class="layer-extra">
            ${def.type === "radar" ? radarExtra() : def.legend ? `<img src="${def.legend}" alt="Leyenda de ${def.name}" loading="lazy">` : ""}
            <div class="opacity"><span>Opacidad</span><input type="range" min="0.2" max="1" step="0.05" value="${def.opacity}" aria-label="Opacidad de ${def.name}"></div>
          </div>`;
        sec.appendChild(box);
        const chk = $("input[type=checkbox]", box);
        chk.addEventListener("change", () => toggle(def, chk.checked, box));
        $(".opacity input", box).addEventListener("input", (e) => {
          def.opacity = parseFloat(e.target.value);
          if (def.type === "radar") radar.setOpacity(def.opacity);
          else active.get(def.key)?.setOpacity(def.opacity);
        });
        if (def.on) { chk.checked = true; toggle(def, true, box); }
      });
      wrap.appendChild(sec);
    });
  }

  const RADAR_COLORS = ["#04e9e7", "#019ff4", "#0300f4", "#02fd02", "#01c501", "#008e00", "#fdf802", "#e5bc00", "#fd9500", "#fd0000", "#d40000", "#bc0000", "#f800fd", "#9854c6"];
  function radarExtra() {
    return `
      <div class="product" role="group" aria-label="Producto de radar">
        <button type="button" data-prod="LNB_CAPPI_Z_450Km_1Km_cappi_dBZ" aria-pressed="true">Lluvia cerca del suelo</button>
        <button type="button" data-prod="LNB_CMAX_Z_450Km_0Km-18Km_cmax_dBZ" aria-pressed="false">Máximo en las nubes</button>
      </div>
      <div class="radar-scale" aria-hidden="true">${RADAR_COLORS.map((c) => `<span style="background:${c}"></span>`).join("")}</div>
      <div class="radar-scale-labels"><span>Llovizna</span><span>Moderada</span><span>Fuerte</span><span>Granizo</span></div>
      <div class="stamp" id="radarStamp">Cargando imágenes…</div>`;
  }

  function toggle(def, on, box) {
    box.classList.toggle("on", on);
    if (def.type === "radar") {
      on ? radar.enable() : radar.disable();
      return;
    }
    if (on) {
      const layer = makeLayer(def);
      if (!layer) return;
      layer.on("tileerror", () => {
        if (!layer._warned) { layer._warned = true; toast(`Algunas partes de "${def.name}" no cargaron. Puede que aún no haya imagen reciente.`); }
      });
      layer.addTo(map);
      active.set(def.key, layer);
    } else {
      const l = active.get(def.key);
      if (l) map.removeLayer(l);
      active.delete(def.key);
    }
  }

  // ---------- Radar ----------
  const radar = (() => {
    const bounds = L.latLngBounds([7.55, -86.5], [11.75, -82.25]);
    const sw = merc(bounds.getSouth(), bounds.getWest());
    const ne = merc(bounds.getNorth(), bounds.getEast());
    const bbox = [sw[0], sw[1], ne[0], ne[1]].map((n) => n.toFixed(1)).join(",");
    const W = 1000;
    const H = Math.round(W * (ne[1] - sw[1]) / (ne[0] - sw[0]));
    const FRAMES = 18; // 3 horas

    let product = "LNB_CAPPI_Z_450Km_1Km_cappi_dBZ";
    let enabled = false;
    let frames = []; // {time, overlay, cover, loaded}
    let idx = -1;
    let timer = null;
    let refresh = null;
    let opacity = 0.85;

    const tl = $("#timeline");
    const bars = $("#tlBars");
    const btnPlay = $("#btnPlay");

    function url(time) {
      const p = new URLSearchParams({ capa: product, hora: time, bbox, ancho: W, alto: H });
      return `/api/radar/mapa?${p}`;
    }

    function measure(frame) {
      const img = frame.overlay.getElement();
      if (!img) return;
      try {
        const c = document.createElement("canvas");
        c.width = 100; c.height = Math.round(100 * H / W);
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 30) n++;
        frame.cover = n / (c.width * c.height);
      } catch (e) {
        frame.cover = 0;
      }
    }

    function drawBars() {
      bars.innerHTML = "";
      const max = Math.max(0.002, ...frames.map((f) => f.cover || 0));
      frames.forEach((f, i) => {
        const b = document.createElement("span");
        b.className = "tl-bar" + (f.loaded ? "" : " loading") + (i === idx ? " current" : "");
        b.style.height = f.loaded ? `${4 + 30 * ((f.cover || 0) / max)}px` : "4px";
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
      if (frames[idx]) frames[idx].overlay.setOpacity(0);
      idx = i;
      frames[idx].overlay.setOpacity(opacity);
      [...bars.children].forEach((b, j) => b.classList.toggle("current", j === idx));
      label(idx);
    }

    function clearFrames() {
      frames.forEach((f) => map.removeLayer(f.overlay));
      frames = [];
      idx = -1;
    }

    function addFrame(time) {
      const overlay = L.imageOverlay(url(time), bounds, { pane: "radar", opacity: 0, interactive: false, attribution: "Radar: <a href='http://rainweb.cocesna.org:8080/rainweb/site'>COCESNA</a>" });
      const f = { time, overlay, cover: 0, loaded: false };
      overlay.on("load", () => { f.loaded = true; measure(f); drawBars(); });
      overlay.on("error", () => { f.loaded = true; f.cover = 0; drawBars(); });
      overlay.addTo(map);
      return f;
    }

    async function load(keepPosition) {
      const stamp = $("#radarStamp");
      try {
        const r = await fetch("/api/radar/tiempos", { cache: "no-store" });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
        const data = await r.json();
        const times = (data.capas[product] || []).slice(-FRAMES);
        if (!times.length) throw new Error("sin imágenes");
        const atEnd = idx === frames.length - 1;
        const known = new Set(frames.map((f) => f.time));
        if (!keepPosition) clearFrames();
        times.forEach((t) => { if (!known.has(t) || !keepPosition) frames.push(addFrame(t)); });
        // descartar las que salieron de la ventana
        while (frames.length > FRAMES) { const old = frames.shift(); map.removeLayer(old.overlay); if (idx > 0) idx--; }
        drawBars();
        if (!keepPosition || atEnd) show(frames.length - 1);
        const last = new Date(frames[frames.length - 1].time);
        stamp.textContent = `Última imagen: ${fmtHour.format(last)} (${ago(last)}).`;
        tl.hidden = false;
      } catch (e) {
        stamp.textContent = "El radar de COCESNA no respondió. Vuelve a intentarlo en unos minutos.";
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
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      pause();
      show(Math.floor((x / r.width) * frames.length));
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
        load(false);
        clearInterval(refresh);
        refresh = setInterval(() => load(true), 5 * 60 * 1000);
      },
      disable() {
        enabled = false;
        pause();
        clearInterval(refresh);
        clearFrames();
        tl.hidden = true;
      },
      setOpacity(o) {
        opacity = o;
        if (frames[idx]) frames[idx].overlay.setOpacity(o);
      },
    };
  })();

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

  map.on("click", async (e) => {
    const { lat, lng } = e.latlng;
    const req = ++pointReq;
    if (pin) map.removeLayer(pin);
    pin = L.marker([lat, lng], { icon: L.divIcon({ className: "", html: '<div class="pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), keyboard: false }).addTo(map);
    openPoint();
    $("#ptTitle").textContent = coordText(lat, lng);
    $("#ptMeta").textContent = "Consultando…";
    $("#ptBody").innerHTML = `
      <h3>Ahora</h3><div id="ptNow" class="loading-line">Cargando el pronóstico…</div>
      <h3>Próximos 7 días</h3><div id="ptDays"></div>
      <h3>Clima de este punto, 2005–2024</h3><div id="ptClim" class="loading-line">Calculando 20 años de datos…</div>`;

    const la = lat.toFixed(3), lo = lng.toFixed(3);
    const fUrl = `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max&timezone=${encodeURIComponent(TZ)}&forecast_days=7`;
    const cUrl = `https://archive-api.open-meteo.com/v1/archive?latitude=${la}&longitude=${lo}&start_date=2005-01-01&end_date=2024-12-31&daily=precipitation_sum,temperature_2m_max,temperature_2m_min&timezone=${encodeURIComponent(TZ)}`;

    fetch(fUrl).then((r) => r.ok ? r.json() : Promise.reject(r.status)).then((f) => {
      if (req !== pointReq) return;
      renderForecast(f);
    }).catch(() => {
      if (req !== pointReq) return;
      $("#ptNow").innerHTML = '<p class="err">No se pudo cargar el pronóstico. Toca el punto otra vez para reintentar.</p>';
      $("#ptMeta").textContent = "";
    });

    fetch(cUrl).then((r) => r.ok ? r.json() : Promise.reject(r.status)).then((c) => {
      if (req !== pointReq) return;
      renderClimate(c);
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
    const s = [1, 2, 2.5, 5, 10].find((k) => k * p >= v) * p;
    return s;
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
    const ticks = [lo, Math.round((lo + hi) / 2), hi];
    ticks.forEach((t) => {
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
    const x = Math.min(window.innerWidth - w - 8, Math.max(8, e.clientX - w / 2));
    tipEl.style.left = `${x}px`;
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
  setBase(baseKey);
  renderPanel();
})();
