/* Barra de tiempo común: una fila por cada capa con tiempo y un cursor compartido.
   Cada capa se registra con sus horas disponibles y una función show(t) que dibuja la imagen más
   cercana a t. Si la capa no tiene dato cerca de la hora elegida, su fila se atenúa y se indica. */
(function () {
  "use strict";
  const MIN = 60000, H = 3600000;
  const TZ = "America/Costa_Rica";
  const fmtH = new Intl.DateTimeFormat("es-CR", { hour: "numeric", minute: "2-digit", timeZone: TZ });
  const fmtHH = new Intl.DateTimeFormat("es-CR", { hour: "numeric", timeZone: TZ });
  const fmtD = new Intl.DateTimeFormat("es-CR", { weekday: "short", day: "numeric", timeZone: TZ });
  const dayKey = (t) => new Date(t).toLocaleDateString("en-CA", { timeZone: TZ });
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const layers = new Map(); // key -> {label, icon, times, tol, show, value, fc, order, shown}
  let cursor = null;
  let live = true; // el cursor sigue a la hora más reciente observada
  let t0 = 0, t1 = 1;
  let timer = null;
  let dock = null, grid = null;

  function build() {
    if (dock) return;
    dock = document.createElement("section");
    dock.id = "tdock";
    dock.className = "timeline tdock";
    dock.hidden = true;
    dock.setAttribute("aria-label", "Línea de tiempo de las capas");
    dock.innerHTML = `
      <div class="td-head">
        <button class="play" type="button" id="tdPlay" aria-label="Reproducir la animación">
          <svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
          <svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>
        </button>
        <div class="td-clock"><span class="tl-time" id="tdTime">—</span><span class="tl-ago" id="tdAgo"></span></div>
        <button type="button" class="td-now" id="tdNow">Lo más reciente</button>
        <button type="button" class="td-fold" id="tdFold" aria-expanded="true" aria-label="Contraer las filas">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>
        </button>
      </div>
      <div class="td-body">
        <div class="td-grid" id="tdGrid" role="slider" tabindex="0" aria-label="Hora de las capas"></div>
        <div class="td-scale" id="tdScale" aria-hidden="true"></div>
      </div>`;
    document.body.appendChild(dock);
    grid = dock.querySelector("#tdGrid");
    dock.querySelector("#tdPlay").addEventListener("click", () => (timer ? stop() : play()));
    dock.querySelector("#tdNow").addEventListener("click", () => { stop(); live = true; set(latest()); });
    dock.querySelector("#tdFold").addEventListener("click", (e) => {
      const folded = dock.classList.toggle("folded");
      e.currentTarget.setAttribute("aria-expanded", String(!folded));
    });
    const pick = (e) => {
      const lanes = grid.querySelector(".td-lanes-area");
      if (!lanes) return;
      const r = lanes.getBoundingClientRect();
      const f = clamp((e.clientX - r.left) / r.width, 0, 1);
      stop();
      live = false;
      set(snap(t0 + f * (t1 - t0)));
    };
    let drag = false;
    grid.addEventListener("pointerdown", (e) => { if (e.target.closest(".td-lbl")) return; drag = true; grid.setPointerCapture(e.pointerId); pick(e); });
    grid.addEventListener("pointermove", (e) => { if (drag) pick(e); });
    grid.addEventListener("pointerup", () => (drag = false));
    grid.addEventListener("keydown", (e) => {
      const ticks = union();
      const i = ticks.findIndex((t) => t >= cursor - MIN);
      if (e.key === "ArrowLeft") { stop(); live = false; set(ticks[Math.max(0, (i < 0 ? ticks.length : i) - 1)]); e.preventDefault(); }
      if (e.key === "ArrowRight") { stop(); live = false; set(ticks[Math.min(ticks.length - 1, i + (ticks[i] <= cursor + MIN ? 1 : 0))]); e.preventDefault(); }
      if (e.key === "End" || e.key === "Home") { stop(); live = true; set(latest()); e.preventDefault(); }
      if (e.key === " ") { timer ? stop() : play(); e.preventDefault(); }
    });
  }

  // Todas las horas de todas las capas, sin duplicados cercanos (≤ 4 min)
  function union() {
    const all = [];
    layers.forEach((l) => l.times.forEach((t) => { if (t >= t0 && t <= t1) all.push(t); }));
    all.sort((a, b) => a - b);
    const out = [];
    all.forEach((t) => { if (!out.length || t - out[out.length - 1] > 4 * MIN) out.push(t); });
    return out;
  }
  function snap(t) {
    let best = t, bd = Infinity;
    union().forEach((u) => { const d = Math.abs(u - t); if (d < bd) { bd = d; best = u; } });
    return best;
  }
  // La hora observada más reciente entre todas las capas
  function latest() {
    let m = null;
    const now = Date.now() + 5 * MIN;
    layers.forEach((l) => l.times.forEach((t) => { if (t <= now && (m == null || t > m)) m = t; }));
    if (m == null) layers.forEach((l) => l.times.forEach((t) => { if (m == null || t < m) m = t; }));
    return m;
  }
  function nearest(l, t) {
    let best = null, bd = Infinity;
    l.times.forEach((u) => { const d = Math.abs(u - t); if (d < bd) { bd = d; best = u; } });
    return { t: best, d: bd };
  }

  function range() {
    const now = Date.now();
    let a = Infinity, b = -Infinity;
    layers.forEach((l) => l.times.forEach((t) => { a = Math.min(a, t - (l.step || l.tol) / 2); b = Math.max(b, t + (l.step || l.tol) / 2); }));
    if (!Number.isFinite(a)) { a = now - 3 * H; b = now; }
    // Ventana común: 6 horas hacia atrás y, si alguna capa pronostica, 6 hacia adelante
    t0 = now - 6.25 * H;
    t1 = Math.min(Math.max(b, now + 15 * MIN), now + 6.5 * H);
  }

  const pct = (t) => ((t - t0) / (t1 - t0)) * 100;

  function render() {
    build();
    dock.hidden = layers.size === 0;
    document.body.classList.toggle("tdock-on", layers.size > 0);
    document.body.style.setProperty("--td-rows", String(layers.size));
    if (!layers.size) return;
    range();
    const list = [...layers.entries()].sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
    const now = Date.now();
    let h = `<div class="td-lanes-area" aria-hidden="true"><span class="td-nowline" style="left:${pct(now)}%"></span><span class="td-cursor" id="tdCursor"></span></div>`;
    list.forEach(([k, l]) => {
      const w = Math.max(0.35, (((l.step || l.tol) * 0.86) / (t1 - t0)) * 100);
      const ticks = l.times.filter((t) => t >= t0 && t <= t1).map((t) => {
        const v = l.value ? l.value(t) : null;
        const hh = v == null ? 100 : 22 + 78 * clamp(v, 0, 1);
        return `<i class="${l.fc && l.fc(t) ? "fc" : "obs"}" data-t="${t}" style="left:${pct(t) - w / 2}%;width:${w}%;height:${hh}%"></i>`;
      }).join("");
      h += `<div class="td-row" data-k="${k}">
          <span class="td-lbl" title="${l.label}">${l.icon || ""}<span>${l.short || l.label}</span></span>
          <div class="td-lane">${ticks}<em class="td-off"></em></div>
        </div>`;
    });
    grid.innerHTML = h;
    // Escala: horas enteras
    const span = t1 - t0;
    const stepH = span > 10 * H ? 3 : span > 5 * H ? 2 : 1;
    let s = "";
    const first = Math.ceil(t0 / H) * H;
    for (let t = first; t <= t1; t += H) {
      const hr = Number(new Date(t).toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: TZ }));
      if (hr % stepH) continue;
      s += `<span style="left:${pct(t)}%">${hr === 0 ? fmtD.format(new Date(t)) : fmtHH.format(new Date(t)).replace(/\s?(a|p)\.\s?m\./, "$1")}</span>`;
    }
    s += `<span class="td-nowlbl" style="left:${pct(now)}%">ahora</span>`;
    dock.querySelector("#tdScale").innerHTML = s;
    if (cursor == null || live) cursor = latest();
    set(cursor, true);
  }

  function agoText(t) {
    const d = Date.now() - t;
    const m = Math.round(Math.abs(d) / MIN);
    const txt = m < 60 ? `${m} min` : `${(m / 60).toFixed(m < 600 ? 1 : 0).replace(".", ",").replace(",0", "")} h`;
    if (Math.abs(d) < 6 * MIN) return "ahora";
    return d > 0 ? `hace ${txt}` : `pronóstico a ${txt}`;
  }

  function set(t, force) {
    if (t == null) return;
    cursor = t;
    const today = dayKey(Date.now()) === dayKey(t);
    dock.querySelector("#tdTime").textContent = (today ? "" : fmtD.format(new Date(t)) + ", ") + fmtH.format(new Date(t));
    dock.querySelector("#tdAgo").textContent = agoText(t);
    const c = dock.querySelector("#tdCursor");
    if (c) c.style.left = `${pct(t)}%`;
    grid.setAttribute("aria-valuetext", `${fmtH.format(new Date(t))}, ${agoText(t)}`);
    layers.forEach((l, k) => {
      const n = nearest(l, t);
      const off = n.t == null || n.d > l.tol;
      const row = grid.querySelector(`.td-row[data-k="${CSS.escape(k)}"]`);
      if (row) {
        row.classList.toggle("fuera", off);
        row.querySelectorAll("i").forEach((el) => el.classList.toggle("cur", Number(el.dataset.t) === n.t));
        const em = row.querySelector(".td-off");
        if (em) em.textContent = off ? (n.t == null ? "sin datos" : `sin dato a esta hora · más cercano ${fmtH.format(new Date(n.t))}`) : "";
      }
      if (n.t != null && (force || l.shown !== n.t || l.wasOff !== off)) {
        l.shown = n.t;
        l.wasOff = off;
        try { l.show(n.t, off); } catch (e) { /* una capa con error no detiene a las demás */ }
      }
    });
    if (window.Celeste && window.Celeste.refreshPoint) window.Celeste.refreshPoint();
  }

  function play() {
    const ticks = union();
    if (ticks.length < 2) return;
    live = false;
    const btn = dock.querySelector("#tdPlay");
    btn.classList.add("playing");
    btn.setAttribute("aria-label", "Pausar la animación");
    let i = ticks.findIndex((t) => t > cursor + MIN);
    if (i < 0) i = 0;
    const step = () => {
      const tk = union();
      if (i >= tk.length) i = 0;
      set(tk[i]);
      const last = i === tk.length - 1;
      i++;
      timer = setTimeout(step, last ? 1600 : 520);
    };
    step();
  }
  function stop() {
    clearTimeout(timer);
    timer = null;
    if (!dock) return;
    const btn = dock.querySelector("#tdPlay");
    btn.classList.remove("playing");
    btn.setAttribute("aria-label", "Reproducir la animación");
  }

  let pending = null;
  const schedule = () => { if (pending) return; pending = setTimeout(() => { pending = null; render(); }, 0); };

  window.CelesteTime = {
    register(key, def) {
      const l = Object.assign({ times: [], tol: 30 * MIN, order: 0 }, def);
      l.times = (l.times || []).filter(Number.isFinite).sort((a, b) => a - b);
      layers.set(key, l);
      schedule();
    },
    setTimes(key, times) {
      const l = layers.get(key);
      if (!l) return;
      l.times = (times || []).filter(Number.isFinite).sort((a, b) => a - b);
      l.shown = null;
      schedule();
    },
    refresh: schedule,
    unregister(key) {
      if (!layers.delete(key)) return;
      if (!layers.size) { stop(); cursor = null; live = true; }
      schedule();
    },
    get: () => cursor,
    has: (key) => layers.has(key),
    stop,
  };
})();
