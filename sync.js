'use strict';
/* =====================================================================
   sync.js — sincronización con la nube (Supabase, vía funciones RPC)
   ---------------------------------------------------------------------
   Flujo: subir registros pendientes (push) → bajar lo nuevo (pull).
   Cada registro gana por fecha de modificación (updatedAt). Los borrados
   viajan como lápidas. Si no hay señal, todo queda guardado en el
   dispositivo y se sube en cuanto vuelve la conexión.
   ===================================================================== */
const Sync = (() => {
  const CFG_KEY = 'midinero.sync';
  const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I para no confundir
  let cfg = loadCfg();
  let running = false, pendingAgain = false, timer = null, pollTimer = null;
  let listeners = [];
  let lastError = null;
  let lastOk = cfg.lastOk || 0;

  function loadCfg() { try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (e) { return {}; } }
  function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {} }

  function baseUrl() { return (cfg.url || (window.MD_CONFIG && window.MD_CONFIG.SUPABASE_URL) || '').replace(/\/+$/, ''); }
  function apiKey() { return cfg.key || (window.MD_CONFIG && window.MD_CONFIG.SUPABASE_KEY) || ''; }
  function configured() { return !!(baseUrl() && apiKey() && cfg.clave); }
  function serverReady() { return !!(baseUrl() && apiKey()); }

  function generarClave() {
    const bytes = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    let s = '';
    for (let i = 0; i < 16; i++) { s += ALFABETO[bytes[i] % ALFABETO.length]; if (i % 4 === 3 && i < 15) s += '-'; }
    return s;
  }
  function normalizarClave(s) {
    s = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/I/g, '1');
    // Devuelve en grupos de 4 para mostrar; la validación usa la versión sin guiones
    return s.match(/.{1,4}/g) ? s.match(/.{1,4}/g).join('-') : s;
  }
  function claveLimpia(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  async function rpc(name, body) {
    const url = baseUrl() + '/rest/v1/rpc/' + name;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'apikey': apiKey(), 'Authorization': 'Bearer ' + apiKey() },
        body: JSON.stringify(body)
      });
      const text = await res.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
      if (!res.ok) {
        const msg = (data && (data.message || data.hint || data.details)) || ('HTTP ' + res.status);
        throw new Error(msg);
      }
      return data;
    } finally { clearTimeout(to); }
  }

  function emit(status, msg) { listeners.forEach(fn => { try { fn(status, msg); } catch (e) {} }); }
  function onStatus(fn) { listeners.push(fn); }

  function info() {
    return { configured: configured(), serverReady: serverReady(), clave: cfg.clave || '', url: baseUrl(), key: apiKey(),
      lastOk, lastError, pending: Store.dirtyCount(), running, custom: !!(cfg.url || cfg.key) };
  }

  // Crea un espacio nuevo en la nube con una clave recién generada (desde la Mac, normalmente).
  async function crearEspacio(claveOpcional) {
    const clave = claveLimpia(claveOpcional || generarClave());
    await rpc('sync_crear_espacio', { p_clave: clave });
    cfg.clave = clave; cfg.lastPull = 0; saveCfg();
    Store.markAllDirty(App.state);
    return normalizarClave(clave);
  }

  // Vincula este dispositivo a un espacio que ya existe (desde el iPhone, normalmente).
  async function vincular(claveTexto) {
    const clave = claveLimpia(claveTexto);
    if (clave.length < 12) throw new Error('La clave está incompleta.');
    const r = await rpc('sync_pull', { p_clave: clave, p_desde: 0 });
    if (!r || typeof r !== 'object') throw new Error('Respuesta inesperada del servidor.');
    cfg.clave = clave; cfg.lastPull = 0; saveCfg();
    // Lo que ya había en este dispositivo también se sube (se mezcla con lo de la nube).
    Store.markAllDirty(App.state);
    return normalizarClave(clave);
  }

  function setServer(url, key) { cfg.url = (url || '').trim(); cfg.key = (key || '').trim(); saveCfg(); }
  function desvincular() { delete cfg.clave; cfg.lastPull = 0; saveCfg(); Store.clearAllDirty(); emit('off', 'Sin vincular'); }

  // Enlace / QR de vinculación: lleva servidor, llave pública y clave.
  function enlaceVinculacion() {
    if (!configured()) return '';
    const base = (window.MD_CONFIG && window.MD_CONFIG.APP_URL) || location.href.split('#')[0];
    const payload = { c: cfg.clave };
    if (cfg.url || cfg.key) { payload.u = baseUrl(); payload.k = apiKey(); }
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return base + '#vincular=' + b64;
  }
  function leerEnlace(texto) {
    const m = String(texto || '').match(/#vincular=([A-Za-z0-9_\-]+)/);
    if (!m) return null;
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(escape(atob(b64 + '==='.slice((b64.length + 3) % 4))));
      const p = JSON.parse(json);
      if (!p.c) return null;
      return { clave: claveLimpia(p.c), url: p.u || '', key: p.k || '' };
    } catch (e) { return null; }
  }

  // ---- Ciclo principal ----
  async function run(reason) {
    if (!configured()) return false;
    if (!navigator.onLine) { emit('offline', 'Sin conexión: se sincronizará después'); return false; }
    if (running) { pendingAgain = true; return false; }
    running = true; lastError = null; emit('busy', 'Sincronizando…');
    try {
      // 1) subir pendientes
      const pack = Store.packDirty(App.state);
      if (pack.registros.length) {
        for (let i = 0; i < pack.registros.length; i += 200) {
          await rpc('sync_push', { p_clave: cfg.clave, p_registros: pack.registros.slice(i, i + 200) });
        }
        Store.clearDirty(pack.list);
      }
      // 2) bajar lo nuevo (con 5 s de traslape por seguridad; mezclar es idempotente)
      const desde = Math.max(0, (cfg.lastPull || 0) - 5000);
      const r = await rpc('sync_pull', { p_clave: cfg.clave, p_desde: desde });
      const regs = (r && r.registros) || [];
      let changed = 0;
      if (regs.length) changed = Store.applyRemote(App.state, regs);
      if (r && r.hasta) cfg.lastPull = Math.max(cfg.lastPull || 0, Number(r.hasta));
      lastOk = Date.now(); cfg.lastOk = lastOk; saveCfg();
      running = false;
      if (changed) { Store.save(App.state); App.onRemoteChange(changed); }
      emit('ok', 'Sincronizado');
      return true;
    } catch (e) {
      lastError = e.message || String(e);
      running = false;
      emit('error', 'Error al sincronizar: ' + lastError);
      return false;
    } finally {
      running = false;
      if (pendingAgain) { pendingAgain = false; setTimeout(() => run('again'), 500); }
    }
  }

  // Sincroniza poco después de un cambio (agrupa varios cambios seguidos).
  function schedule() {
    if (!configured()) return;
    clearTimeout(timer);
    timer = setTimeout(() => run('change'), 1500);
  }

  function start() {
    window.addEventListener('online', () => run('online'));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') run('visible'); });
    window.addEventListener('focus', () => run('focus'));
    clearInterval(pollTimer);
    pollTimer = setInterval(() => run('poll'), 60000);
    run('start');
  }

  function fmtHace(ts) {
    if (!ts) return 'nunca';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'hace un momento';
    if (s < 3600) return 'hace ' + Math.round(s / 60) + ' min';
    if (s < 86400) return 'hace ' + Math.round(s / 3600) + ' h';
    return 'hace ' + Math.round(s / 86400) + ' días';
  }

  return { configured, serverReady, info, run, schedule, start, onStatus, crearEspacio, vincular, desvincular,
    setServer, enlaceVinculacion, leerEnlace, generarClave, normalizarClave, claveLimpia, fmtHace };
})();
