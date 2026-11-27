/* Mi tensión — sincronización con el backend «Mis apps» (Mac de casa).
 * Módulo sin dependencias: funciona en el navegador (global MTSync) y en Node (tests).
 *
 * Modos:
 *   'mac'   la página se sirve desde Mis apps: API relativa (/api/...), escritura con la cookie de sesión.
 *   'pages' la página está en GitHub Pages (origen antiguo): API absoluta de Tailscale. Solo puede
 *           subir (upsert) lecturas; los borrados se quedan en local (no hay token en el navegador).
 *   'local' file:// u otro sitio sin backend: no se sincroniza (el seed de demo sigue funcionando).
 *
 * Datos locales: el formato `mi-tension:v1` no cambia. Se añaden dos claves:
 *   mi-tension:cola     [{op:'put', id, reading} | {op:'del', id}]   cambios pendientes de enviar
 *   mi-tension:migrado  {at, n}  marca de «lo que había en este dispositivo ya está en el servidor»
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MTSync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAC_ORIGIN = 'https://air-prodesin.tail7b1127.ts.net:8445';
  const API = '/api/mi-tension';
  const KEY_COLA = 'mi-tension:cola';
  const KEY_MIGRADO = 'mi-tension:migrado';

  function detectarModo(loc) {
    if (!loc || !/^https?:$/.test(loc.protocol)) return 'local';
    if (/(^|\.)github\.io$/.test(loc.hostname)) return 'pages';
    return 'mac';
  }

  /* ---------- Fusión y deduplicado ---------- */
  const minuto = (r) => Math.floor(Date.parse(r.datetime) / 60000);
  const clave = (r) => `${minuto(r)}|${r.systolic}|${r.diastolic}`;
  const completitud = (r) => (r.pulse != null ? 1 : 0) + (r.note ? 1 : 0);
  /** Copia de `a` rellenando pulso y nota con los de `b` si a no los trae. */
  function rellenar(a, b) {
    const o = Object.assign({}, a);
    if (o.pulse == null && b && b.pulse != null) o.pulse = b.pulse;
    if (!o.note && b && b.note) o.note = b.note;
    if (o.pulse === undefined) o.pulse = null;
    return o;
  }

  /**
   * Fusiona lecturas locales y del servidor sin duplicar.
   *  - misma id: si hay cambio local pendiente gana lo local; si no, el servidor (conservando pulso/nota si faltan)
   *  - mismo minuto y mismos valores con distinta id: se queda la más completa (a igualdad, la que ya conoce el servidor)
   *  - borrados pendientes: no reaparecen aunque el servidor aún las tenga
   *  - quitarAusentes: lo que el servidor ya no tiene (y no está pendiente de subir) se retira de local
   * Devuelve { readings, descartados } (ids locales absorbidos por un duplicado).
   */
  function fusionar(local, remoto, op) {
    op = op || {};
    const pend = op.pendientes || new Set();
    const borr = op.borrados || new Set();
    const idsRemotos = new Set(remoto.map((r) => r.id));
    const mapa = new Map();
    for (const r of remoto) if (!borr.has(r.id)) mapa.set(r.id, rellenar(r, null));
    for (const l of local) {
      if (borr.has(l.id)) continue;
      const r = mapa.get(l.id);
      if (r) mapa.set(l.id, pend.has(l.id) ? rellenar(l, r) : rellenar(r, l));
      else if (op.quitarAusentes && !pend.has(l.id)) continue;
      else mapa.set(l.id, rellenar(l, null));
    }
    const grupos = new Map();
    for (const r of mapa.values()) {
      const k = clave(r);
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(r);
    }
    const out = [], descartados = [];
    for (const g of grupos.values()) {
      if (g.length === 1) { out.push(g[0]); continue; }
      g.sort((a, b) => completitud(b) - completitud(a) ||
        (idsRemotos.has(b.id) - idsRemotos.has(a.id)) || (a.id < b.id ? -1 : 1));
      let ganadora = g[0];
      for (const p of g.slice(1)) { ganadora = rellenar(ganadora, p); descartados.push(p.id); }
      out.push(ganadora);
    }
    return { readings: out, descartados };
  }

  /* ---------- Cola de cambios ---------- */
  /** Añade una operación a la cola agrupando por id (la última manda). */
  function encolar(cola, nueva) {
    const sin = cola.filter((o) => o.id !== nueva.id);
    return sin.concat([nueva]);
  }

  /* ---------- Sincronizador ---------- */
  function crear(cfg) {
    const modo = cfg.modo;
    const base = modo === 'pages' ? (cfg.base || MAC_ORIGIN) : '';
    const almacen = cfg.almacen;
    const hacerFetch = cfg.fetchFn;
    const timeoutMs = cfg.timeoutMs || 8000;
    let enCurso = null, repetir = false;
    let estado = modo === 'local' ? 'desactivado' : 'pendiente';

    const leerJSON = (k, def) => { try { const v = JSON.parse(almacen.getItem(k)); return v == null ? def : v; } catch (e) { return def; } };
    const cola = () => { const c = leerJSON(KEY_COLA, []); return Array.isArray(c) ? c : []; };
    const guardarCola = (c) => { try { almacen.setItem(KEY_COLA, JSON.stringify(c)); } catch (e) { /* sin sitio: se reintentará con el estado */ } };
    const marca = () => leerJSON(KEY_MIGRADO, null);
    function poner(e, extra) {
      estado = e;
      if (cfg.alEstado) cfg.alEstado(e, Object.assign({ pendientes: cola().length }, extra || {}));
    }

    async function pedir(metodo, ruta, cuerpo) {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
      try {
        const init = { method: metodo, headers: { 'X-Mis-Apps': '1' }, cache: 'no-store' };
        if (ctl) init.signal = ctl.signal;
        if (cuerpo !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(cuerpo); }
        const res = await hacerFetch(base + ruta, init);
        let datos = null;
        if (res.status !== 204) { try { datos = await res.json(); } catch (e) { datos = null; } }
        return { status: res.status, datos };
      } finally { if (t) clearTimeout(t); }
    }

    function encolarPut(r) { guardarCola(encolar(cola(), { op: 'put', id: r.id, reading: r })); poner('pendiente'); }
    function encolarDel(id) { guardarCola(encolar(cola(), { op: 'del', id })); poner('pendiente'); }
    function encolarPuts(lista) { let c = cola(); for (const r of lista) c = encolar(c, { op: 'put', id: r.id, reading: r }); guardarCola(c); poner('pendiente'); }

    async function ciclo() {
      // 1. Migración inicial: sube todo lo que hay en este dispositivo (upsert sin duplicar).
      if (!marca()) {
        const locales = cfg.getLecturas();
        if (locales.length) {
          const r = await pedir('POST', API + '/importar', { readings: locales });
          if (r.status === 401 || r.status === 403) return 'sin-permiso';
          if (r.status !== 200) throw new Error('importar ' + r.status);
        }
        almacen.setItem(KEY_MIGRADO, JSON.stringify({ at: new Date().toISOString(), n: locales.length }));
      }
      // 2. Cola de cambios pendientes, en orden.
      let c = cola();
      for (const o of c.slice()) {
        if (o.op === 'put') {
          const r = modo === 'pages'
            ? await pedir('POST', API + '/importar', { readings: [o.reading] })
            : await pedir('PUT', API + '/medidas/' + encodeURIComponent(o.id), o.reading);
          if (r.status === 401 || r.status === 403) return 'sin-permiso';
          if (r.status >= 500 || r.status === 429) throw new Error('servidor ' + r.status);
          // 2xx enviado; 4xx (p. ej. 422) no se reintenta: la lectura se queda en local
        } else {
          if (modo === 'pages') continue; // sin token no se puede borrar en el servidor
          const r = await pedir('DELETE', API + '/medidas/' + encodeURIComponent(o.id));
          if (r.status === 401 || r.status === 403) return 'sin-permiso';
          if (r.status >= 500) throw new Error('servidor ' + r.status);
        }
        c = cola().filter((x) => !(x.op === o.op && x.id === o.id && JSON.stringify(x) === JSON.stringify(o)));
        guardarCola(c);
      }
      // 3. Bajar del servidor y fusionar.
      const g = await pedir('GET', API + '/medidas');
      if (g.status !== 200 || !g.datos || !Array.isArray(g.datos.readings)) throw new Error('lectura ' + g.status);
      const remoto = g.datos.readings;
      c = cola();
      const f = fusionar(cfg.getLecturas(), remoto, {
        pendientes: new Set(c.filter((o) => o.op === 'put').map((o) => o.id)),
        borrados: new Set(c.filter((o) => o.op === 'del').map((o) => o.id)),
        quitarAusentes: modo === 'mac' && remoto.length > 0
      });
      if (modo === 'mac' && f.descartados.length) {
        const ids = new Set(remoto.map((r) => r.id));
        let c2 = cola().filter((o) => !f.descartados.includes(o.id));
        for (const id of f.descartados) if (ids.has(id)) c2 = encolar(c2, { op: 'del', id });
        guardarCola(c2);
      }
      cfg.setLecturas(f.readings);
      return cola().some((o) => modo !== 'pages' || o.op === 'put') ? 'pendiente' : 'sincronizado';
    }

    async function sincronizar() {
      if (modo === 'local') return estado;
      if (enCurso) { repetir = true; return enCurso; }
      enCurso = (async () => {
        try {
          do {
            repetir = false;
            poner('sincronizando');
            let r;
            try { r = await ciclo(); } catch (e) { r = 'sin-conexion'; }
            poner(r);
          } while (repetir);
        } finally { enCurso = null; }
        return estado;
      })();
      return enCurso;
    }

    return { sincronizar, encolarPut, encolarDel, encolarPuts, cola, marca, modo, get estado() { return estado; } };
  }

  return { MAC_ORIGIN, KEY_COLA, KEY_MIGRADO, detectarModo, fusionar, encolar, clave, crear };
});
