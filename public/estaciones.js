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
  map.createPane("estaciones").style.zIndex = 460;
  map.getPane("estaciones").classList.add("capa-datos");

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

  function draw(data) {
    if (group) map.removeLayer(group);
    group = L.layerGroup();
    const p = PALS[hours];
    const now = Date.now();
    let nImn = 0, nPa = 0;
    data.imn.forEach((s) => {
      const latest = s.rows[0] && s.rows[0][0];
      if (!latest || now - latest > 3 * 3600000) return;
      const v = accum(s, hours, latest);
      if (v == null) return;
      nImn++;
      const c = C.bandColor(p, v);
      L.circleMarker([s.lat, s.lon], {
        pane: "estaciones", radius: v >= p.levels[0] ? 5 + Math.min(7, Math.sqrt(v) * 1.4) : 3.5,
        fillColor: c || "#ffffff", fillOpacity: c ? 0.95 : 0.85, color: c ? "#ffffff" : "#5d7488", weight: c ? 1.2 : 1, dashArray: s.q ? null : "2 2",
      }).bindTooltip(`<b>${s.n}</b><br>${C.fmtNum1.format(v)} ${p.units}<br><span class="muted">IMN, ${C.fmtHour.format(new Date(latest))}${s.q ? "" : ". Ubicación aproximada"}</span>`, { direction: "top" }).addTo(group);
    });
    if (hours === 24) {
      data.pa.forEach((s) => {
        if (s.mm == null || (s.time && now - s.time > 6 * 3600000)) return;
        nPa++;
        const c = C.bandColor(p, s.mm);
        L.circleMarker([s.lat, s.lon], {
          pane: "estaciones", radius: s.mm >= p.levels[0] ? 5 + Math.min(7, Math.sqrt(s.mm) * 1.4) : 3.5,
          fillColor: c || "#ffffff", fillOpacity: c ? 0.95 : 0.85, color: c ? "#ffffff" : "#5d7488", weight: c ? 1.2 : 1,
        }).bindTooltip(`<b>${s.n}</b><br>${C.fmtNum1.format(s.mm)} ${p.units}<br><span class="muted">IMHPA Panamá${s.time ? `, ${C.fmtHour.format(new Date(s.time))}` : ""}</span>`, { direction: "top" }).addTo(group);
      });
    }
    data.air.forEach((a) => {
      const txt = wxText(a.wx);
      const wet = txt !== "Sin lluvia" && txt !== "Neblina" && txt !== "Bruma";
      L.marker([a.lat, a.lon], {
        pane: "estaciones",
        icon: L.divIcon({ className: "", html: `<div class="apt${wet ? " apt-wet" : ""}">${a.id}</div>`, iconSize: [44, 18], iconAnchor: [22, 9] }),
        keyboard: false,
      }).bindTooltip(`<b>${a.nombre}</b><br>${txt}${a.temp != null ? `, ${a.temp} °C` : ""}<br><span class="muted">METAR, ${C.fmtHour.format(new Date(a.hora * 1000))}</span>`, { direction: "top" }).addTo(group);
    });
    if (active) group.addTo(map);
    const st = $(".stamp", box);
    if (st) st.textContent = `${nImn} estaciones del IMN${hours === 24 ? `, ${nPa} de Panamá` : ""} y ${data.air.length} aeropuertos. Datos preliminares en tiempo real.`;
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
      <p class="layer-desc">Borde punteado: ubicación aproximada. Panamá solo publica 24 horas. Los aeropuertos indican el estado del tiempo, no milímetros.</p>`;
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
