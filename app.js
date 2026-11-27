/* Mi tensión — lógica de la app. Sin dependencias. localStorage como caché local y, si hay conexión,
 * sincronización con el backend «Mis apps» del Mac de casa (ver sync.js).
 *
 * Formato de cada lectura (estable, también usado en exportar/importar):
 *   { id: string, datetime: "2026-11-25T13:21:00+01:00", systolic, diastolic, pulse, note }
 * El instante se guarda en ISO 8601 con el desfase real de Europe/Madrid (+01:00 / +02:00).
 * `pulse` puede ser null (lectura sin pulso, p. ej. apuntada por Coco).
 */
(() => {
  'use strict';

  const TZ = 'Europe/Madrid';
  const STORAGE_KEY = 'mi-tension:v1';
  const FORMAT_VERSION = 1;
  const PATIENT = 'Jorge Rodriguez Sobreira';
  const TARGET = { sys: 130, dia: 80 };
  const DAY = 86400000;
  const MAC_URL = 'https://air-prodesin.tail7b1127.ts.net:8445/mi-tension/';
  const MODO = window.MTSync ? MTSync.detectarModo(location) : 'local';
  /** «Ahora». Para pruebas y capturas se puede fijar con window.__MT_NOW (ms o ISO). */
  const nowDate = () => (window.__MT_NOW != null ? new Date(window.__MT_NOW) : new Date());
  const pulseText = (p) => (p == null ? '—' : String(p));

  // Lecturas precargadas la primera vez
  const SEED = [
    ['2026-11-18', '19:19', 127, 81, 103],
    ['2026-11-19', '13:56', 122, 80, 95],
    ['2026-11-20', '16:24', 124, 81, 88],
    ['2026-11-21', '13:05', 120, 80, 93],
    ['2026-11-22', '13:16', 126, 82, 91],
    ['2026-11-23', '13:06', 125, 85, 96],
    ['2026-11-24', '20:35', 125, 84, 96],
    ['2026-11-25', '13:21', 136, 92, 88]
  ];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const pad = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ================= Zona horaria Europe/Madrid ================= */
  const partsFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const dateFmt = new Intl.DateTimeFormat('es-ES', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat('es-ES', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const shortFmt = new Intl.DateTimeFormat('es-ES', { timeZone: TZ, day: '2-digit', month: '2-digit' });
  const longFmt = new Intl.DateTimeFormat('es-ES', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });

  /** Componentes de fecha/hora de un instante, vistos en Madrid. */
  function madridParts(date) {
    const o = {};
    for (const p of partsFmt.formatToParts(date)) o[p.type] = p.value;
    return o;
  }
  /** Desfase (minutos) de Madrid respecto a UTC en un instante dado. */
  function offsetMinutes(date) {
    const p = madridParts(date);
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return Math.round((asUTC - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  }
  /** "2026-11-25" + "13:21" (hora de Madrid) -> ISO con offset. */
  function toISO(dateStr, timeStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const [h, mi] = timeStr.split(':').map(Number);
    const naive = Date.UTC(y, m - 1, d, h, mi);
    let off = offsetMinutes(new Date(naive));
    off = offsetMinutes(new Date(naive - off * 60000)); // segunda pasada por si cruza un cambio horario
    const a = Math.abs(off);
    return `${dateStr}T${timeStr}:00${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  }
  /** Valores para los inputs date/time a partir de un instante. */
  function nowInputs(date = nowDate()) {
    const p = madridParts(date);
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  }
  const ts = (r) => new Date(r.datetime).getTime();
  const fmtDate = (r) => dateFmt.format(new Date(r.datetime));
  const fmtTime = (r) => timeFmt.format(new Date(r.datetime));

  /* ================= Clasificación (ESC/ESH, orientativa) ================= */
  function classify(s, d) {
    if (s < 90 || d < 60) return { cls: 'c-baja', label: 'Baja' };
    if (s >= 180 || d >= 110) return { cls: 'c-g3', label: 'Grado 3' };
    if (s >= 160 || d >= 100) return { cls: 'c-g2', label: 'Grado 2' };
    if (s >= 140 || d >= 90) return { cls: 'c-g1', label: 'Grado 1' };
    if (s >= 130 || d >= 80) return { cls: 'c-above', label: 'Por encima del objetivo' };
    if (s >= 120) return { cls: 'c-normal', label: 'Normal, en objetivo' };
    return { cls: 'c-optima', label: 'Óptima, en objetivo' };
  }
  const pill = (r) => { const c = classify(r.systolic, r.diastolic); return `<span class="pill ${c.cls}"><i></i>${c.label}</span>`; };

  /* ================= Almacenamiento ================= */
  let state = { readings: [], seeded: false };

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'r-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (raw && Array.isArray(raw.readings)) {
        state = { readings: raw.readings.filter(isValidStored).map((r) => (r.pulse === undefined ? { ...r, pulse: null } : r)), seeded: !!raw.seeded };
      }
    } catch (e) { /* datos ausentes o corruptos: se parte de cero */ }
    // Primera vez (o sin lecturas y nunca precargado): sembrar las 8 lecturas solo como demo sin backend.
    // Servida desde el Mac, la app nunca siembra: los datos vienen del servidor.
    if (MODO !== 'mac' && state.readings.length === 0 && !state.seeded) {
      state.readings = SEED.map(([d, t, s, di, p]) => ({
        id: `seed-${d}`, datetime: toISO(d, t), systolic: s, diastolic: di, pulse: p, note: ''
      }));
      state.seeded = true;
      persist();
    }
  }
  function isValidStored(r) {
    return r && typeof r.id === 'string' && !isNaN(new Date(r.datetime).getTime()) &&
      Number.isFinite(r.systolic) && Number.isFinite(r.diastolic) && (r.pulse == null || Number.isFinite(r.pulse));
  }
  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: FORMAT_VERSION, seeded: state.seeded, readings: state.readings }));
      return true;
    } catch (e) {
      toast('No se pudo guardar en este dispositivo.', true);
      return false;
    }
  }
  /* ----- Sincronización con el backend (sync.js) ----- */
  const NOOP = { sincronizar() {}, encolarPut() {}, encolarDel() {}, encolarPuts() {} };
  const sync = window.MTSync && MODO !== 'local' ? MTSync.crear({
    modo: MODO,
    almacen: localStorage,
    fetchFn: (u, o) => fetch(u, o),
    getLecturas: () => state.readings,
    setLecturas: (lista) => {
      const antes = JSON.stringify(sorted(false));
      state.readings = lista;
      if (JSON.stringify(sorted(false)) !== antes) { state.seeded = true; persist(); renderAll(); }
    },
    alEstado: (e, info) => renderSyncEstado(e, info)
  }) : NOOP;
  function renderSyncEstado(e, info) {
    const el = $('#sync-estado');
    if (!el) return;
    const n = (info && info.pendientes) || 0;
    const txt = {
      sincronizado: 'Sincronizado con el Mac de casa',
      sincronizando: 'Sincronizando…',
      pendiente: `Pendiente de enviar${n ? ` (${n})` : ''}`,
      'sin-conexion': `Sin conexión con el Mac: se enviará al volver${n ? ` (${n} pendiente${n === 1 ? '' : 's'})` : ''}`,
      'sin-permiso': 'El Mac no acepta escribir desde aquí: abre la app en su dirección nueva',
      desactivado: ''
    }[e] || '';
    el.textContent = txt;
    el.dataset.estado = e;
    el.hidden = !txt;
  }
  const sorted = (desc = true) => state.readings.slice().sort((a, b) => desc ? ts(b) - ts(a) : ts(a) - ts(b));

  /* ================= Validación ================= */
  function validate(v) {
    const errors = {};
    const num = (s) => (/^\d{1,3}$/.test(String(s).trim()) ? parseInt(s, 10) : NaN);
    const sys = num(v.sys), dia = num(v.dia);
    const pulVacio = String(v.pul).trim() === '';
    const pul = pulVacio ? null : num(v.pul);
    if (isNaN(sys)) errors.sys = 'Escribe la presión alta (sistólica), solo números.';
    else if (sys < 70 || sys > 250) errors.sys = 'La alta (sistólica) debe estar entre 70 y 250 mmHg.';
    if (isNaN(dia)) errors.dia = 'Escribe la presión baja (diastólica), solo números.';
    else if (dia < 40 || dia > 150) errors.dia = 'La baja (diastólica) debe estar entre 40 y 150 mmHg.';
    if (!errors.sys && !errors.dia && sys <= dia) errors.dia = 'La alta debe ser mayor que la baja.';
    if (!pulVacio && isNaN(pul)) errors.pul = 'El pulso, si lo pones, solo con números.';
    else if (!pulVacio && (pul < 30 || pul > 200)) errors.pul = 'El pulso debe estar entre 30 y 200 lpm.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) errors.date = 'Indica una fecha válida.';
    if (!/^\d{2}:\d{2}$/.test(v.time)) errors.time = 'Indica una hora válida.';
    return { errors, values: { sys, dia, pul } };
  }

  /* ================= Formularios ================= */
  function formHTML(submitLabel, withCancel) {
    return `
      <div class="row3">
        <label class="field"><span>Alta</span><input class="num-in" name="sys" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" placeholder="120" enterkeyhint="next"></label>
        <label class="field"><span>Baja</span><input class="num-in" name="dia" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" placeholder="80" enterkeyhint="next"></label>
        <label class="field"><span>Pulso</span><input class="num-in" name="pul" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" placeholder="70" enterkeyhint="next"></label>
      </div>
      <div class="row2">
        <label class="field"><span>Fecha</span><input name="date" type="date"></label>
        <label class="field"><span>Hora</span><input name="time" type="time"></label>
      </div>
      <label class="field"><span>Nota <small>(opcional)</small></span><textarea name="note" rows="2" maxlength="300" placeholder="Ej.: después de caminar"></textarea></label>
      <div class="errors" role="alert"></div>
      ${withCancel
        ? `<div class="btn-row"><button type="button" class="btn secondary" data-cancel>Cancelar</button><button type="submit" class="btn primary">${submitLabel}</button></div>`
        : `<button type="submit" class="btn primary">${submitLabel}</button>`}`;
  }
  function readForm(form) {
    const f = form.elements;
    return { sys: f.sys.value, dia: f.dia.value, pul: f.pul.value, date: f.date.value, time: f.time.value, note: f.note.value.trim() };
  }
  function showErrors(form, errors) {
    const msgs = Object.values(errors);
    $('.errors', form).innerHTML = msgs.map((m) => `<span>${esc(m)}</span>`).join('');
    for (const name of ['sys', 'dia', 'pul', 'date', 'time']) {
      form.elements[name].setAttribute('aria-invalid', errors[name] ? 'true' : 'false');
    }
    if (msgs.length) {
      const first = ['sys', 'dia', 'pul', 'date', 'time'].find((n) => errors[n]);
      form.elements[first].focus();
    }
  }
  function fillDateTime(form, date) {
    const n = nowInputs(date);
    form.elements.date.value = n.date;
    form.elements.time.value = n.time;
  }

  /* ----- Formulario nuevo ----- */
  const formNew = $('#form-new');
  let dateDirty = false;
  formNew.innerHTML = formHTML('Guardar', false);
  fillDateTime(formNew);
  ['date', 'time'].forEach((n) => formNew.elements[n].addEventListener('input', () => { dateDirty = true; }));
  formNew.addEventListener('input', (e) => { if (e.target.getAttribute('aria-invalid') === 'true') e.target.setAttribute('aria-invalid', 'false'); });
  formNew.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = readForm(formNew);
    const { errors, values } = validate(v);
    showErrors(formNew, errors);
    if (Object.keys(errors).length) return;
    const nueva = { id: newId(), datetime: toISO(v.date, v.time), systolic: values.sys, diastolic: values.dia, pulse: values.pul, note: v.note };
    state.readings.push(nueva);
    if (!persist()) { state.readings.pop(); return; }
    sync.encolarPut(nueva); sync.sincronizar();
    formNew.elements.sys.value = formNew.elements.dia.value = formNew.elements.pul.value = formNew.elements.note.value = '';
    dateDirty = false;
    fillDateTime(formNew);
    document.activeElement && document.activeElement.blur();
    const btn = $('button[type=submit]', formNew);
    btn.textContent = '✓ Guardado'; btn.classList.add('saved');
    setTimeout(() => { btn.textContent = 'Guardar'; btn.classList.remove('saved'); }, 1800);
    renderAll();
    const latest = $('#latest');
    latest.classList.remove('pulse-anim'); void latest.offsetWidth; latest.classList.add('pulse-anim');
    latest.scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('Lectura guardada');
  });

  /* ----- Edición ----- */
  const dlgEdit = $('#dlg-edit');
  const formEdit = $('#form-edit');
  let editingId = null;
  formEdit.innerHTML = formHTML('Guardar cambios', true);
  $('[data-cancel]', formEdit).addEventListener('click', () => dlgEdit.close());

  function openEdit(id) {
    const r = state.readings.find((x) => x.id === id);
    if (!r) return;
    editingId = id;
    const n = nowInputs(new Date(r.datetime));
    const f = formEdit.elements;
    f.sys.value = r.systolic; f.dia.value = r.diastolic; f.pul.value = r.pulse == null ? '' : r.pulse;
    f.date.value = n.date; f.time.value = n.time; f.note.value = r.note || '';
    showErrors(formEdit, {});
    dlgEdit.showModal();
  }
  formEdit.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = readForm(formEdit);
    const { errors, values } = validate(v);
    showErrors(formEdit, errors);
    if (Object.keys(errors).length) return;
    const r = state.readings.find((x) => x.id === editingId);
    if (!r) { dlgEdit.close(); return; }
    const backup = { ...r };
    Object.assign(r, { datetime: toISO(v.date, v.time), systolic: values.sys, diastolic: values.dia, pulse: values.pul, note: v.note });
    if (!persist()) { Object.assign(r, backup); return; }
    sync.encolarPut(r); sync.sincronizar();
    dlgEdit.close();
    renderAll();
    toast('Cambios guardados');
  });

  /* ----- Borrado ----- */
  const dlgDel = $('#dlg-del');
  let deletingId = null;
  function askDelete(id) {
    const r = state.readings.find((x) => x.id === id);
    if (!r) return;
    deletingId = id;
    $('#dlg-del-text').textContent = `Lectura del ${fmtDate(r)} a las ${fmtTime(r)}: ${r.systolic}/${r.diastolic} mmHg, pulso ${pulseText(r.pulse)}.`;
    dlgDel.showModal();
  }
  $('#del-cancel').addEventListener('click', () => dlgDel.close());
  $('#del-ok').addEventListener('click', () => {
    const before = state.readings;
    state.readings = state.readings.filter((x) => x.id !== deletingId);
    if (!persist()) state.readings = before;
    else { sync.encolarDel(deletingId); sync.sincronizar(); toast('Lectura borrada'); }
    dlgDel.close();
    renderAll();
  });

  /* ================= Estadísticas ================= */
  function windowReadings(days, now = nowDate().getTime()) {
    return state.readings.filter((r) => { const t = ts(r); return t <= now && t > now - days * DAY; });
  }
  function averages(list) {
    if (!list.length) return null;
    const m = (k, l = list) => Math.round(l.reduce((a, r) => a + r[k], 0) / l.length);
    const conPulso = list.filter((r) => r.pulse != null);
    return { sys: m('systolic'), dia: m('diastolic'), pul: conPulso.length ? m('pulse', conPulso) : null, n: list.length };
  }
  function avgCard(title, a) {
    if (!a) return `<div class="avg"><h3>${title}</h3><div class="v">—</div><div class="p">Sin lecturas</div></div>`;
    return `<div class="avg"><h3>${title}</h3><div class="v">${a.sys}/${a.dia}</div><div class="p">♥ ${a.pul == null ? '—' : a.pul + ' lpm'}</div><div class="n">${a.n} ${a.n === 1 ? 'lectura' : 'lecturas'}</div></div>`;
  }

  /* ================= Render ================= */
  function bar(label, value, target) {
    const pct = Math.min(100, (value / (target * 1.25)) * 100);
    const ok = value < target;
    const diff = Math.abs(value - target);
    const text = ok ? `${diff} por debajo del objetivo` : diff === 0 ? 'justo en el límite' : `${diff} por encima del objetivo`;
    return `<div><div class="bar-head"><span><b>${label}</b> · objetivo &lt; ${target}</span><span>${text}</span></div>
      <div class="track" role="img" aria-label="${label} ${value} frente a objetivo menor de ${target}"><div class="fill ${ok ? '' : 'warn'}" style="width:${pct}%"></div><div class="marker"></div></div></div>`;
  }
  function renderLatest() {
    const el = $('#latest');
    const last = sorted()[0];
    if (!last) {
      el.innerHTML = '<p class="empty">Aún no hay lecturas. Añade la primera abajo.</p>';
      return;
    }
    const c = classify(last.systolic, last.diastolic);
    el.innerHTML = `
      <div class="top"><span class="label">Última lectura</span>${pill(last)}</div>
      <div class="big" aria-label="${last.systolic} sobre ${last.diastolic} milímetros de mercurio"><span class="num">${last.systolic}</span><span class="slash">/</span><span class="num">${last.diastolic}</span><span class="unit">mmHg</span></div>
      <div class="meta">♥ <b>${pulseText(last.pulse)}</b>${last.pulse == null ? '' : ' lpm'} · ${fmtDate(last)} · ${fmtTime(last)}</div>
      <div class="bars">${bar('Alta', last.systolic, TARGET.sys)}${bar('Baja', last.diastolic, TARGET.dia)}</div>`;
    el.className = `card latest ${c.cls}`;
  }
  function renderAverages() {
    const html = avgCard('Últimos 7 días', averages(windowReadings(7))) + avgCard('Últimos 30 días', averages(windowReadings(30)));
    $('#avg-home').innerHTML = html;
    $('#avg-evo').innerHTML = html;
  }
  function renderHistory() {
    const list = sorted();
    $('#history-empty').hidden = list.length > 0;
    $('#history').innerHTML = list.map((r) => `
      <li class="row">
        <div class="row-top"><span class="row-date">${fmtDate(r)} · ${fmtTime(r)}</span>${pill(r)}</div>
        <div class="row-vals">${r.systolic}/${r.diastolic} <small>mmHg · ♥ ${r.pulse == null ? '—' : r.pulse + ' lpm'}</small></div>
        ${r.note ? `<div class="row-note">${esc(r.note)}</div>` : ''}
        <div class="row-actions">
          <button type="button" data-act="edit" data-id="${esc(r.id)}" aria-label="Editar lectura del ${fmtDate(r)} a las ${fmtTime(r)}">Editar</button>
          <button type="button" class="del" data-act="del" data-id="${esc(r.id)}" aria-label="Borrar lectura del ${fmtDate(r)} a las ${fmtTime(r)}">Borrar</button>
        </div>
      </li>`).join('');
  }
  $('#history').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'edit') openEdit(b.dataset.id); else askDelete(b.dataset.id);
  });

  /* ----- Gráfico SVG ----- */
  let range = 30; // días; 0 = todo
  function rangeReadings() {
    const now = nowDate().getTime();
    return sorted(false).filter((r) => ts(r) <= now && (range === 0 || ts(r) > now - range * DAY));
  }
  function renderChart() {
    const data = rangeReadings();
    const W = 640, H = 320, L = 42, R = 18, T = 16, B = 34;
    const iw = W - L - R, ih = H - T - B;
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico de tensión alta y baja a lo largo del tiempo">`;
    if (!data.length) {
      svg += `<text class="nodata" x="${W / 2}" y="${H / 2}">No hay lecturas en este periodo</text></svg>`;
      $('#chart').innerHTML = svg; return;
    }
    const lo = Math.floor((Math.min(70, ...data.map((r) => r.diastolic)) - 5) / 10) * 10;
    const hi = Math.ceil((Math.max(140, ...data.map((r) => r.systolic)) + 5) / 10) * 10;
    const step = hi - lo > 100 ? 20 : 10;
    const y = (v) => T + ih - ((v - lo) / (hi - lo)) * ih;
    const t0 = ts(data[0]), t1 = ts(data[data.length - 1]);
    const x = (t) => (t1 === t0 ? L + iw / 2 : L + ((t - t0) / (t1 - t0)) * iw);

    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    }
    // Etiquetas de fecha (hasta 5)
    const nT = t1 === t0 ? 1 : Math.min(5, data.length);
    for (let i = 0; i < nT; i++) {
      const t = nT === 1 ? t0 : t0 + ((t1 - t0) * i) / (nT - 1);
      const anchor = nT === 1 ? 'middle' : i === 0 ? 'start' : i === nT - 1 ? 'end' : 'middle';
      svg += `<text x="${x(t)}" y="${H - 10}" text-anchor="${anchor}">${shortFmt.format(new Date(t))}</text>`;
    }
    // Líneas objetivo
    svg += `<line class="tg tg-sys" x1="${L}" x2="${W - R}" y1="${y(TARGET.sys)}" y2="${y(TARGET.sys)}"/>
            <text class="tg-lbl-sys" x="${W - R}" y="${y(TARGET.sys) - 5}" text-anchor="end">130</text>
            <line class="tg tg-dia" x1="${L}" x2="${W - R}" y1="${y(TARGET.dia)}" y2="${y(TARGET.dia)}"/>
            <text class="tg-lbl-dia" x="${W - R}" y="${y(TARGET.dia) - 5}" text-anchor="end">80</text>`;
    // Series
    const pts = (k) => data.map((r) => `${x(ts(r)).toFixed(1)},${y(r[k]).toFixed(1)}`).join(' ');
    svg += `<polyline class="ln ln-sys" points="${pts('systolic')}"/><polyline class="ln ln-dia" points="${pts('diastolic')}"/>`;
    for (const r of data) {
      const cx = x(ts(r)), tip = `${fmtDate(r)} ${fmtTime(r)}: ${r.systolic}/${r.diastolic}, pulso ${pulseText(r.pulse)}`;
      svg += `<circle class="pt-sys" cx="${cx}" cy="${y(r.systolic)}" r="5"><title>${tip}</title></circle>`;
      svg += `<rect class="pt-dia" x="${cx - 4.5}" y="${y(r.diastolic) - 4.5}" width="9" height="9" rx="2"><title>${tip}</title></rect>`;
    }
    $('#chart').innerHTML = svg + '</svg>';
  }

  /* ----- Informe imprimible ----- */
  function renderReport() {
    const data = rangeReadings();
    const avgRow = (label, a) => `<tr><th>${label}</th><td class="num">${a ? a.sys : '—'}</td><td class="num">${a ? a.dia : '—'}</td><td class="num">${a && a.pul != null ? a.pul : '—'}</td><td class="num">${a ? a.n : 0}</td></tr>`;
    const label = range === 0 ? 'todas las lecturas' : `últimos ${range} días`;
    const period = data.length ? `Del ${fmtDate(data[0])} al ${fmtDate(data[data.length - 1])} (${label}; ${data.length} lecturas)` : `Sin lecturas (${label})`;
    $('#report').innerHTML = `
      <h1>Informe de tensión arterial</h1>
      <p><strong>Nombre:</strong> ${esc(PATIENT)}</p>
      <p><strong>Periodo:</strong> ${esc(period)}</p>
      <p><strong>Generado:</strong> ${dateFmt.format(nowDate())} ${timeFmt.format(nowDate())} (hora de Madrid)</p>
      <h2>Medias (mmHg / lpm)</h2>
      <table class="avgs"><thead><tr><th></th><th>Sistólica</th><th>Diastólica</th><th>Pulso</th><th>Lecturas</th></tr></thead><tbody>
        ${avgRow('Últimos 7 días', averages(windowReadings(7)))}
        ${avgRow('Últimos 30 días', averages(windowReadings(30)))}
        ${avgRow('Periodo del informe', averages(data))}
      </tbody></table>
      <p style="margin-top:2mm">Objetivo: sistólica &lt; 130 y diastólica &lt; 80 mmHg.</p>
      <h2>Lecturas</h2>
      <table><thead><tr><th>Fecha</th><th>Hora</th><th>Sistólica</th><th>Diastólica</th><th>Pulso</th><th>Clasificación</th><th>Nota</th></tr></thead><tbody>
        ${data.map((r) => `<tr><td>${fmtDate(r)}</td><td>${fmtTime(r)}</td><td class="num">${r.systolic}</td><td class="num">${r.diastolic}</td><td class="num">${pulseText(r.pulse)}</td><td>${classify(r.systolic, r.diastolic).label}</td><td>${esc(r.note || '')}</td></tr>`).join('') || '<tr><td colspan="7">Sin lecturas</td></tr>'}
      </tbody></table>
      <p class="notice">Orientativo: no sustituye a tu médico.</p>`;
  }
  $('#btn-pdf').addEventListener('click', () => { renderReport(); window.print(); });
  window.addEventListener('beforeprint', renderReport);

  $('#range').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]');
    if (!b) return;
    range = parseInt(b.dataset.range, 10);
    $$('#range button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderChart();
  });

  /* ----- Aviso «aún no te la has tomado» (Europe/Madrid) ----- */
  function renderAviso() {
    const el = $('#aviso-toma');
    if (!el) return;
    const ahora = nowDate();
    const hoy = nowInputs(ahora).date;
    if (state.readings.some((r) => nowInputs(new Date(r.datetime)).date === hoy)) { el.hidden = true; el.innerHTML = ''; return; }
    const p = madridParts(ahora);
    const min = (+p.hour) * 60 + (+p.minute);
    const [cls, msg] = min < 13 * 60 + 30 ? ['soft', 'Hoy toca antes de comer.']
      : min < 16 * 60 ? ['urgent', 'Es la hora: tómatela antes de comer.']
      : ['soft', 'Hoy aún no la has apuntado. Si te la tomaste, apúntala; si no, mañana antes de comer.'];
    el.hidden = false;
    el.className = `notice ${cls}`;
    el.textContent = msg;
  }

  /* ----- Banner de mudanza (solo en GitHub Pages) ----- */
  function initBanner() {
    const b = $('#banner-mudanza');
    if (!b || MODO !== 'pages') return;
    b.hidden = false;
    $('#banner-ok').addEventListener('click', () => { b.hidden = true; });
  }

  function renderAll() {
    renderAviso();
    renderLatest(); renderAverages(); renderHistory(); renderChart();
  }

  /* ================= Pestañas ================= */
  const dashMQ = window.matchMedia('(min-width: 600px) and (min-height: 560px)');
  const reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  let currentTab = 'hoy';
  function showTab(name, scroll = true) {
    currentTab = name;
    $$('.tabbar button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    // En modo dashboard el CSS muestra todos los paneles; aquí solo se marca la sección activa.
    $$('.panel').forEach((p) => { p.hidden = p.id !== `panel-${name}`; });
    if (scroll) {
      const behavior = dashMQ.matches && !reduceMQ.matches ? 'smooth' : 'auto';
      if (dashMQ.matches && name !== 'hoy') $(`#panel-${name}`).scrollIntoView({ behavior, block: 'start' });
      else window.scrollTo({ top: 0, behavior });
    }
    if (name === 'hoy' && !dateDirty) fillDateTime(formNew);
    if (name === 'evolucion' || dashMQ.matches) renderChart();
  }
  // Al plegar/desplegar/girar el CSS redistribuye; aquí solo se sincronizan las pestañas.
  // El formulario no se recrea, así que no se pierde lo escrito.
  // Lado del rail: si la safe area grande está a la izquierda (cámara de ese lado), el rail va a la izquierda.
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)';
  document.body.appendChild(probe);
  function syncRailSide() {
    const cs = getComputedStyle(probe);
    const l = parseFloat(cs.paddingLeft) || 0, r = parseFloat(cs.paddingRight) || 0;
    document.documentElement.dataset.rail = l > r ? 'left' : 'right';
  }
  syncRailSide();
  window.addEventListener('resize', syncRailSide);
  window.addEventListener('orientationchange', syncRailSide);
  const onLayoutChange = () => showTab(currentTab, false);
  if (dashMQ.addEventListener) dashMQ.addEventListener('change', onLayoutChange);
  else if (dashMQ.addListener) dashMQ.addListener(onLayoutChange);
  $('.tabbar').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) showTab(b.dataset.tab);
  });

  /* ================= Toast ================= */
  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('error', isError);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  /* ================= Exportar / importar ================= */
  $('#btn-export').addEventListener('click', () => {
    const payload = {
      app: 'mi-tension',
      version: FORMAT_VERSION,
      timezone: TZ,
      exportedAt: new Date().toISOString(),
      readings: sorted(false).map((r) => ({ id: r.id, datetime: r.datetime, systolic: r.systolic, diastolic: r.diastolic, pulse: r.pulse, note: r.note || '' }))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mi-tension-${nowInputs().date}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Datos exportados');
  });
  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = Array.isArray(data) ? data : data && data.readings;
      if (!Array.isArray(incoming)) throw new Error('formato');
      let added = 0, updated = 0, skipped = 0;
      const tocadas = [];
      for (const item of incoming) {
        const r = {
          id: typeof item.id === 'string' && item.id ? item.id : newId(),
          datetime: item.datetime, systolic: Number(item.systolic), diastolic: Number(item.diastolic),
          pulse: item.pulse == null || item.pulse === '' ? null : Number(item.pulse), note: typeof item.note === 'string' ? item.note.slice(0, 300) : ''
        };
        const ok = isValidStored(r) && r.systolic >= 70 && r.systolic <= 250 && r.diastolic >= 40 && r.diastolic <= 150 &&
          r.systolic > r.diastolic && (r.pulse === null || (r.pulse >= 30 && r.pulse <= 200));
        if (!ok) { skipped++; continue; }
        const i = state.readings.findIndex((x) => x.id === r.id);
        if (i >= 0) { state.readings[i] = r; updated++; } else { state.readings.push(r); added++; }
        tocadas.push(r);
      }
      state.seeded = true;
      persist();
      if (tocadas.length) { sync.encolarPuts(tocadas); sync.sincronizar(); }
      renderAll();
      toast(`Importadas ${added} nuevas, ${updated} actualizadas` + (skipped ? `, ${skipped} omitidas` : ''), false);
    } catch (err) {
      toast('El archivo no es válido.', true);
    }
  });

  /* ================= Inicio ================= */
  function renderToday() {
    const t = longFmt.format(nowDate());
    $('#today-label').textContent = t.charAt(0).toUpperCase() + t.slice(1); // «Jueves, 26 de noviembre»
  }
  loadState();
  renderToday();
  renderAll();
  initBanner();
  sync.sincronizar();
  window.addEventListener('online', () => sync.sincronizar());
  setInterval(() => { if (document.visibilityState === 'visible') { sync.sincronizar(); renderAviso(); } }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      sync.sincronizar();
      renderToday(); renderAll();
      if (!dateDirty) fillDateTime(formNew);
    }
  });

  // Service worker (solo con HTTPS o localhost)
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
})();
