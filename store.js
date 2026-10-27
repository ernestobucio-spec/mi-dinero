'use strict';
/* =====================================================================
   store.js — almacenamiento local (localStorage) + modelo de datos v2
   ---------------------------------------------------------------------
   Cada registro tiene: id (texto único), updatedAt (ms) y, si se borró,
   deleted:true (lápida, para que el borrado también se sincronice).
   El saldo de una cuenta NO se guarda: es saldoInicial + movimientos.
   ===================================================================== */
const Store = (() => {
  const KEY = 'midinero.v2';
  const DIRTY_KEY = 'midinero.dirty';
  const COLS = ['accounts', 'categories', 'transactions', 'goals', 'debts', 'recurring'];

  const DEFAULT_CATS = ['Alimentos', 'Casa', 'Transporte', 'Servicios', 'Restaurantes', 'Entretenimiento', 'Salud', 'Compras', 'Otros'];

  function now() { return Date.now(); }
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function defaultState() {
    const t = now();
    return {
      version: 2,
      accounts: [
        { id: 'efectivo', name: 'Efectivo', type: 'corriente', saldoInicial: 0, updatedAt: t },
        { id: 'banco', name: 'Banco', type: 'corriente', saldoInicial: 0, updatedAt: t }
      ],
      categories: DEFAULT_CATS.map(n => ({ id: n, name: n, budget: 0, updatedAt: t })),
      transactions: [], goals: [], debts: [], recurring: [],
      selectedAccount: 'efectivo'
    };
  }

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }

  function load() {
    const raw = lsGet(KEY);
    if (!raw) return null;
    try { return normalize(JSON.parse(raw)); } catch (e) { return null; }
  }
  function save(state) { return lsSet(KEY, JSON.stringify(state)); }

  // Garantiza que el estado tenga todas las colecciones y campos.
  function normalize(s) {
    if (!s || typeof s !== 'object') return null;
    if (!s.version || s.version < 2) return migrateV1(s);
    COLS.forEach(c => { if (!Array.isArray(s[c])) s[c] = []; });
    COLS.forEach(c => s[c].forEach(r => { if (r.id == null) r.id = newId(); r.id = String(r.id); if (!r.updatedAt) r.updatedAt = now(); }));
    if (!s.selectedAccount) s.selectedAccount = (s.accounts.find(a => !a.deleted) || {}).id;
    return s;
  }

  // ---- Migración desde Mi Dinero Pro 1.x (ids numéricos, saldo guardado en la cuenta) ----
  function effectV1(t, id) {
    if (t.kind === 'gasto') return t.account === id ? -t.amount : 0;
    if (t.kind === 'ingreso') return t.account === id ? t.amount : 0;
    if (t.kind === 'traspaso') { if (t.account === id) return -t.amount; if (t.accountTo === id) return t.amount; }
    return 0;
  }
  function migrateV1(old) {
    const t = now();
    const s = { version: 2, accounts: [], categories: [], transactions: [], goals: [], debts: [], recurring: [], selectedAccount: old.selectedAccount };
    const txs = Array.isArray(old.transactions) ? old.transactions : [];
    (old.accounts || []).forEach(a => {
      const moved = txs.reduce((sum, x) => sum + effectV1(x, a.id), 0);
      s.accounts.push({ id: String(a.id), name: a.name, type: a.type || 'corriente', saldoInicial: Math.round(((a.balance || 0) - moved) * 100) / 100, updatedAt: t });
    });
    let cats = old.categories || [];
    if (cats.length && typeof cats[0] === 'string') cats = cats.map(n => ({ name: n, budget: 0 }));
    cats.forEach(c => s.categories.push({ id: c.name, name: c.name, budget: c.budget || 0, updatedAt: t }));
    txs.forEach(x => { const r = Object.assign({}, x); r.id = String(x.id); r.updatedAt = t; s.transactions.push(r); });
    (old.goals || []).forEach(g => s.goals.push(Object.assign({}, g, { id: String(g.id), updatedAt: t })));
    (old.debts || []).forEach(d => s.debts.push(Object.assign({}, d, { id: String(d.id), updatedAt: t })));
    (old.recurring || []).forEach(r => s.recurring.push(Object.assign({}, r, { id: String(r.id), updatedAt: t })));
    if (!s.accounts.length) s.accounts = defaultState().accounts;
    if (!s.categories.length) s.categories = defaultState().categories;
    if (!s.selectedAccount) s.selectedAccount = s.accounts[0].id;
    return s;
  }

  // ---- Registros pendientes de subir a la nube ("sucios") ----
  function dirtyLoad() { try { return JSON.parse(lsGet(DIRTY_KEY) || '{}'); } catch (e) { return {}; } }
  function dirtySave(d) { lsSet(DIRTY_KEY, JSON.stringify(d)); }
  function markDirty(col, id) { const d = dirtyLoad(); d[col + '/' + id] = 1; dirtySave(d); }
  function markAllDirty(state) { const d = {}; COLS.forEach(c => state[c].forEach(r => { d[c + '/' + r.id] = 1; })); dirtySave(d); }
  function dirtyList() { return Object.keys(dirtyLoad()).map(k => { const i = k.indexOf('/'); return { col: k.slice(0, i), id: k.slice(i + 1) }; }); }
  function clearDirty(list) { const d = dirtyLoad(); list.forEach(x => { delete d[x.col + '/' + x.id]; }); dirtySave(d); }
  function dirtyCount() { return Object.keys(dirtyLoad()).length; }
  function clearAllDirty() { dirtySave({}); }

  // ---- Aplicar registros que llegan de la nube (gana el más reciente) ----
  // Devuelve cuántos registros cambiaron localmente.
  function applyRemote(state, registros) {
    let changed = 0;
    const dirty = dirtyLoad();
    registros.forEach(r => {
      if (!COLS.includes(r.tipo)) return;
      const col = state[r.tipo];
      const idx = col.findIndex(x => x.id === r.id);
      const remoteTs = Number(r.actualizado) || 0;
      const rec = Object.assign({}, r.datos || {}, { id: r.id, updatedAt: remoteTs });
      if (r.borrado) rec.deleted = true; else delete rec.deleted;
      if (idx === -1) { col.push(rec); changed++; return; }
      const local = col[idx];
      const localTs = Number(local.updatedAt) || 0;
      if (remoteTs > localTs || (remoteTs === localTs && !dirty[r.tipo + '/' + r.id])) {
        col[idx] = rec; changed++;
        // Si la nube ya tiene esta versión, no hace falta subirla.
        if (remoteTs >= localTs) delete dirty[r.tipo + '/' + r.id];
      }
    });
    dirtySave(dirty);
    return changed;
  }

  // Empaqueta los registros sucios para subirlos.
  function packDirty(state) {
    const list = dirtyList();
    const out = [];
    list.forEach(x => {
      const rec = (state[x.col] || []).find(r => r.id === x.id);
      if (!rec) return;
      const datos = Object.assign({}, rec); delete datos.id; delete datos.updatedAt; delete datos.deleted;
      out.push({ tipo: x.col, id: rec.id, datos, actualizado: Number(rec.updatedAt) || now(), borrado: !!rec.deleted });
    });
    return { list, registros: out };
  }

  return { COLS, KEY, newId, now, defaultState, load, save, normalize, migrateV1,
    markDirty, markAllDirty, dirtyList, dirtyCount, clearDirty, clearAllDirty, applyRemote, packDirty };
})();
