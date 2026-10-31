/* Radar del IMN (Aranjuez, Valle Central)
   El IMN publica una imagen (1152×1152) con su producto de radar. Aquí se:
   1. decodifican sus colores con la escala de la propia imagen (dBZ),
   2. georreferencia (proyección azimutal centrada en el radar, 4,14 px/km, ajustada contra fronteras y costas),
   3. convierte a lluvia en mm/h con la misma relación Z-R que el radar de COCESNA,
   4. remuestrea a la misma rejilla de ~1 km y se suaviza igual que el de COCESNA.
   Así ambos radares quedan en la misma unidad, escala de color y estilo, y pueden combinarse. */
(function () {
  "use strict";
  const C = window.Celeste;
  if (!C) return;
  const { map, $ } = C;

  const SITE = [9.9373, -84.0685]; // IMN, barrio Aranjuez
  const GEO = { cx: 573, cy: 572.5, pxPerKm: 4.14 };
  const RANGE_KM = 118; // alcance útil (círculo de la imagen)
  const FRESH_MIN = 30; // una imagen más vieja no se usa en el índice
  const KX = 111.32 * Math.cos(SITE[0] * Math.PI / 180), KY = 110.6;

  // Escala de la imagen: color de cada casilla → dBZ (punto medio de la casilla)
  const SCALE = [
    [[0, 255, 255], 7.5], [[0, 255, 128], 11.5], [[0, 255, 0], 15.5], [[0, 180, 0], 20.5], [[0, 153, 36], 25.5],
    [[255, 254, 2], 30.5], [[251, 204, 0], 35.5], [[252, 174, 0], 40.5], [[255, 85, 2], 45.5], [[250, 3, 3], 50.5],
    [[255, 1, 98], 55.5], [[255, 0, 255], 60.5], [[252, 128, 255], 65.5],
  ];
  // Los dos tonos más pálidos (70–78 dBZ) se parecen al texto gris del mapa: se aceptan solo con coincidencia estrecha
  const PALE = [[[255, 199, 254], 70.5], [[255, 225, 252], 75.5]];

  function dbzOf(r, g, b) {
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    if (sat < 90) {
      for (const [c, v] of PALE) if (Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2]) < 24) return v;
      return null;
    }
    let best = null, bd = 70 * 70;
    for (const [c, v] of SCALE) {
      const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }
  const toRain = (dbz) => (dbz == null || dbz < 7 ? 0 : Math.pow(Math.pow(10, dbz / 10) / 200, 0.625));

  // Zonas de la imagen que no son radar: leyenda, botones, cuadro de información
  const excluded = (i, j) => i < 70 || (j > 1085 && i > 420 && i < 730) || (i > 975 && j > 1060);

  let state = null; // {grid, w, h, bbox, time, fresh, ageMin}
  let loadedAt = 0;

  async function load() {
    if (state && Date.now() - loadedAt < 2 * 60000) return state;
    const r = await fetch("/api/radar/imn", { cache: "no-store" });
    if (!r.ok) throw new Error("radar IMN");
    const lm = r.headers.get("X-Fecha-Imagen");
    const time = lm ? new Date(lm) : null;
    const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement("canvas"), { width: bmp.width, height: bmp.height });
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const iw = bmp.width, ih = bmp.height;
    const px = ctx.getImageData(0, 0, iw, ih).data;
    // 1) Máscara de lo que es mapa y no radar: textos (blancos/grises) y líneas (marrones, azules),
    //    ensanchada para cubrir los bordes de color que deja la compresión JPEG alrededor del texto
    const N0 = iw * ih;
    const base = new Uint8Array(N0);
    for (let q = 0, k = 0; q < N0; q++, k += 4) {
      const r = px[k], g = px[k + 1], b = px[k + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mn > 120 && mx - mn < 70) base[q] = 3; // texto
      else if (r > 90 && r < 230 && g > 50 && g < 150 && b < 110 && r - b > 50 && r > g && mx - mn < 150) base[q] = 1; // fronteras
      else if (b > 140 && r < 140 && g > 90 && g < 190 && b - r > 50) base[q] = 1; // ríos
    }
    const mask = new Uint8Array(N0);
    for (let j = 0; j < ih; j++) for (let i = 0; i < iw; i++) {
      const rr = base[j * iw + i];
      if (!rr) continue;
      for (let b = -rr; b <= rr; b++) for (let a = -rr; a <= rr; a++) {
        const y = j + b, x = i + a;
        if (x >= 0 && y >= 0 && x < iw && y < ih) mask[y * iw + x] = 1;
      }
    }
    // 2) Lluvia por píxel de la imagen (0,24 km)
    const dbz = new Float32Array(N0).fill(NaN);
    const rpx = RANGE_KM * GEO.pxPerKm;
    for (let j = 0; j < ih; j++) {
      for (let i = 0; i < iw; i++) {
        const q = j * iw + i;
        if (mask[q] || excluded(i, j) || Math.hypot(i - GEO.cx, j - GEO.cy) > rpx) continue;
        const k = q * 4;
        const v = dbzOf(px[k], px[k + 1], px[k + 2]);
        if (v != null) dbz[q] = v;
      }
    }
    // 3) Se descartan píxeles aislados: un eco real ocupa varias celdas vecinas
    const rain = new Float32Array(N0);
    for (let j = 1; j < ih - 1; j++) for (let i = 1; i < iw - 1; i++) {
      const q = j * iw + i;
      if (!Number.isFinite(dbz[q])) continue;
      let n = 0;
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) if ((a || b) && Number.isFinite(dbz[q + b * iw + a])) n++;
      if (n >= 4) rain[q] = toRain(dbz[q]);
    }
    // 2) a la rejilla común de ~1 km (la misma del radar de COCESNA), promediando 4×4 píxeles
    const A = C.RADAR_AREA, [x0, y0, x1, y1] = A.bbox;
    const grid = new Float32Array(A.w * A.h);
    const cover = new Float32Array(A.w * A.h);
    for (let y = 0; y < A.h; y++) {
      for (let x = 0; x < A.w; x++) {
        const X = x0 + ((x + 0.5) / A.w) * (x1 - x0), Y = y1 - ((y + 0.5) / A.h) * (y1 - y0);
        const [lat, lng] = C.unmerc(X, Y);
        const ex = (lng - SITE[1]) * KX, ey = (lat - SITE[0]) * KY;
        const dist = Math.hypot(ex, ey);
        if (dist > RANGE_KM) continue;
        const ci = GEO.cx + ex * GEO.pxPerKm, cj = GEO.cy - ey * GEO.pxPerKm;
        let s = 0, n = 0;
        for (let b = -2; b < 2; b++) for (let a = -2; a < 2; a++) {
          const i = Math.round(ci + a), j = Math.round(cj + b);
          if (i < 0 || j < 0 || i >= iw || j >= ih || excluded(i, j)) continue;
          s += rain[j * iw + i]; n++;
        }
        if (n) grid[y * A.w + x] = s / n;
        cover[y * A.w + x] = Math.max(0, Math.min(1, (RANGE_KM - dist) / 25)); // borde suave de 25 km
      }
    }
    const ageMin = time ? (Date.now() - time.getTime()) / 60000 : Infinity;
    state = { grid, cover, w: A.w, h: A.h, bbox: A.bbox, time, ageMin, fresh: ageMin <= FRESH_MIN };
    loadedAt = Date.now();
    return state;
  }

  // Combina con un campo de COCESNA en la misma rejilla (solo si la imagen del IMN está al día).
  // Dentro del alcance del IMN pesa más el radar cercano; devuelve también la relación en la zona común.
  function blend(coc) {
    if (!state || !state.fresh) return { grid: coc, used: false };
    const out = new Float32Array(coc.length);
    let sI = 0, sC = 0, n = 0;
    for (let k = 0; k < coc.length; k++) {
      const w = state.cover[k];
      const a = state.grid[k], b = coc[k];
      if (w > 0.5 && (a > 0.5 || b > 0.5)) { sI += a; sC += b; n++; }
      out[k] = w * a + (1 - w) * b;
    }
    return { grid: out, used: true, ratio: sC > 1 ? sI / sC : null, n };
  }

  C.imnRadar = { load, blend, get: () => state, SITE, RANGE_KM };

  // ---------- Capa ----------
  map.createPane("radarimn").style.zIndex = 432;
  map.getPane("radarimn").classList.add("capa-datos");
  map.getPane("radarimn").style.opacity = 0.8;
  const rend = L.canvas({ pane: "radarimn", padding: 0.4 }).addTo(map);
  let group = null;

  function draw(st) {
    if (group) map.removeLayer(group);
    group = L.layerGroup();
    const smooth = C.blur(st.grid, st.w, st.h, 1.3);
    L.geoJSON(C.polygons(smooth, st.w, st.h, st.bbox, C.PAL.rain), {
      pane: "radarimn", renderer: rend, interactive: false, smoothFactor: 0.4,
      style: (f) => ({ fillColor: f.properties.c, fillOpacity: 1, color: f.properties.c, weight: 0.8, opacity: 1 }),
    }).addTo(group);
    // Alcance del radar
    L.circle(SITE, { radius: RANGE_KM * 1000, pane: "radarimn", renderer: rend, fill: false, color: "#5d7488", weight: 1, dashArray: "4 4", interactive: false }).addTo(group);
    group.addTo(map);
  }

  C.ext = C.ext || {};
  C.ext.radarimn = async (on, box) => {
    const extra = $(".layer-extra", box);
    if (on && !extra.dataset.ready) {
      extra.insertAdjacentHTML("afterbegin", `<div class="imn-legend">${C.legendHTML(C.PAL.rain)}</div><p class="stamp">Cargando la imagen del IMN…</p><p class="imn-warn" hidden></p>`);
      extra.dataset.ready = "1";
    }
    if (!on) { if (group) map.removeLayer(group); return; }
    try {
      const st = await load();
      draw(st);
      const when = st.time ? st.time.toLocaleDateString("es-CR", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Costa_Rica" }) : "fecha desconocida";
      $(".stamp", box).textContent = st.fresh ? `Imagen de las ${C.fmtHour.format(st.time)} (${C.ago(st.time)}). Se combina con el radar de COCESNA en el índice.` : `Última actualización de la imagen del IMN: ${when}.`;
      const warn = $(".imn-warn", box);
      warn.hidden = st.fresh;
      warn.textContent = st.fresh ? "" : "El IMN no está actualizando esta imagen, así que lo que se ve no es lluvia actual y no se usa en el índice. Entrará sola cuando el IMN reanude la publicación.";
    } catch (e) {
      $(".stamp", box).textContent = "No se pudo leer la imagen del radar del IMN.";
    }
  };
})();
