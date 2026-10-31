/* Red de estaciones: ubicación, área de influencia y valores que reporta cada estación.
   - IMN: las 153 estaciones automáticas publicadas (7 regiones climáticas). Las que comparten sitio
     (aeropuertos con varias pistas) se agrupan en un solo punto.
   - IMHPA (Panamá): estaciones del occidente con lluvia de 24 horas.
   Área de influencia: la zona más cercana a cada estación que a cualquier otra (polígonos de Thiessen),
   limitada a 25 km a la redonda. Se colorea con el valor que reporta la estación. */
(function () {
  "use strict";
  const C = window.Celeste;
  if (!C) return;
  const { map, $ } = C;
  const H1 = 3600000;
  const RADIO_KM = 25;
  const KX = 111.32 * Math.cos(9.8 * Math.PI / 180), KY = 110.6;
  const toXY = (lat, lon) => [(lon + 84) * KX, (lat - 9.8) * KY];
  const toLL = ([x, y]) => [y / KY + 9.8, x / KX - 84];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- Variables que publican las tablas del IMN ----------
  const KT = 1.852;
  const VARS = [
    { re: /^temp/i, k: "temp", label: "Temperatura", unit: "°C", fmt: (v) => C.fmtNum1.format(v) },
    { re: /lluvia/i, k: "rain", label: "Lluvia en la hora", unit: "mm", fmt: (v) => C.fmtNum1.format(v) },
    { re: /^velocidad/i, k: "wind", label: "Viento", unit: "km/h", conv: (v) => v * KT, fmt: (v) => C.fmtNum.format(v) },
    { re: /^direcci/i, k: "dir", label: "Dirección del viento", unit: "", fmt: (v) => `${cardinal(v)} (${C.fmtNum.format(v)}°)` },
    { re: /^vpmax/i, k: "gust", label: "Ráfaga máxima", unit: "km/h", conv: (v) => v * KT, fmt: (v) => C.fmtNum.format(v) },
    { re: /^qnh/i, k: "qnh", label: "Presión a nivel del mar (QNH)", unit: "hPa", conv: (v) => (v < 40 ? v * 33.8639 : v), fmt: (v) => C.fmtNum1.format(v) },
    { re: /^(p[ _]?atm|pres)/i, k: "pres", label: "Presión en la estación", unit: "hPa", fmt: (v) => C.fmtNum1.format(v) },
    { re: /^rad[_ ]?max/i, k: "rad", label: "Radiación solar máxima", unit: "kW/m²", fmt: (v) => C.fmtNum2 ? C.fmtNum2.format(v) : v.toFixed(2) },
    { re: /^rad[_ ]?neta/i, k: "radn", label: "Radiación neta", unit: "W/m²", fmt: (v) => C.fmtNum.format(v) },
    { re: /^albedo/i, k: "alb", label: "Albedo", unit: "", fmt: (v) => v.toFixed(2) },
  ];
  const varOf = (col) => VARS.find((d) => d.re.test(col)) || { k: col, label: col, unit: "", fmt: (v) => C.fmtNum1.format(v) };
  const DIRS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
  const cardinal = (d) => DIRS[Math.round(((d % 360) + 360) % 360 / 45) % 8];

  const RAIN = C.PAL.rain.colors;
  const MODES = {
    rain1: { label: "Lluvia última hora", p: { levels: [0.5, 1, 2, 4, 8, 15, 30, 50], colors: RAIN, units: "mm en la última hora medida", fmt: C.fmtNum1 } },
    rain24: { label: "Lluvia 24 h", p: { levels: [1, 5, 10, 20, 40, 60, 90, 120], colors: RAIN, units: "mm en las últimas 24 horas", fmt: C.fmtNum } },
    temp: { label: "Temperatura", p: { levels: C.steps(10, 34, 2), colors: C.ramp(["#3c6fb0", "#7fb0d8", "#cfe6cf", "#f2d57c", "#ea9150", "#c4452f", "#8e1f2a"], 13), units: "°C", clamp: true, fmt: C.fmtNum } },
  };
  const DRY = "#dfe7ee";

  // ---------- Geometría: Thiessen limitado a un círculo ----------
  function circle(cx, cy, r, n = 56) {
    const out = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    return out;
  }
  // Conserva la mitad del plano más cercana a p que a q
  function clipHalf(poly, p, q) {
    const nx = q[0] - p[0], ny = q[1] - p[1];
    const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
    const side = (v) => (v[0] - mx) * nx + (v[1] - my) * ny;
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const sa = side(a), sb = side(b);
      if (sa <= 0) out.push(a);
      if ((sa <= 0) !== (sb <= 0)) { const t = sa / (sa - sb); out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]); }
    }
    return out;
  }
  function cells(sites) {
    const xy = sites.map((s) => toXY(s.lat, s.lon));
    return xy.map((p, i) => {
      let poly = circle(p[0], p[1], RADIO_KM);
      xy.forEach((q, j) => {
        if (j === i || poly.length < 3) return;
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d > 0.05 && d < RADIO_KM * 2) poly = clipHalf(poly, p, q);
      });
      return poly.length >= 3 ? poly.map(toLL) : null;
    });
  }
  function areaKm2(ll) {
    if (!ll) return 0;
    const xy = ll.map(([la, lo]) => toXY(la, lo));
    let a = 0;
    for (let i = 0; i < xy.length; i++) { const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length]; a += x1 * y2 - x2 * y1; }
    return Math.abs(a / 2);
  }

  // ---------- Regiones climáticas del IMN (SNIT) ----------
  let regions = null;
  async function loadRegions() {
    if (regions) return regions;
    regions = await fetch("/api/imn/regiones").then((r) => r.json()).catch(() => ({ features: [] }));
    return regions;
  }
  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function regionOf(lat, lon) {
    if (!regions || !regions.features) return null;
    let best = null, bd = Infinity;
    for (const f of regions.features) {
      for (const poly of f.geometry.coordinates) {
        if (!poly[0]) continue;
        if (inRing(lon, lat, poly[0]) && !poly.slice(1).some((h) => inRing(lon, lat, h))) return f.properties.region;
        // Estaciones sobre la costa: la región más cercana
        for (const [x, y] of poly[0]) { const d = (x - lon) ** 2 + (y - lat) ** 2; if (d < bd) { bd = d; best = f.properties.region; } }
      }
    }
    return best;
  }

  // ---------- Estaciones del IMN agrupadas por sitio ----------
  function siteName(names) {
    if (names.length === 1) return names[0];
    let pre = names[0];
    names.forEach((n) => { while (!n.startsWith(pre)) pre = pre.slice(0, -1); });
    pre = pre.replace(/[\s\d(]+$/, "").trim();
    return pre.length > 4 ? pre : names[0];
  }
  function summarize(st) {
    const latest = st.filas[0];
    const t = latest ? latest[0] : null;
    const vals = [];
    if (latest) st.cols.forEach((col, i) => {
      const v = latest[i + 1];
      if (v == null) return;
      const d = varOf(col);
      vals.push({ k: d.k, label: d.label, unit: d.unit, v: d.conv ? d.conv(v) : v, fmt: d.fmt });
    });
    const out = { t, vals };
    if (st.rows.length && t) {
      out.rain1 = st.rows[0][1];
      out.rain6 = C.stations.accum(st, 6, t);
      out.rain24 = C.stations.accum(st, 24, t);
    }
    const tv = vals.find((v) => v.k === "temp");
    if (tv) out.temp = tv.v;
    return out;
  }
  // Mismo sitio = mismas coordenadas y mismo nombre base (p. ej. las pistas de un aeropuerto)
  const baseName = (n) => n.replace(/\s*\(DA\)\s*$/i, "").replace(/\s+\d{2}$/, "").trim();
  function buildSites(all) {
    const bySite = new Map();
    all.forEach((s) => {
      const key = `${s.lat.toFixed(3)},${s.lon.toFixed(3)},${baseName(s.n)}`;
      if (!bySite.has(key)) bySite.set(key, { lat: s.lat, lon: s.lon, lat0: s.lat, lon0: s.lon, approx: !s.q, members: [] });
      bySite.get(key).members.push(s);
    });
    // Estaciones distintas con la misma ubicación aproximada (centro del cantón): se separan en un anillo
    // de 2,5 km para que cada una tenga su punto y su área
    const byXY = new Map();
    bySite.forEach((site) => { const k = `${site.lat.toFixed(3)},${site.lon.toFixed(3)}`; (byXY.get(k) || byXY.set(k, []).get(k)).push(site); });
    byXY.forEach((list) => {
      if (list.length < 2) return;
      list.forEach((site, i) => {
        const a = (i / list.length) * 2 * Math.PI + 0.4;
        site.lat += (2.5 * Math.sin(a)) / KY;
        site.lon += (2.5 * Math.cos(a)) / KX;
        site.approx = true;
      });
    });
    const now = Date.now();
    return [...bySite.values()].map((site) => {
      site.n = siteName(site.members.map((m) => m.n));
      site.members.forEach((m) => { m.sum = m.filas.length ? summarize(m) : null; });
      const withData = site.members.filter((m) => m.sum && m.sum.t);
      site.t = withData.length ? Math.max(...withData.map((m) => m.sum.t)) : null;
      site.fresh = site.t && now - site.t <= 2.5 * H1;
      site.status = !site.members.some((m) => m.t) ? "sin-tabla" : !site.t ? "sin-datos" : site.fresh ? "al-dia" : "atrasada";
      // Valor de la capa: la primera estación al día que lo mida
      const pick = (k) => { for (const m of withData) if (m.sum[k] != null && site.fresh && now - m.sum.t <= 2.5 * H1) return m.sum[k]; return null; };
      site.rain1 = pick("rain1");
      site.rain24 = pick("rain24");
      site.temp = pick("temp");
      site.region = regionOf(site.lat, site.lon);
      return site;
    });
  }

  // ---------- Capas ----------
  map.createPane("redimn").style.zIndex = 457;
  map.getPane("redimn").classList.add("capa-datos", "capa-red");
  map.createPane("redpa").style.zIndex = 456;
  map.getPane("redpa").classList.add("capa-datos", "capa-red");
  map.createPane("referencia").style.zIndex = 458;
  map.getPane("referencia").style.pointerEvents = "none";
  const rendIMN = L.canvas({ pane: "redimn", padding: 0.3 }).addTo(map);
  const rendPA = L.canvas({ pane: "redpa", padding: 0.3 }).addTo(map);

  // Etiquetas con el valor solo al acercarse
  const syncLabels = () => map.getContainer().classList.toggle("ver-etiquetas", map.getZoom() >= 10);
  map.on("zoomend", syncLabels);
  syncLabels();

  const fmtTime = (t) => (t ? `${C.isToday(new Date(t)) ? "" : `${C.fmtDay.format(new Date(t))}, `}${C.fmtHour.format(new Date(t))}` : "—");
  const STATUS = { "al-dia": "Al día", atrasada: "Sin datos recientes", "sin-datos": "Tabla sin datos", "sin-tabla": "Sin tabla pública" };

  function hoverLabel(m) {
    const el = () => m.getTooltip() && m.getTooltip().getElement();
    m.on("mouseover", () => el() && el().classList.add("leaflet-tooltip-hover"));
    m.on("mouseout", () => el() && el().classList.remove("leaflet-tooltip-hover"));
  }
  // Valor de una estación para la hora elegida en la línea de tiempo (null = lo más reciente)
  const near10 = (rows, t) => rows.find((r) => Math.abs(r[0] - t) < 10 * 60000);
  function at(site, mode, t) {
    if (t == null) return site[mode];
    for (const m of site.members || [site]) {
      if (mode === "temp") {
        if (m.filas && m.cols) { const iT = m.cols.findIndex((c) => /^temp/i.test(c)); const r = iT >= 0 && near10(m.filas, t); if (r && r[iT + 1] != null) return r[iT + 1]; }
        continue;
      }
      if (!m.rows || !m.rows.length) continue;
      if (mode === "rain1") { const r = near10(m.rows, t); if (r && r[1] != null) return r[1]; }
      if (mode === "rain24" && near10(m.rows, t)) { const v = C.stations.accum(m, 24, t); if (v != null) return v; }
    }
    return null;
  }
  function valueOf(site, mode) { return at(site, mode, imn.t); }
  function colorOf(site, mode) {
    const v = valueOf(site, mode);
    if (v == null) return null;
    return C.bandColor(MODES[mode].p, v) || (mode === "temp" ? MODES.temp.p.colors[0] : DRY);
  }
  function labelOf(v, mode) {
    if (v == null) return "–";
    return mode === "temp" ? `${C.fmtNum.format(v)}°` : C.fmtNum1.format(v);
  }

  // ----- IMN -----
  const imn = { on: false, mode: "rain1", group: null, sites: null, cells: null, box: null, t: null };

  function popupIMN(site) {
    const st = STATUS[site.status];
    const rows = site.members.map((m) => {
      const s = m.sum;
      const head = site.members.length > 1 ? `<div class="pop-sub">${esc(m.n)}</div>` : "";
      if (!m.t) return `${head}<p class="pop-note">El IMN no publica la tabla de esta estación.</p>`;
      if (!s) return `${head}<p class="pop-note">La tabla no trae datos ahora.</p>`;
      const old = Date.now() - s.t > 2.5 * H1;
      let h = `${head}<div class="pop-time${old ? " viejo" : ""}">Dato de ${fmtTime(s.t)}${old ? ` · hace ${C.ago(new Date(s.t))}` : ""}</div><table class="pop-vals">`;
      if (s.rain1 != null) h += `<tr><td>Lluvia última hora / 6 h / 24 h</td><td><b>${C.fmtNum1.format(s.rain1)}</b> / ${s.rain6 != null ? C.fmtNum1.format(s.rain6) : "–"} / ${s.rain24 != null ? C.fmtNum1.format(s.rain24) : "–"} mm</td></tr>`;
      s.vals.filter((v) => v.k !== "rain").forEach((v) => { h += `<tr><td>${v.label}</td><td><b>${v.fmt(v.v)}</b>${v.unit ? ` ${v.unit}` : ""}</td></tr>`; });
      return h + "</table>";
    }).join("");
    return `<div class="pop">
      <div class="pop-head">${ICON_IMN}<div><b>${esc(site.n)}</b><div class="pop-meta">IMN · ${esc(site.region || "Costa Rica")} · <span class="st st-${site.status}">${st}</span></div></div></div>
      ${rows}
      <div class="pop-foot">Área de influencia: ${C.fmtNum.format(site.area)} km² · ${site.approx ? "ubicación aproximada (el IMN no publica coordenadas; se ubicó por nombre y cantón)" : `${site.lat0.toFixed(4)}, ${site.lon0.toFixed(4)}`}<br>Datos preliminares del IMN, sin control de calidad.</div>
    </div>`;
  }

  function drawIMN() {
    if (imn.group) map.removeLayer(imn.group);
    if (!imn.on || !imn.sites) return;
    const g = L.layerGroup();
    const mode = imn.mode;
    imn.sites.forEach((site, i) => {
      const cell = imn.cells[i];
      const c = colorOf(site, mode);
      if (cell) L.polygon(cell, { pane: "redimn", renderer: rendIMN, interactive: false, fillColor: c || "#9aa7b2", fillOpacity: c ? (site.approx ? 0.45 : 0.62) : 0.12, color: "#ffffff", weight: 0.9, opacity: 0.9, dashArray: c ? null : "3 3" }).addTo(g);
    });
    imn.sites.forEach((site) => {
      const v = valueOf(site, mode), c = colorOf(site, mode);
      const ok = imn.t == null ? site.status === "al-dia" : v != null;
      const m = L.circleMarker([site.lat, site.lon], {
        pane: "redimn", renderer: rendIMN, bubblingMouseEvents: false, radius: site.members.length > 1 ? 6.5 : 5,
        fillColor: c || "#ffffff", fillOpacity: 1, color: ok ? "#173247" : "#8796a3", weight: ok ? 1.6 : 1.2, dashArray: ok ? null : "2 2",
      });
      m.bindTooltip(`${labelOf(v, mode)}`, { permanent: true, direction: "right", offset: [6, 0], className: "est-lbl" });
      m.bindPopup(() => popupIMN(site), { maxWidth: 320, className: "pop-est" });
      hoverLabel(m);
      m.addTo(g);
    });
    imn.group = g.addTo(map);
  }

  function imnSummary() {
    const s = imn.sites;
    const nSt = s.reduce((a, x) => a + x.members.length, 0);
    const by = (k) => s.filter((x) => x.status === k).reduce((a, x) => a + x.members.length, 0);
    const reg = {};
    s.forEach((x) => { const r = x.region || "Sin región"; reg[r] = (reg[r] || 0) + x.members.length; });
    const order = ["Pacífico Norte", "Pacífico Central", "Pacífico Sur", "Valle Central", "Zona Norte", "Caribe Norte", "Caribe Sur"];
    const regs = Object.entries(reg).sort((a, b) => (order.indexOf(a[0]) + 99) % 99 - (order.indexOf(b[0]) + 99) % 99);
    return `<p class="stamp"><b>${nSt}</b> estaciones en ${s.length} sitios: <b>${by("al-dia")}</b> al día, ${by("atrasada") + by("sin-datos")} sin datos recientes, ${by("sin-tabla")} sin tabla pública.</p>
      <div class="reg-list">${regs.map(([r, n]) => `<span>${esc(r)} <b>${n}</b></span>`).join("")}</div>`;
  }

  async function loadIMN() {
    const [data] = await Promise.all([C.stations.load(), loadRegions()]);
    imn.sites = buildSites(data.all);
    imn.cells = cells(imn.sites);
    imn.sites.forEach((s, i) => { s.area = areaKm2(imn.cells[i]); });
  }

  // Horas con datos (últimas 24) → fila en la línea de tiempo
  function hoursOf(list) {
    const cnt = new Map();
    const from = Date.now() - 24.5 * H1;
    list.forEach((m) => (m.rows || []).forEach(([t]) => { if (t >= from) { const h = Math.round(t / H1) * H1; cnt.set(h, (cnt.get(h) || 0) + 1); } }));
    const max = Math.max(1, ...cnt.values());
    return [...cnt.entries()].filter(([, n]) => n >= Math.max(3, max * 0.3)).map(([t]) => t);
  }
  function registerIMN() {
    const members = imn.sites.flatMap((x) => x.members);
    const times = hoursOf(members);
    const latest = Math.max(...times);
    const wet = new Map(times.map((t) => [t, members.filter((m) => { const r = m.rows && near10(m.rows, t); return r && r[1] >= 0.5; }).length]));
    const maxWet = Math.max(1, ...wet.values());
    C.time.register("redimn", {
      label: "Estaciones automáticas del IMN", short: "IMN", icon: C.icon("station"), order: 2, times, tol: 35 * 60000, step: H1,
      value: (t) => wet.get(t) / maxWet,
      show: (t) => { imn.t = t >= latest ? null : t; drawIMN(); },
    });
  }

  function modeButtons(cur) {
    return `<div class="seg red-seg" role="radiogroup" aria-label="Valor que colorea las áreas">${Object.entries(MODES).map(([k, m]) => `<button type="button" role="radio" data-rm="${k}" aria-checked="${k === cur}">${m.label}</button>`).join("")}</div>`;
  }

  C.ext = C.ext || {};
  C.ext.redimn = async (on, box) => {
    imn.on = on;
    imn.box = box;
    const extra = $(".layer-extra", box);
    if (on && !extra.dataset.ready) {
      extra.dataset.ready = "1";
      extra.insertAdjacentHTML("afterbegin", `${modeButtons(imn.mode)}<div class="red-legend">${C.legendHTML(MODES[imn.mode].p)}</div><div class="red-sum"><p class="stamp">Cargando las 153 estaciones…</p></div>
        <p class="layer-desc">Cada área es la zona más cercana a esa estación (hasta 25 km). Toca un punto para ver todo lo que reporta. Borde punteado: sin datos recientes.</p>`);
      extra.addEventListener("click", (e) => {
        const b = e.target.closest("[data-rm]");
        if (!b) return;
        imn.mode = b.dataset.rm;
        extra.querySelectorAll("[data-rm]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
        $(".red-legend", extra).innerHTML = C.legendHTML(MODES[imn.mode].p);
        drawIMN();
      });
    }
    if (!on) { if (imn.group) map.removeLayer(imn.group); C.time.unregister("redimn"); imn.t = null; return; }
    try {
      if (!imn.sites || Date.now() - (imn.at || 0) > 10 * 60000) { await loadIMN(); imn.at = Date.now(); }
      drawIMN();
      $(".red-sum", extra).innerHTML = imnSummary();
      registerIMN();
    } catch (e) {
      console.error("red IMN", e);
      $(".red-sum", extra).innerHTML = `<p class="stamp">No se pudieron cargar las estaciones del IMN.</p>`;
    }
  };

  // ----- Panamá (IMHPA) -----
  const pa = { on: false, group: null, sites: null, cells: null, t: null };
  const PA_VARS = [
    ["temp", "Temperatura", (v) => `${C.fmtNum1.format(v)} °C`],
    ["hr", "Humedad relativa", (v) => `${C.fmtNum.format(v)} %`],
    ["viento", "Viento", (v) => `${C.fmtNum.format(v * 3.6)} km/h`],
    ["dir", "Dirección del viento", (v) => `${cardinal(v)} (${C.fmtNum.format(v)}°)`],
    ["rafaga", "Ráfaga", (v) => `${C.fmtNum.format(v * 3.6)} km/h`],
    ["pres", "Presión en la estación", (v) => `${C.fmtNum1.format(v)} hPa`],
    ["rad", "Radiación solar", (v) => `${C.fmtNum.format(v)} W/m²`],
  ];
  function paValue(s) {
    if (pa.t == null) return s.rows.length ? C.stations.accum(s, 24, s.rows[0][0]) ?? s.mm : s.mm;
    if (!s.rows.length || !near10(s.rows, pa.t)) return null;
    return C.stations.accum(s, 24, pa.t);
  }
  function popupPA(s) {
    const v = s.v || {};
    let rows = "";
    if (s.rows.length) {
      const t = s.rows[0][0];
      rows += `<tr><td>Lluvia última hora / 6 h / 24 h</td><td><b>${C.fmtNum1.format(s.rows[0][1])}</b> / ${C.fmtNum1.format(C.stations.accum(s, 6, t) || 0)} / ${C.fmtNum1.format(C.stations.accum(s, 24, t) || 0)} mm</td></tr>`;
    } else if (s.mm != null) rows += `<tr><td>Lluvia de las últimas 24 horas</td><td><b>${C.fmtNum1.format(s.mm)}</b> mm</td></tr>`;
    PA_VARS.forEach(([k, label, f]) => { if (v[k] && v[k][0] != null) rows += `<tr><td>${label}</td><td><b>${f(v[k][0])}</b></td></tr>`; });
    return `<div class="pop"><div class="pop-head">${ICON_PA}<div><b>${esc(s.n.replace(/\s*\([\d-]+\)$/, ""))}</b><div class="pop-meta">IMHPA · Panamá · <span class="st st-${s.fresh ? "al-dia" : "atrasada"}">${s.fresh ? "Al día" : "Sin datos recientes"}</span></div></div></div>
      <div class="pop-time">Dato de ${fmtTime(s.rows.length ? s.rows[0][0] : s.time)}</div>
      <table class="pop-vals">${rows}</table>
      <div class="pop-foot">Área de influencia: ${C.fmtNum.format(s.area)} km²${s.dCR != null && s.dCR < 40 ? ` · a ${C.fmtNum.format(s.dCR)} km de Costa Rica` : ""}<br>Fuente: IMHPA (Ley 209 de 2021).</div></div>`;
  }
  const RIO_ICON = (lvl) => L.divIcon({ className: "rio-ico", html: `<span title="Nivel del río">${lvl}</span>`, iconSize: null });
  function drawPA() {
    if (pa.group) map.removeLayer(pa.group);
    if (!pa.on || !pa.sites) return;
    const g = L.layerGroup();
    const p = MODES.rain24.p;
    const vals = pa.sites.map(paValue);
    pa.sites.forEach((s, i) => {
      const c = vals[i] != null && (pa.t != null || s.fresh) ? C.bandColor(p, vals[i]) || DRY : null;
      if (pa.cells[i]) L.polygon(pa.cells[i], { pane: "redpa", renderer: rendPA, interactive: false, fillColor: c || "#9aa7b2", fillOpacity: c ? 0.62 : 0.12, color: "#ffffff", weight: 0.9, opacity: 0.9, dashArray: c ? null : "3 3" }).addTo(g);
    });
    pa.sites.forEach((s, i) => {
      const ok = vals[i] != null && (pa.t != null || s.fresh);
      const c = ok ? C.bandColor(p, vals[i]) || DRY : null;
      const m = L.circleMarker([s.lat, s.lon], { pane: "redpa", renderer: rendPA, bubblingMouseEvents: false, radius: 5, fillColor: c || "#fff", fillOpacity: 1, color: ok ? "#173247" : "#8796a3", weight: 1.6, dashArray: ok ? null : "2 2" });
      m.bindTooltip(vals[i] != null ? C.fmtNum1.format(vals[i]) : "–", { permanent: true, direction: "right", offset: [6, 0], className: "est-lbl" });
      hoverLabel(m);
      m.bindPopup(() => popupPA(s), { maxWidth: 320, className: "pop-est" });
      m.addTo(g);
    });
    // Niveles de ríos y embalses
    (pa.rios || []).forEach(([n, lat, lon, v, unit, iso]) => {
      const embalse = /msnm/i.test(unit || "");
      const txt = v == null ? "–" : `${C.fmtNum1.format(v)} ${embalse ? "msnm" : "m"}`;
      L.marker([lat, lon], { pane: "redpa", icon: RIO_ICON(txt), bubblingMouseEvents: false })
        .bindPopup(`<div class="pop"><div class="pop-head"><span class="pop-ico">${C.icon("wave")}</span><div><b>${esc(n.replace(/\s*\([\d-]+\)$/, ""))}</b><div class="pop-meta">IMHPA · ${embalse ? "nivel de embalse" : "nivel del río"}</div></div></div>
          <div class="pop-time">Dato de ${fmtTime(iso ? Date.parse(iso) : null)}</div>
          <table class="pop-vals"><tr><td>${embalse ? "Nivel del embalse" : "Nivel del río"}</td><td><b>${txt}</b></td></tr></table>
          <div class="pop-foot">Fuente: IMHPA (Ley 209 de 2021).</div></div>`, { maxWidth: 300, className: "pop-est" })
        .addTo(g);
    });
    pa.group = g.addTo(map);
  }
  // Distancia aproximada a Costa Rica (frontera como línea recta de Sixaola a Punta Burica)
  const B1 = toXY(9.57, -82.56), B2 = toXY(8.03, -82.89);
  function distCR(lat, lon) {
    const [x, y] = toXY(lat, lon), [ax, ay] = B1, [bx, by] = B2;
    const t = clamp01(((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2));
    return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
  }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  C.ext.redpa = async (on, box) => {
    pa.on = on;
    const extra = $(".layer-extra", box);
    if (on && !extra.dataset.ready) {
      extra.dataset.ready = "1";
      extra.insertAdjacentHTML("afterbegin", `<div class="red-legend">${C.legendHTML(MODES.rain24.p)}</div><p class="stamp pa-stamp">Cargando estaciones de Panamá…</p>
        <p class="layer-desc">Áreas coloreadas con la lluvia de 24 horas. Toca una estación para ver todas sus variables; los rótulos azules son niveles de ríos y embalses. Su lluvia por hora entra en la superficie horaria y en el índice.</p>`);
    }
    if (!on) { if (pa.group) map.removeLayer(pa.group); C.time.unregister("redpa"); pa.t = null; return; }
    try {
      const data = await C.stations.load();
      const now = Date.now();
      pa.sites = data.pa.map((s) => Object.assign(s, { fresh: (s.rows.length ? s.rows[0][0] : s.time) && now - (s.rows.length ? s.rows[0][0] : s.time) <= 6 * H1, dCR: distCR(s.lat, s.lon) }));
      pa.rios = data.rios;
      pa.cells = cells(pa.sites);
      pa.sites.forEach((s, i) => { s.area = areaKm2(pa.cells[i]); });
      drawPA();
      const nf = pa.sites.filter((s) => s.fresh).length, nh = pa.sites.filter((s) => s.rows.length).length, nb = pa.sites.filter((s) => s.dCR < 40).length;
      $(".pa-stamp", box).textContent = `${pa.sites.length} estaciones (${nb} a menos de 40 km de Costa Rica), ${nf} al día, ${nh} con lluvia por hora, y ${pa.rios.length} niveles de ríos y embalses.`;
      const times = hoursOf(pa.sites);
      if (times.length) {
        const latest = Math.max(...times);
        C.time.register("redpa", {
          label: "Estaciones de Panamá (IMHPA)", short: "IMHPA", icon: C.icon("station"), order: 4, times, tol: 35 * 60000, step: H1,
          show: (t) => { pa.t = t >= latest ? null : t; drawPA(); },
        });
      }
    } catch (e) {
      console.error("red PA", e);
      $(".pa-stamp", box).textContent = "No se pudieron cargar las estaciones de Panamá.";
    }
  };

  // ----- Regiones climáticas (referencia) -----
  let regLayer = null;
  C.ext.regiones = async (on, box) => {
    const extra = $(".layer-extra", box);
    if (on && !extra.dataset.ready) { extra.dataset.ready = "1"; extra.insertAdjacentHTML("afterbegin", `<p class="stamp reg-stamp">Cargando regiones…</p>`); }
    if (!on) { if (regLayer) map.removeLayer(regLayer); return; }
    const fc = await loadRegions();
    if (regLayer) map.removeLayer(regLayer);
    regLayer = L.geoJSON(fc, { pane: "referencia", interactive: false, style: { fill: false, color: "#40576b", weight: 1.6, opacity: 0.85, dashArray: "6 4" } });
    // Nombre de cada región en su polígono más grande (una región puede venir en varias piezas)
    const big = new Map();
    fc.features.forEach((f) => f.geometry.coordinates.forEach((poly) => {
      if (!poly[0]) return;
      const a = areaKm2(poly[0].map(([x, y]) => [y, x]));
      const r = f.properties.region;
      if (!big.has(r) || a > big.get(r).a) big.set(r, { a, ring: poly[0] });
    }));
    big.forEach(({ ring }, r) => {
      const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length, lon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
      L.marker([lat, lon], { pane: "referencia", interactive: false, icon: L.divIcon({ className: "reg-lbl", html: `<span>${esc(r)}</span>`, iconSize: null }) }).addTo(regLayer);
    });
    fc.nReg = big.size;
    regLayer.addTo(map);
    $(".reg-stamp", box).textContent = fc.features.length ? `${fc.nReg} regiones climáticas oficiales del IMN (SNIT).` : "El SNIT no respondió.";
  };

  // ---------- Al tocar el mapa: la estación cuya área contiene el punto ----------
  C.pointHooks.push((lat, lng) => {
    if (document.body.classList.contains("modo-indice")) return "";
    const near = (list) => {
      if (!list) return null;
      let b = null, bd = Infinity;
      const [x, y] = toXY(lat, lng);
      list.forEach((s) => { const [sx, sy] = toXY(s.lat, s.lon); const d = Math.hypot(sx - x, sy - y); if (d < bd) { bd = d; b = s; } });
      return bd <= RADIO_KM ? { s: b, d: bd } : null;
    };
    let h = "";
    const a = imn.on && near(imn.sites);
    if (a) {
      const s = a.s, t = imn.t;
      const r1 = at(s, "rain1", t), r24 = at(s, "rain24", t), tp = at(s, "temp", t);
      const when = t == null ? "última hora" : `hora que termina a las ${C.fmtHour.format(new Date(t))}`;
      h += `<h3>Estación del IMN más cercana${t == null ? "" : ` · ${C.fmtHour.format(new Date(t))}`}</h3><div class="values">
        <div class="value-row"><span class="swatch" style="background:${colorOf(s, imn.mode) || "transparent"}"></span><span class="value-name">${esc(s.n)} (${esc(s.region || "")}), a ${C.fmtNum.format(a.d)} km</span><b>${t == null ? STATUS[s.status] : r1 != null ? "Con dato" : "Sin dato a esa hora"}</b></div>
        ${r1 != null ? `<div class="value-row"><span class="swatch"></span><span class="value-name">Lluvia (${when}) / 24 h</span><b>${C.fmtNum1.format(r1)} / ${r24 != null ? C.fmtNum1.format(r24) : "–"} mm</b></div>` : ""}
        ${tp != null ? `<div class="value-row"><span class="swatch"></span><span class="value-name">Temperatura</span><b>${C.fmtNum1.format(tp)} °C</b></div>` : ""}
      </div>`;
    }
    const b = pa.on && near(pa.sites);
    if (b) {
      const s = b.s, t = pa.t;
      const r1 = s.rows.length ? (t == null ? s.rows[0][1] : (near10(s.rows, t) || [])[1]) : null;
      const r24 = t == null ? (s.rows.length ? C.stations.accum(s, 24, s.rows[0][0]) : s.mm) : paValue(s);
      h += `<h3>Estación de Panamá más cercana${t == null ? "" : ` · ${C.fmtHour.format(new Date(t))}`}</h3><div class="values">
        <div class="value-row"><span class="swatch"></span><span class="value-name">${esc(s.n.replace(/\s*\([\d-]+\)$/, ""))}, a ${C.fmtNum.format(b.d)} km</span><b>${r24 != null ? `${C.fmtNum1.format(r24)} mm en 24 h` : "Sin dato"}</b></div>
        ${r1 != null ? `<div class="value-row"><span class="swatch"></span><span class="value-name">Lluvia en la hora</span><b>${C.fmtNum1.format(r1)} mm</b></div>` : ""}
      </div>`;
    }
    return h;
  });

  const ICON_IMN = `<span class="pop-ico">${(C.icon && C.icon("station")) || ""}</span>`;
  const ICON_PA = ICON_IMN;
})();
