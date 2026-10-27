'use strict';
/* =====================================================================
   Mi Dinero Pro 2 — misma app en iPhone (web) y Mac (Electron).
   Datos locales (store.js) + sincronización en la nube (sync.js).
   ===================================================================== */

/* ----------------------------- Constantes ----------------------------- */
const MES_CORTO = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const MES_LARGO = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const CAT_ICON = {
  'Alimentos':'🧺','Casa':'🏠','Renta':'🏠','Transporte':'🚗','Servicios':'💡','Entretenimiento':'🎬',
  'Salud':'➕','Compras':'🛍️','Educación':'📚','Restaurantes':'🍽️','Mascotas':'🐾','Varios':'📦',
  'Mobiliario':'🛋️','Ingresos':'💰','Sueldo':'💵','Gasolina':'⛽','Ropa':'👕','Otros':'•'
};
const GOAL_ICONS = ['🎯','🏖️','🚗','🏠','💍','🎓','💻','✈️','🛡️','🎁','👶','📈'];
const DEBT_ICONS = ['💳','🏦','🚗','🏠','🎓','📱','🧾','💰'];
function catIco(name){ return CAT_ICON[name] || '•'; }
const IS_ELECTRON = !!(window.api && window.api.isElectron);

let state;
let view = 'resumen';
const today = new Date();
let calY = today.getFullYear(), calM = today.getMonth();
let selDay = isoOf(today);
let infY = today.getFullYear(), infM = today.getMonth();
let infType = 'ig';
let searchQ = '';
let saldoModo = 'mov';
let conteoTimer = null;
let editTxId = null, editKind = 'gasto';
let editAccId = null, editGoalId = null, contribGoalId = null, budgetCatName = null;
let editDebtId = null, payDebtId = null;
let pendingRemoteRender = false;

/* ----------------------------- Utilidades ----------------------------- */
function isoOf(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function parseISO(s){ const [y,m,d]=String(s).split('-').map(Number); return new Date(y,m-1,d); }
function addMonth(iso){ const d=parseISO(iso); d.setMonth(d.getMonth()+1); return isoOf(d); }
function fmt(n){
  n = Number(n)||0;
  const neg = n < 0; n = Math.abs(Math.round((n+Number.EPSILON)*100)/100);
  const dec = Number.isInteger(n) ? 0 : 2;
  const s = n.toLocaleString('en-US',{ minimumFractionDigits:dec, maximumFractionDigits:2 });
  return (neg?'-$':'$') + s;
}
function shortDate(iso){ const d = parseISO(iso); return MES_CORTO[d.getMonth()] + ' ' + d.getDate(); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function live(col){ return state[col].filter(r=>!r.deleted); }
const accounts = ()=>live('accounts'), categories = ()=>live('categories'), transactions = ()=>live('transactions');
const goals = ()=>live('goals'), debts = ()=>live('debts'), recurring = ()=>live('recurring');
function acc(id){ return state.accounts.find(a=>a.id===id && !a.deleted); }
function catObj(name){ return state.categories.find(c=>c.name===name && !c.deleted); }
function affects(t,id){ return t.account===id || t.accountTo===id; }
function effect(t,id){
  if(t.kind==='gasto')   return t.account===id ? -t.amount : 0;
  if(t.kind==='ingreso') return t.account===id ?  t.amount : 0;
  if(t.kind==='traspaso'){ if(t.account===id) return -t.amount; if(t.accountTo===id) return t.amount; }
  return 0;
}
function balanceOf(a){ return (Number(a.saldoInicial)||0) + transactions().reduce((s,t)=>s+effect(t,a.id),0); }
function inMonth(iso,y,m){ const d=parseISO(iso); return d.getFullYear()===y && d.getMonth()===m; }
function totalAssets(){ return accounts().reduce((s,a)=>s+balanceOf(a),0); }
function totalDebt(){ return debts().reduce((s,d)=>s+(Number(d.balance)||0),0); }
function totalNetWorth(){ return totalAssets() - totalDebt(); }
function byDateAsc(a,b){ return a.date===b.date ? ((a.updatedAt||0)-(b.updatedAt||0)) : (a.date<b.date?-1:1); }
function byDateDesc(a,b){ return a.date===b.date ? ((b.updatedAt||0)-(a.updatedAt||0)) : (a.date<b.date?1:-1); }
function monthTotals(y,m){
  let ing=0, gas=0;
  transactions().forEach(t=>{ if(!inMonth(t.date,y,m))return;
    if(t.kind==='ingreso') ing+=t.amount; else if(t.kind==='gasto') gas+=t.amount; });
  return { ing, gas, net: ing-gas };
}
function isMobile(){ return window.matchMedia('(max-width: 859px)').matches; }

/* ----------------------------- Persistencia ----------------------------- */
function persist(){ Store.save(state); }
// Marca un registro como modificado: fecha + pendiente de subir + guardar.
function touch(col, rec){ rec.updatedAt = Store.now(); Store.markDirty(col, rec.id); persist(); Sync.schedule(); }
function removeRec(col, id){ const r=state[col].find(x=>x.id===id); if(!r) return; r.deleted=true; touch(col, r); }
function addRec(col, rec){ if(!rec.id) rec.id=Store.newId(); state[col].push(rec); touch(col, rec); return rec; }
function setSelected(id){ state.selectedAccount=id; persist(); }

let toastTimer=null;
function toast(msg, ms){
  const t=document.getElementById('toast'); t.textContent=msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.add('hidden'), ms||2600);
}

/* ----------------------------- Init ----------------------------- */
async function init(){
  state = Store.load();
  if(!state && IS_ELECTRON){
    // Primera vez en la Mac con la versión 2: importa los datos de Mi Dinero Pro 1.x
    try { const old = await window.api.loadLegacy(); if(old){ state = Store.normalize(old); Store.markAllDirty(state); persist(); } } catch(e){}
  }
  if(!state){ state = Store.defaultState(); persist(); }
  window.App = { state, onRemoteChange };
  document.getElementById('hoy-ico').textContent = today.getDate();
  applyTema();
  bindChrome(); bindKeys(); bindSync(); bindTema();
  handleLinkHash();
  render();
  if('serviceWorker' in navigator && !IS_ELECTRON && location.protocol.startsWith('http')){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
  Sync.start();
}

function onRemoteChange(n){
  if(modalOpen()){ pendingRemoteRender=true; return; }
  render();
  toast(n===1 ? 'Se actualizó 1 registro desde la nube' : `Se actualizaron ${n} registros desde la nube`);
}

function bindKeys(){
  document.addEventListener('keydown', e=>{
    if(e.key==='Escape'){ closeAll(); }
    if((e.key==='n'||e.key==='N') && !modalOpen() && !/input|select|textarea/i.test(e.target.tagName)){ openTxModal(null); }
  });
}
function modalOpen(){ return [...document.querySelectorAll('.modal-overlay')].some(m=>!m.classList.contains('hidden')); }
function closeAll(){ document.querySelectorAll('.modal-overlay').forEach(m=>m.classList.add('hidden')); stopScan(); afterModalClose(); }
function hide(id){ document.getElementById(id).classList.add('hidden'); afterModalClose(); }
function show(id){ document.getElementById(id).classList.remove('hidden'); }
function afterModalClose(){ if(pendingRemoteRender && !modalOpen()){ pendingRemoteRender=false; render(); } }

/* ----------------------------- Navegación ----------------------------- */
function bindChrome(){
  document.querySelectorAll('[data-view]').forEach(b=> b.addEventListener('click',()=> navTo(b.dataset.view)));
  document.getElementById('btn-add').addEventListener('click', ()=> openTxModal(null));
  document.getElementById('tab-add').addEventListener('click', ()=> openTxModal(null));
  document.getElementById('btn-edit').addEventListener('click', ()=>{
    if(view==='saldo') openAccModal(null);
    else if(view==='metas') openGoalModal(null);
    else if(view==='deudas') openDebtModal(null);
  });
  // movimiento
  document.getElementById('btn-cancel').addEventListener('click', ()=>hide('modal-overlay'));
  document.getElementById('btn-save').addEventListener('click', saveTx);
  document.getElementById('btn-delete').addEventListener('click', deleteTx);
  document.querySelectorAll('.mtab').forEach(t=> t.addEventListener('click',()=>{ editKind=t.dataset.kind; syncModalKind(); }));
  document.getElementById('f-category').addEventListener('change', e=>{
    if(e.target.value!=='__nueva') return;
    const n=prompt('Nombre de la nueva categoría:');
    if(n && n.trim()){ const name=n.trim(); if(!catObj(name)) addRec('categories',{id:name,name,budget:0}); fillSelectors(); e.target.value=name; }
    else { fillSelectors(); }
  });
  // cuenta
  document.getElementById('a-cancel').addEventListener('click', ()=>hide('acc-overlay'));
  document.getElementById('a-save').addEventListener('click', saveAcc);
  document.getElementById('a-delete').addEventListener('click', deleteAcc);
  // meta
  document.getElementById('g-cancel').addEventListener('click', ()=>hide('goal-overlay'));
  document.getElementById('g-save').addEventListener('click', saveGoal);
  document.getElementById('g-delete').addEventListener('click', deleteGoal);
  document.getElementById('c-cancel').addEventListener('click', ()=>hide('contrib-overlay'));
  document.getElementById('c-save').addEventListener('click', saveContrib);
  // presupuesto
  document.getElementById('b-cancel').addEventListener('click', ()=>hide('budget-overlay'));
  document.getElementById('b-save').addEventListener('click', saveBudget);
  // deuda
  document.getElementById('d-cancel').addEventListener('click', ()=>hide('debt-overlay'));
  document.getElementById('d-save').addEventListener('click', saveDebt);
  document.getElementById('d-delete').addEventListener('click', deleteDebt);
  document.getElementById('dp-cancel').addEventListener('click', ()=>hide('dpay-overlay'));
  document.getElementById('dp-save').addEventListener('click', saveDebtPayment);
  document.getElementById('dp-fromacc').addEventListener('change', e=>{ document.getElementById('dp-acc-label').style.display = e.target.checked?'flex':'none'; });
  // datos
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('st-close').addEventListener('click', ()=>hide('settings-overlay'));
  document.getElementById('st-backup').addEventListener('click', doBackup);
  document.getElementById('st-restore').addEventListener('click', doRestore);
  document.getElementById('st-file').addEventListener('change', onRestoreFile);
  document.getElementById('st-wipe').addEventListener('click', doWipe);
  document.getElementById('st-tema').addEventListener('click', ()=>{ hide('settings-overlay'); openTema(); });
  // nube
  document.getElementById('sync-btn').addEventListener('click', openSync);
  document.getElementById('sync-pill').addEventListener('click', openSync);
  document.getElementById('sy-close').addEventListener('click', ()=>hide('sync-overlay'));
  document.getElementById('scan-cancel').addEventListener('click', ()=>{ stopScan(); hide('scan-overlay'); });
  // cerrar al tocar el fondo
  document.querySelectorAll('.modal-overlay').forEach(o=>o.addEventListener('mousedown', e=>{ if(e.target===o){ if(o.id==='scan-overlay') stopScan(); o.classList.add('hidden'); afterModalClose(); } }));
}

const TITLES = { resumen:'Resumen', saldo:'Saldo', hoy:()=>MES_LARGO[calM]+' '+calY,
  presupuesto:()=>MES_CORTO[infM]+' '+infY, metas:'Metas de ahorro', deudas:'Deudas', informes:'Informes', mas:'Más' };
function setTitle(){
  const t = TITLES[view];
  document.getElementById('topbar-title').textContent = typeof t==='function'? t() : t;
  const editable = (view==='saldo'||view==='metas'||view==='deudas');
  const be=document.getElementById('btn-edit');
  be.style.visibility = editable ? 'visible':'hidden';
  be.textContent = (view==='metas'||view==='deudas') ? 'Nueva' : (isMobile()?'+ Cuenta':'Editar');
  document.getElementById('btn-add').style.visibility = (view==='informes'||view==='metas'||view==='deudas') ? 'hidden':'visible';
}
function navTo(v){
  view=v;
  document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('active', x.dataset.view===v));
  render();
}
function render(){
  setTitle();
  const root = document.getElementById('view-root');
  const fn = { resumen:renderResumen, saldo:renderSaldo, hoy:renderHoy, presupuesto:renderPresupuesto,
    metas:renderMetas, deudas:renderDeudas, informes:renderInformes, mas:renderMas }[view] || renderResumen;
  root.innerHTML = fn();
  root.scrollTop = 0;
  wireView();
}

/* ----------------------------- Vista: Resumen ----------------------------- */
function renderResumen(){
  const nw = totalNetWorth();
  const t = monthTotals(today.getFullYear(), today.getMonth());
  const rate = t.ing>0 ? Math.round((t.net/t.ing)*100) : 0;
  const assets = totalAssets(), debt = totalDebt();

  const spend = {};
  transactions().forEach(x=>{ if(x.kind==='gasto'&&inMonth(x.date,today.getFullYear(),today.getMonth())) spend[x.category]=(spend[x.category]||0)+x.amount; });
  const budgeted = categories().filter(c=>c.budget>0);
  let budHtml;
  if(budgeted.length){
    budHtml = budgeted.slice(0,5).map(c=>{
      const sp = spend[c.name]||0; const pct = Math.min(100, sp/c.budget*100);
      const cls = sp>c.budget?'over':(pct>80?'warn':'');
      return `<div class="bud-line"><div class="b-ico">${catIco(c.name)}</div><div class="b-mid">
        <div class="b-name"><span>${esc(c.name)}</span><span>${fmt(sp)} / ${fmt(c.budget)}</span></div>
        <div class="track"><i class="${cls}" style="width:${pct}%"></i></div></div></div>`;
    }).join('');
  } else budHtml = `<div class="dash-empty">Aún no asignas presupuestos. <span class="more" data-go="presupuesto">Configurar →</span></div>`;

  let goalHtml;
  const gs=goals();
  if(gs.length){
    goalHtml = gs.slice(0,3).map(g=>{
      const pct = g.target>0?Math.min(100, g.saved/g.target*100):0;
      return `<div class="goal-mini" data-goal="${g.id}"><div class="g-ico">${g.icon||'🎯'}</div><div class="g-mid">
        <div class="g-top"><span>${esc(g.name)}</span><span class="g-pct">${Math.round(pct)}%</span></div>
        <div class="track"><i style="width:${pct}%"></i></div></div>
        <div style="text-align:right"><div style="font-weight:600">${fmt(g.saved)}</div><div style="font-size:11px;color:var(--muted)">de ${fmt(g.target)}</div></div></div>`;
    }).join('');
  } else goalHtml = `<div class="dash-empty">Crea tu primera meta de ahorro. <span class="more" data-go="metas">Crear meta →</span></div>`;

  const up = upcomingItems(30);
  const upHtml = up.length ? up.slice(0,5).map(u=>`
      <div class="up-row"><div class="u-ico">${u.icon}</div><div class="u-mid">
        <div class="u-name">${esc(u.desc)}</div><div class="u-date">${shortDate(u.date)}${u.recurring?' · mensual':''}</div></div>
        <div class="u-amt">${fmt(u.amount)}</div>
        ${u.recurring?`<button class="pay-btn" data-pay="${u.id}">Pagar</button>`:''}</div>`).join('')
    : `<div class="dash-empty">Sin pagos próximos.</div>`;

  const recent = transactions().slice().sort(byDateDesc).slice(0,6);
  const recHtml = recent.length ? recent.map(x=>{
    const sign = x.kind==='ingreso'?'+':(x.kind==='gasto'?'-':'');
    const col = x.kind==='ingreso'?'var(--green)':(x.kind==='gasto'?'var(--red)':'var(--text)');
    return `<div class="up-row" data-tx="${x.id}" style="cursor:pointer"><div class="u-ico">${x.kind==='traspaso'?'🔄':catIco(x.category)}</div>
      <div class="u-mid"><div class="u-name">${esc(x.desc)}</div><div class="u-date" style="color:var(--muted)">${shortDate(x.date)} · ${esc(acc(x.account)?.name||'')}</div></div>
      <div class="u-amt" style="color:${col}">${sign}${fmt(x.amount)}</div></div>`;
  }).join('') : `<div class="dash-empty">Aún no hay movimientos. Pulsa “+” para registrar el primero.</div>`;

  return `<div class="dash">
    <div class="dash-hero"><div class="label">Patrimonio neto</div><div class="net">${fmt(nw)}</div>
      <div class="sub">Activos ${fmt(assets)}${debt>0?` · Deudas ${fmt(debt)}`:''}</div>${temaActual()==='madrid'?'<div class="hala">¡Hala Madrid!</div>':''}</div>
    <div class="kpis">
      <div class="kpi"><div class="k-label">Ingresos</div><div class="k-val" style="color:var(--green)">${fmt(t.ing)}</div><div class="k-foot">${MES_LARGO[today.getMonth()]}</div></div>
      <div class="kpi"><div class="k-label">Gastos</div><div class="k-val" style="color:var(--red)">${fmt(t.gas)}</div><div class="k-foot">${MES_LARGO[today.getMonth()]}</div></div>
      <div class="kpi"><div class="k-label">Ahorro</div><div class="k-val" style="color:${t.net<0?'var(--red)':'var(--green)'}">${fmt(t.net)}</div><div class="k-foot savings-rate">Tasa: ${rate}%</div></div>
    </div>
    <div class="dash-sec-title">Presupuesto del mes <span class="more" data-go="presupuesto">Ver todo</span></div>
    <div class="dash-card">${budHtml}</div>
    <div class="dash-sec-title">Metas de ahorro <span class="more" data-go="metas">Ver todo</span></div>
    <div class="dash-card">${goalHtml}</div>
    <div class="dash-sec-title">Próximos pagos</div>
    <div class="dash-card">${upHtml}</div>
    <div class="dash-sec-title">Movimientos recientes <span class="more" data-go="saldo">Ver todo</span></div>
    <div class="dash-card">${recHtml}</div>
  </div>`;
}

function upcomingItems(days){
  const limit = new Date(today); limit.setDate(limit.getDate()+days);
  const out = [];
  recurring().filter(r=>r.active!==false).forEach(r=>{
    if(parseISO(r.nextDate) <= limit) out.push({ id:r.id, desc:r.desc, amount:r.amount, date:r.nextDate, icon:catIco(r.category), recurring:true });
  });
  transactions().filter(t=>t.planned && t.date >= isoOf(today) && parseISO(t.date)<=limit)
    .forEach(t=> out.push({ id:t.id, desc:t.desc, amount:t.amount, date:t.date, icon:t.kind==='traspaso'?'🔄':catIco(t.category), recurring:false }));
  return out.sort(byDateAsc);
}

/* ----------------------------- Vista: Saldo ----------------------------- */
function runningFor(id){
  const a=acc(id); if(!a) return {};
  const txs = transactions().filter(t=>affects(t,id)).slice().sort(byDateAsc);
  let bal = Number(a.saldoInicial)||0; const map={};
  for(const t of txs){ bal += effect(t,id); map[t.id]=bal; }
  return map;
}
function segHtml(modo){
  return `<div class="seg"><button class="seg-btn ${modo==='mov'?'active':''}" data-modo="mov">Movimientos</button><button class="seg-btn ${modo==='conteo'?'active':''}" data-modo="conteo">Conteo de efectivo</button></div>`;
}
function renderSaldo(){
  if(saldoModo==='conteo') return renderConteo();
  const accs=accounts();
  if(!accs.some(a=>a.id===state.selectedAccount)) state.selectedAccount = accs[0] && accs[0].id;
  const corr = accs.filter(a=>a.type!=='credito'), cred = accs.filter(a=>a.type==='credito');
  const totCorr = corr.reduce((s,a)=>s+balanceOf(a),0), totCred = cred.reduce((s,a)=>s+balanceOf(a),0);
  const sel = state.selectedAccount;
  const accRow = a => { const b=balanceOf(a); return `<div class="acc-row ${a.id===sel?'selected':''}" data-acc="${a.id}">
      <div class="acc-ico">${a.type==='credito'?'💳':'👛'}</div>
      <div class="acc-info"><div class="acc-name">${esc(a.name)}</div>
      <div class="acc-balance ${b<0?'neg':'pos'}">${fmt(b)}</div><div class="acc-edit" data-edit-acc="${a.id}">Editar</div></div>
      ${a.id===sel?'<span class="check">✓</span>':''}</div>`; };

  let txs = transactions().filter(t=>affects(t,sel)).slice().sort(byDateDesc);
  const run = runningFor(sel);
  if(searchQ){ const q=searchQ.toLowerCase(); txs = txs.filter(t=> (t.desc||'').toLowerCase().includes(q) || (t.category||'').toLowerCase().includes(q)); }
  const txHtml = txs.length ? txs.map(t=>{
    const e = effect(t,sel);
    const cls = t.kind==='traspaso' ? 'traspaso' : (e<0?'gasto':'ingreso');
    return `<div class="tx-row" data-tx="${t.id}"><div class="tx-ico">${t.kind==='traspaso'?'🔄':catIco(t.category)}</div>
      <div class="tx-main"><div class="tx-title">${esc(t.desc)}${t.planned?' ⏱':''}</div><div class="tx-sub">${shortDate(t.date)}${t.category?' · '+esc(t.category):''}</div></div>
      <div class="tx-right"><span class="tx-amount ${cls}">${fmt(Math.abs(t.amount))}</span><div class="tx-running">${fmt(run[t.id])}</div></div></div>`;
  }).join('') : '<div class="empty">Sin movimientos para esta cuenta</div>';

  return `<div class="saldo-outer">${segHtml('mov')}<div class="saldo-wrap"><div class="accounts-col">
      <div class="section-head"><span>Cuentas</span><span class="total">${fmt(totCorr)}</span></div>
      ${corr.map(accRow).join('')}
      <div class="section-head"><span>Tarjetas de crédito</span><span class="total">${fmt(totCred)}</span></div>
      ${cred.map(accRow).join('')||'<div class="empty" style="padding:14px 16px">Ninguna</div>'}
      <div class="add-account" id="add-acc">+ Cuenta</div>
    </div><div class="tx-col">
      <div class="search-wrap"><input id="tx-search" type="search" placeholder="🔍  Buscar movimientos…" value="${esc(searchQ)}" /></div>
      ${txHtml}</div></div></div>`;
}


/* ----------------------------- Vista: Conteo de efectivo ----------------------------- */
const CONTEO_BILLETES=[5,10,20,50,100,200,500,1000];
const CONTEO_PACAS=[2000,5000,10000,20000,50000];
function conteoRec(){
  if(!Array.isArray(state.conteos)) state.conteos=[];
  let r=state.conteos.find(x=>x.id==='caja' && !x.deleted);
  if(!r){ r={ id:'caja', cant:{}, updatedAt:Store.now() }; state.conteos.push(r); }
  if(!r.cant) r.cant={};
  return r;
}
function conteoTotales(c){
  let b=0,p=0;
  CONTEO_BILLETES.forEach(d=>{ b+=d*(Number(c['b'+d])||0); });
  CONTEO_PACAS.forEach(d=>{ p+=d*(Number(c['p'+d])||0); });
  return { b, p, t:b+p };
}
function renderConteo(){
  const r=conteoRec(); const c=r.cant; const t=conteoTotales(c);
  const fila=(k,d)=>`<div class="ct-row"><input class="ct-in" data-k="${k}" type="number" inputmode="numeric" min="0" placeholder="0" value="${c[k]?esc(c[k]):''}" /><span class="ct-den">${fmt(d)}</span><span class="ct-sub" data-sub="${k}">${fmt(d*(Number(c[k])||0))}</span></div>`;
  const head=`<div class="ct-head"><span>Cantidad</span><span>Denominación</span><span>Subtotal</span></div>`;
  return `<div class="conteo-wrap">${segHtml('conteo')}
    <div class="ct-grid">
      <div class="ct-card"><div class="ct-title">Billetes y monedas</div>${head}
        ${CONTEO_BILLETES.map(d=>fila('b'+d,d)).join('')}
        <div class="ct-tot"><span>Subtotal billetes</span><b id="ct-b">${fmt(t.b)}</b></div></div>
      <div class="ct-card"><div class="ct-title">Pacas</div>${head}
        ${CONTEO_PACAS.map(d=>fila('p'+d,d)).join('')}
        <div class="ct-tot"><span>Subtotal pacas</span><b id="ct-p">${fmt(t.p)}</b></div>
        <div class="ct-tot grand"><span>Total caja fuerte</span><b id="ct-t">${fmt(t.t)}</b></div>
        <div class="ct-note">El total de la caja = billetes + pacas. El conteo se guarda solo y se sincroniza entre tus dispositivos.</div></div>
    </div>
    <div class="ct-actions"><button class="btn" id="ct-clear">Limpiar todo</button><button class="btn primary" id="ct-apply">Ajustar saldo de Efectivo al total</button></div>
  </div>`;
}
function conteoInput(inp){
  const r=conteoRec(); const k=inp.dataset.k; const v=Math.max(0, Math.floor(Number(inp.value)||0));
  if(v) r.cant[k]=v; else delete r.cant[k];
  const d=Number(k.slice(1)); const sub=document.querySelector(`[data-sub="${k}"]`); if(sub) sub.textContent=fmt(d*v);
  const t=conteoTotales(r.cant);
  const eb=document.getElementById('ct-b'), ep=document.getElementById('ct-p'), et=document.getElementById('ct-t');
  if(eb) eb.textContent=fmt(t.b); if(ep) ep.textContent=fmt(t.p); if(et) et.textContent=fmt(t.t);
  clearTimeout(conteoTimer); conteoTimer=setTimeout(()=>touch('conteos', r), 600);
}
function conteoClear(){
  if(!confirm('¿Poner todas las cantidades en cero?')) return;
  const r=conteoRec(); r.cant={}; touch('conteos', r); render();
}
function conteoApply(){
  const r=conteoRec(); const t=conteoTotales(r.cant).t;
  const accs=accounts(); if(!accs.length) return;
  const a = accs.find(x=>/efectivo|caja/i.test(x.name)) || acc(state.selectedAccount) || accs[0];
  const cur=balanceOf(a);
  if(!confirm(`La cuenta "${a.name}" tiene ${fmt(cur)} y el conteo da ${fmt(t)}. ¿Ajustar su saldo a ${fmt(t)}?`)) return;
  a.saldoInicial = Math.round(((Number(a.saldoInicial)||0) + (t-cur))*100)/100; touch('accounts', a);
  toast(`Saldo de ${a.name} ajustado a ${fmt(t)}`);
}

/* ----------------------------- Vista: Hoy ----------------------------- */
function renderHoy(){
  const startDow = new Date(calY, calM, 1).getDay();
  const daysInMonth = new Date(calY, calM+1, 0).getDate();
  const prevDays = new Date(calY, calM, 0).getDate();
  const dows = ['dom','lun','mar','mié','jue','vie','sáb'];
  const dayHas = {};
  transactions().forEach(t=>{ if(inMonth(t.date,calY,calM)) dayHas[parseISO(t.date).getDate()]=true; });
  let cells='';
  dows.forEach(d=> cells+=`<div class="cal-dow">${d}</div>`);
  for(let i=0;i<startDow;i++) cells+=`<div class="cal-cell muted">${prevDays-startDow+1+i}</div>`;
  for(let d=1; d<=daysInMonth; d++){
    const iso = calY+'-'+String(calM+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    cells+=`<div class="cal-cell ${iso===selDay?'today':''}" data-day="${iso}">${d}${dayHas[d]?'<span class="cal-dot"></span>':''}</div>`;
  }
  const trail=(7-((startDow+daysInMonth)%7))%7;
  for(let i=1;i<=trail;i++) cells+=`<div class="cal-cell muted">${i}</div>`;

  const planned = upcomingItems(60);
  const paid = transactions().filter(t=>t.date===selDay && !t.planned).sort(byDateAsc);
  const totalPaid = paid.reduce((s,t)=> s+(t.kind==='gasto'?t.amount:0),0);
  const itemHtml = (t,ico)=>`<div class="hoy-item" ${t.recurring?'':`data-tx="${t.id}"`}><div class="tx-ico">${ico}</div>
      <div class="h-name">${esc(t.desc)}<div class="h-date">${shortDate(t.date)}${t.recurring?' · mensual':''}</div></div>
      <span class="tx-amount ${t.kind==='ingreso'?'ingreso':(t.kind==='traspaso'?'traspaso':'gasto')}">${fmt(t.amount)}</span></div>`;

  return `<div class="hoy-wrap"><div class="cal-col">
      <div class="cal-title"><b>${MES_LARGO[calM]}</b> ${calY}</div>
      <div class="cal-grid">${cells}</div>
      <div class="cal-nav"><button id="cal-prev">‹</button><button class="today-btn" id="cal-today">Hoy</button><button id="cal-next">›</button></div>
    </div><div class="hoy-side">
      <div class="hoy-sec-title">Movimientos del ${shortDate(selDay)}</div>
      ${paid.length? paid.map(t=>itemHtml(t, t.kind==='traspaso'?'🔄':catIco(t.category))).join('') : '<div class="empty" style="padding:14px 0">Sin movimientos este día</div>'}
      <div class="hoy-total">Gastos del día: <b>${fmt(totalPaid)}</b></div>
      <div class="hoy-sec-title">Planificados</div>
      ${planned.length? planned.map(t=>itemHtml(t,t.icon)).join('') : '<div class="empty" style="padding:14px 0">Nada planificado</div>'}
    </div></div>`;
}

/* ----------------------------- Vista: Presupuesto ----------------------------- */
function renderPresupuesto(){
  const tot = monthTotals(infY, infM);
  const nets=[]; let maxAbs=1;
  for(let m=0;m<12;m++){ const n=monthTotals(infY,m).net; nets.push(n); maxAbs=Math.max(maxAbs,Math.abs(n)); }
  const bars = nets.map((n,m)=>{
    const h=Math.round(Math.abs(n)/maxAbs*100);
    return `<div class="pre-bar-col" data-bm="${m}">${n>=0?`<div class="pre-bar g" style="height:${h}%;opacity:${m===infM?1:.8}"></div>`:''}
      <div class="pre-bar-base"></div>${n<0?`<div class="pre-bar r" style="height:${h}%"></div>`:''}
      <div class="pre-bar-lbl">${MES_CORTO[m][0].toUpperCase()}</div></div>`;
  }).join('');
  const spend={};
  transactions().forEach(t=>{ if(t.kind==='gasto'&&inMonth(t.date,infY,infM)) spend[t.category]=(spend[t.category]||0)+t.amount; });
  const names = new Set([...categories().filter(c=>c.budget>0).map(c=>c.name), ...Object.keys(spend)]);
  const cats = [...names].sort((a,b)=> (spend[b]||0)-(spend[a]||0));
  const totalBudget = categories().reduce((s,c)=>s+(c.budget||0),0);
  const restante = totalBudget - tot.gas;
  const catHtml = cats.length ? cats.map(c=>{
    const sp=spend[c]||0; const bud=(catObj(c)?.budget)||0;
    const ring = bud>0 ? (sp>bud?'':(sp/bud>0.8?'warn':'ok')) : '';
    return `<div class="cat-item" data-cat="${esc(c)}"><div class="cat-circle ${ring}">${catIco(c)}</div>
      <div class="cat-name">${esc(c)}</div><div class="cat-spent">${fmt(sp)}</div>
      <div class="cat-budget ${bud>0?'set':''}">${bud>0?fmt(bud):'sin límite'}</div></div>`;
  }).join('') : '<div class="empty">Sin gastos ni presupuestos este mes</div>';

  return `<div class="pre-wrap">
    <div class="period-bar" style="padding-bottom:0"><button class="btn" id="inf-prev">‹</button><span class="period-chip">${MES_LARGO[infM]} ${infY}</span><button class="btn" id="inf-next">›</button></div>
    <div class="pre-net">${fmt(tot.net)}</div>
    <div class="pre-bars">${bars}</div>
    <div class="bud-summary">
      <div class="bs"><div class="l">Presupuestado</div><div class="v">${fmt(totalBudget)}</div></div>
      <div class="bs"><div class="l">Gastado</div><div class="v" style="color:var(--red)">${fmt(tot.gas)}</div></div>
      <div class="bs"><div class="l">Restante</div><div class="v" style="color:${restante<0?'var(--red)':'var(--green)'}">${fmt(restante)}</div></div>
    </div>
    <div class="pre-body">
      <div class="pre-row-head"><span>Toca una categoría para fijar su presupuesto</span><span class="vals" style="color:var(--red)">${fmt(tot.gas)} / ${fmt(totalBudget)}</span></div>
      <div class="cat-grid">${catHtml}</div>
    </div></div>`;
}

/* ----------------------------- Vista: Metas ----------------------------- */
function renderMetas(){
  const gs=goals();
  if(!gs.length){
    return `<div class="big-empty"><div class="be-ico">🎯</div><div class="be-title">Aún no tienes metas de ahorro</div>
      <div class="be-sub">Define objetivos (fondo de emergencia, vacaciones, un auto) y mira tu progreso.</div>
      <button class="be-btn" id="new-goal">+ Crear mi primera meta</button></div>`;
  }
  const cards = gs.map(g=>{
    const pct = g.target>0?Math.min(100, g.saved/g.target*100):0;
    const falta = Math.max(0, g.target-g.saved);
    let foot = `Faltan ${fmt(falta)}`;
    if(g.targetDate){
      const d=parseISO(g.targetDate); const mq=Math.max(1, (d.getFullYear()-today.getFullYear())*12 + (d.getMonth()-today.getMonth()));
      foot = falta<=0 ? '🎉 ¡Meta alcanzada!' : `Faltan ${fmt(falta)} · ${fmt(falta/mq)}/mes hasta ${shortDate(g.targetDate)} ${parseISO(g.targetDate).getFullYear()}`;
    } else if(falta<=0){ foot='🎉 ¡Meta alcanzada!'; }
    return `<div class="goal-card"><div class="gc-head"><div class="gc-ico">${g.icon||'🎯'}</div>
      <div><div class="gc-name">${esc(g.name)}</div><div class="gc-sub">${Math.round(pct)}% completado</div></div>
      <div class="gc-amt"><div class="saved">${fmt(g.saved)}</div><div class="target">de ${fmt(g.target)}</div></div></div>
      <div class="track"><i style="width:${pct}%"></i></div>
      <div class="gc-foot"><span>${foot}</span><span class="gc-actions">
        <button data-edit-goal="${g.id}">Editar</button><button class="contrib" data-contrib="${g.id}">+ Aportar</button></span></div></div>`;
  }).join('');
  return `<div class="metas-wrap"><button class="add-pill" id="new-goal">+ Nueva meta</button>${cards}</div>`;
}

/* ----------------------------- Vista: Deudas ----------------------------- */
function payoffMonths(balance, apr, payment){
  if(!payment || payment<=0) return null;
  const r = (apr||0)/100/12;
  if(r<=0) return Math.ceil(balance/payment);
  if(payment <= balance*r) return Infinity;
  return Math.ceil(-Math.log(1 - (r*balance)/payment) / Math.log(1+r));
}
function renderDeudas(){
  const ds = debts();
  if(!ds.length){
    return `<div class="big-empty"><div class="be-ico">💳</div><div class="be-title">Sin deudas registradas</div>
      <div class="be-sub">Agrega tus tarjetas o préstamos para seguir cuánto debes y cuándo terminarás de pagar.</div>
      <button class="be-btn" id="new-debt">+ Agregar una deuda</button></div>`;
  }
  const total = totalDebt();
  const cards = ds.map(d=>{
    const orig = d.original && d.original>0 ? d.original : d.balance;
    const paid = Math.max(0, orig - d.balance);
    const pct = orig>0 ? Math.min(100, paid/orig*100) : 0;
    const months = payoffMonths(d.balance, d.apr, d.pay);
    let plan = 'Define un pago mensual para estimar el plazo';
    if(d.pay>0){
      if(months===Infinity) plan = '⚠️ El pago no cubre los intereses; la deuda no baja';
      else { const y=Math.floor(months/12), m=months%12;
        plan = `Pagando ${fmt(d.pay)}/mes → libre en ${y?y+' año'+(y>1?'s ':' '):''}${m?m+' mes'+(m>1?'es':''):''}`.trim(); }
    }
    const chips = [];
    if(d.apr>0) chips.push(`Interés <b>${d.apr}%</b> anual`);
    if(d.pay>0) chips.push(`Pago <b>${fmt(d.pay)}</b>/mes`);
    if(orig>0) chips.push(`Pagado <b>${fmt(paid)}</b> de ${fmt(orig)}`);
    return `<div class="debt-card"><div class="dc-head"><div class="dc-ico">${d.icon||'💳'}</div>
      <div><div class="dc-name">${esc(d.name)}</div><div class="dc-sub">${Math.round(pct)}% pagado</div></div>
      <div class="dc-amt"><div class="owed">${fmt(d.balance)}</div><div class="of">${orig>0?'de '+fmt(orig):'pendiente'}</div></div></div>
      <div class="track"><i style="width:${pct}%"></i></div>
      <div class="debt-chips">${chips.map(c=>`<span>${c}</span>`).join('')}</div>
      <div class="dc-foot"><span>${plan}</span><span class="dc-actions">
        <button data-edit-debt="${d.id}">Editar</button><button class="pay" data-pay-debt="${d.id}">Registrar pago</button></span></div></div>`;
  }).join('');
  return `<div class="debts-wrap">
    <div class="debt-total"><div class="l">Deuda total</div><div class="v">${fmt(total)}</div>
      <div class="s">${ds.length} deuda${ds.length>1?'s':''} · resta del patrimonio neto</div></div>
    <button class="add-pill" id="new-debt">+ Nueva deuda</button>${cards}</div>`;
}

/* ----------------------------- Vista: Informes ----------------------------- */
function netWorthSeries(){
  const cur = totalNetWorth(); const series = [];
  for(let m=0;m<12;m++){
    let after=0;
    transactions().forEach(t=>{
      const d=parseISO(t.date);
      if(d.getFullYear()>infY || (d.getFullYear()===infY && d.getMonth()>m)){
        if(t.kind==='ingreso') after+=t.amount; else if(t.kind==='gasto') after-=t.amount;
      }
    });
    series.push(cur - after);
  }
  return series;
}
function renderInformes(){
  const tot = monthTotals(infY, infM);
  const max = Math.max(tot.ing, tot.gas, 1);
  let body;
  if(infType==='ig'){
    body = `<div class="inf-bar-row"><div class="inf-bar green" style="width:${Math.max(14,tot.ing/max*100)}%"><span class="lbl">Ingresos</span><span class="amt">${fmt(tot.ing)}</span></div></div>
      <div class="inf-bar-row"><div class="inf-bar red" style="width:${Math.max(14,tot.gas/max*100)}%"><span class="lbl">Gastos</span><span class="amt">${fmt(tot.gas)}</span></div></div>
      <div class="inf-net"><span>Balance del periodo</span><b style="color:${tot.net<0?'var(--red)':'var(--green)'}">${fmt(tot.net)}</b></div>
      <div class="inf-hint">Tasa de ahorro: <b>${tot.ing>0?Math.round(tot.net/tot.ing*100):0}%</b>. ${tot.net>=0?'Buen trabajo: gastaste menos de lo que ingresó.':'Atención: gastaste más de lo que ingresó este mes.'}</div>`;
  } else if(infType==='cat'){
    const cs={}; transactions().forEach(t=>{ if(t.kind==='gasto'&&inMonth(t.date,infY,infM)) cs[t.category]=(cs[t.category]||0)+t.amount; });
    const cats=Object.keys(cs).sort((a,b)=>cs[b]-cs[a]); const cmax=Math.max(...Object.values(cs),1);
    const totg=Object.values(cs).reduce((s,v)=>s+v,0);
    body = cats.length? cats.map(c=>`<div class="cat-report-row"><span class="c-name">${catIco(c)} ${esc(c)}</span>
      <div class="bar-bg"><div class="bar-fill" style="width:${cs[c]/cmax*100}%"></div></div>
      <span class="c-amt">${fmt(cs[c])} · ${Math.round(cs[c]/totg*100)}%</span></div>`).join('') : '<div class="empty">Sin gastos este mes</div>';
  } else {
    const series=netWorthSeries(); const mx=Math.max(...series.map(Math.abs),1);
    body = `<div class="nw-bars">${series.map((v,m)=>`<div class="nw-col">
      <div class="nw-val">${v>=1000||v<=-1000?(Math.round(v/1000)+'k'):Math.round(v)}</div>
      <div class="nw-bar" style="height:${Math.max(2,Math.abs(v)/mx*100)}%;${v<0?'background:linear-gradient(180deg,#ff6b6b,#ff453a)':''}"></div>
      <div class="nw-lbl">${MES_CORTO[m][0].toUpperCase()}</div></div>`).join('')}</div>
      <div class="inf-hint">Patrimonio neto estimado al cierre de cada mes de ${infY}, reconstruido a partir de tus ingresos y gastos.</div>`;
  }
  const pdfBtn = IS_ELECTRON ? `<button class="btn primary" id="exp-pdf">⤓ PDF del mes</button>` : `<button class="btn primary" id="exp-print">⤓ Reporte del mes</button>`;
  return `<div class="inf-wrap"><div class="inf-head">
      <select class="inf-select" id="inf-type">
        <option value="ig" ${infType==='ig'?'selected':''}>Ingresos / gastos</option>
        <option value="cat" ${infType==='cat'?'selected':''}>Gastos por categoría</option>
        <option value="nw" ${infType==='nw'?'selected':''}>Patrimonio neto</option>
      </select>
      <button class="btn" id="inf-prev">‹</button><span class="period-chip">${MES_LARGO[infM]} ${infY}</span><button class="btn" id="inf-next">›</button>
      <span class="inf-actions"><button class="btn" id="exp-csv">⤓ CSV</button>${pdfBtn}</span>
    </div>${body}</div>`;
}

/* ----------------------------- Vista: Más (teléfono) ----------------------------- */
function renderMas(){
  const si = Sync.info();
  const syncSub = !si.serverReady ? 'Nube sin configurar' : (si.configured ? (si.lastError ? 'Error: '+si.lastError : 'Vinculado · última vez '+Sync.fmtHace(si.lastOk)) : 'Sin vincular — toca para conectar');
  const row=(ico,txt,sub,act)=>`<div class="mas-row" data-act="${act}"><div class="m-ico">${ico}</div><div class="m-txt">${txt}${sub?`<div class="m-sub">${esc(sub)}</div>`:''}</div><span class="m-chev">›</span></div>`;
  return `<div class="mas-wrap">
    <div class="mas-card">
      ${row('📅','Calendario (Hoy)','Movimientos por día y planificados','view:hoy')}
      ${row('🎯','Metas de ahorro',`${goals().length} metas`,'view:metas')}
      ${row('💳','Deudas',debts().length?fmt(totalDebt())+' en total':'Sin deudas','view:deudas')}
      ${row('📊','Informes','Ingresos, gastos, categorías y patrimonio','view:informes')}
    </div>
    <div class="mas-card">
      ${row('☁️','Nube y sincronización',syncSub,'sync')}
      ${row('🎨','Tema de la app', temaActual()==='madrid'?'Real Madrid':'Clásico','tema')}
      ${row('⚙️','Datos y respaldo','Respaldar, restaurar o borrar','settings')}
    </div>
    <p class="settings-note" style="text-align:center">Mi Dinero Pro · v${(window.MD_CONFIG&&window.MD_CONFIG.VERSION)||'2'}</p>
  </div>`;
}

/* ----------------------------- Wiring ----------------------------- */
function wireView(){
  document.querySelectorAll('.acc-row').forEach(r=>{
    r.addEventListener('click',(e)=>{ if(e.target.dataset.editAcc){ openAccModal(e.target.dataset.editAcc); return; } setSelected(r.dataset.acc); render(); });
    r.addEventListener('dblclick',()=> openAccModal(r.dataset.acc));
  });
  const addAcc=document.getElementById('add-acc'); if(addAcc) addAcc.addEventListener('click',()=>openAccModal(null));
  document.querySelectorAll('.seg-btn[data-modo]').forEach(b=> b.addEventListener('click',()=>{ saldoModo=b.dataset.modo; render(); }));
  document.querySelectorAll('.ct-in').forEach(i=> i.addEventListener('input',()=>conteoInput(i)));
  const cc=document.getElementById('ct-clear'); if(cc) cc.addEventListener('click', conteoClear);
  const ca=document.getElementById('ct-apply'); if(ca) ca.addEventListener('click', conteoApply);
  document.querySelectorAll('[data-tx]').forEach(r=> r.addEventListener('click',()=> openTxModal(r.dataset.tx)));
  document.querySelectorAll('[data-go]').forEach(r=> r.addEventListener('click',()=>{ navTo(r.dataset.go); }));
  document.querySelectorAll('[data-goal]').forEach(r=> r.addEventListener('click',()=> navTo('metas')));
  document.querySelectorAll('[data-pay]').forEach(b=> b.addEventListener('click',(e)=>{ e.stopPropagation(); payRecurring(b.dataset.pay); }));
  document.querySelectorAll('.mas-row[data-act]').forEach(r=> r.addEventListener('click',()=>{
    const a=r.dataset.act;
    if(a.startsWith('view:')) navTo(a.slice(5)); else if(a==='sync') openSync(); else if(a==='settings') openSettings(); else if(a==='tema') openTema();
  }));

  const s=document.getElementById('tx-search');
  if(s) s.addEventListener('input',()=>{ searchQ=s.value; const sel=s.selectionStart; render(); const n=document.getElementById('tx-search'); if(n){n.focus(); try{n.setSelectionRange(sel,sel);}catch(e){}} });

  const cp=document.getElementById('cal-prev'), cn=document.getElementById('cal-next'), ct=document.getElementById('cal-today');
  if(cp) cp.addEventListener('click',()=>{ calM--; if(calM<0){calM=11;calY--;} render(); });
  if(cn) cn.addEventListener('click',()=>{ calM++; if(calM>11){calM=0;calY++;} render(); });
  if(ct) ct.addEventListener('click',()=>{ calY=today.getFullYear(); calM=today.getMonth(); selDay=isoOf(today); render(); });
  document.querySelectorAll('.cal-cell[data-day]').forEach(c=> c.addEventListener('click',()=>{ selDay=c.dataset.day; render(); }));

  document.querySelectorAll('.pre-bar-col[data-bm]').forEach(c=> c.addEventListener('click',()=>{ infM=Number(c.dataset.bm); render(); }));
  document.querySelectorAll('.cat-item[data-cat]').forEach(c=> c.addEventListener('click',()=> openBudgetModal(c.dataset.cat)));

  const it=document.getElementById('inf-type'); if(it) it.addEventListener('change',()=>{ infType=it.value; render(); });
  const ip=document.getElementById('inf-prev'), inx=document.getElementById('inf-next');
  if(ip) ip.addEventListener('click',()=>{ infM--; if(infM<0){infM=11;infY--;} render(); });
  if(inx) inx.addEventListener('click',()=>{ infM++; if(infM>11){infM=0;infY++;} render(); });
  const ep=document.getElementById('exp-pdf'); if(ep) ep.addEventListener('click', exportPdfMonth);
  const epr=document.getElementById('exp-print'); if(epr) epr.addEventListener('click', exportPrintMonth);
  const ec=document.getElementById('exp-csv'); if(ec) ec.addEventListener('click', exportCsvMonth);

  const ng=document.getElementById('new-goal'); if(ng) ng.addEventListener('click',()=>openGoalModal(null));
  document.querySelectorAll('[data-edit-goal]').forEach(b=> b.addEventListener('click',()=>openGoalModal(b.dataset.editGoal)));
  document.querySelectorAll('[data-contrib]').forEach(b=> b.addEventListener('click',()=>openContrib(b.dataset.contrib)));
  const nd=document.getElementById('new-debt'); if(nd) nd.addEventListener('click',()=>openDebtModal(null));
  document.querySelectorAll('[data-edit-debt]').forEach(b=> b.addEventListener('click',()=>openDebtModal(b.dataset.editDebt)));
  document.querySelectorAll('[data-pay-debt]').forEach(b=> b.addEventListener('click',()=>openDebtPayment(b.dataset.payDebt)));
}

/* ----------------------------- Recurrentes ----------------------------- */
function payRecurring(id){
  const r = state.recurring.find(x=>x.id===id && !x.deleted); if(!r) return;
  const tx = { date:r.nextDate, kind:r.kind, desc:r.desc, amount:r.amount, category:r.category, account:r.account };
  if(r.accountTo) tx.accountTo=r.accountTo;
  addRec('transactions', tx);
  r.nextDate = addMonth(r.nextDate); touch('recurring', r);
  render(); toast('Pago registrado');
}

/* ----------------------------- Modal: movimiento ----------------------------- */
function fillSelectors(){
  document.getElementById('f-category').innerHTML = categories().map(c=>`<option value="${esc(c.name)}">${catIco(c.name)} ${esc(c.name)}</option>`).join('') + '<option value="__nueva">➕ Nueva categoría…</option>';
  const accs = accounts().map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('');
  document.getElementById('f-account').innerHTML = accs;
  document.getElementById('f-account-to').innerHTML = accs;
}
function syncModalKind(){
  document.querySelectorAll('.mtab').forEach(t=>t.classList.toggle('active', t.dataset.kind===editKind));
  document.getElementById('lbl-category').classList.toggle('hidden', editKind==='traspaso');
  document.getElementById('lbl-account-to').classList.toggle('hidden', editKind!=='traspaso');
  document.querySelector('#lbl-account').firstChild.textContent = editKind==='traspaso' ? 'Cuenta origen' : 'Cuenta';
}
function openTxModal(id){
  fillSelectors(); editTxId=id;
  const del=document.getElementById('btn-delete'); const rec=document.getElementById('f-recurring');
  if(id){
    const t=state.transactions.find(x=>x.id===id); if(!t) return;
    editKind=t.kind;
    document.getElementById('modal-title').textContent='Editar movimiento';
    document.getElementById('f-desc').value=t.desc;
    document.getElementById('f-amount').value=t.amount;
    document.getElementById('f-category').value=t.category||(categories()[0]||{}).name;
    document.getElementById('f-account').value=t.account;
    if(t.accountTo) document.getElementById('f-account-to').value=t.accountTo;
    document.getElementById('f-date').value=t.date;
    rec.checked=false; rec.parentElement.style.display='none';
    del.classList.remove('hidden');
  } else {
    editKind='gasto';
    document.getElementById('modal-title').textContent='Nuevo movimiento';
    document.getElementById('f-desc').value='';
    document.getElementById('f-amount').value='';
    document.getElementById('f-account').value=state.selectedAccount || (accounts()[0]||{}).id;
    document.getElementById('f-date').value=(view==='hoy'?selDay:isoOf(today));
    rec.checked=false; rec.parentElement.style.display='flex';
    del.classList.add('hidden');
  }
  syncModalKind();
  show('modal-overlay');
  document.getElementById(id?'f-desc':'f-amount').focus();
}
function saveTx(){
  const amount=Math.abs(parseFloat(document.getElementById('f-amount').value));
  if(!amount||isNaN(amount)){ document.getElementById('f-amount').focus(); return; }
  const desc=document.getElementById('f-desc').value.trim()||(editKind==='traspaso'?'Traspaso':'Sin nombre');
  const account=document.getElementById('f-account').value;
  const date=document.getElementById('f-date').value||isoOf(today);
  const data={ kind:editKind, desc, amount, account, date };
  if(editKind==='traspaso') data.accountTo=document.getElementById('f-account-to').value;
  else data.category=document.getElementById('f-category').value;
  if(date>isoOf(today)) data.planned=true;
  if(editTxId){
    const t=state.transactions.find(x=>x.id===editTxId);
    delete t.accountTo; delete t.planned; delete t.category;
    Object.assign(t,data); touch('transactions', t);
  } else {
    addRec('transactions', data);
    if(document.getElementById('f-recurring').checked && editKind!=='traspaso'){
      addRec('recurring', { desc, amount, kind:editKind, category:data.category, account, nextDate:addMonth(date), active:true });
    }
  }
  hide('modal-overlay'); render();
}
function deleteTx(){ if(editTxId) removeRec('transactions', editTxId); hide('modal-overlay'); render(); }

/* ----------------------------- Modal: cuenta ----------------------------- */
function openAccModal(id){
  editAccId=id; const del=document.getElementById('a-delete');
  if(id){ const a=acc(id); if(!a) return;
    document.getElementById('acc-title').textContent='Editar cuenta';
    document.getElementById('a-name').value=a.name; document.getElementById('a-type').value=a.type;
    document.getElementById('a-balance').value=Math.round(balanceOf(a)*100)/100; del.classList.remove('hidden');
  } else {
    document.getElementById('acc-title').textContent='Nueva cuenta';
    document.getElementById('a-name').value=''; document.getElementById('a-type').value='corriente';
    document.getElementById('a-balance').value=''; del.classList.add('hidden');
  }
  show('acc-overlay'); document.getElementById('a-name').focus();
}
function saveAcc(){
  const name=document.getElementById('a-name').value.trim()||'Cuenta';
  const type=document.getElementById('a-type').value;
  const balance=parseFloat(document.getElementById('a-balance').value)||0;
  if(editAccId){
    const a=acc(editAccId); const cur=balanceOf(a);
    a.name=name; a.type=type;
    // Si cambió el saldo mostrado, ajusta el saldo inicial para que cuadre.
    if(Math.abs(cur-balance)>0.004) a.saldoInicial = Math.round(((Number(a.saldoInicial)||0) + (balance-cur))*100)/100;
    touch('accounts', a);
  } else {
    const r=addRec('accounts', {name,type,saldoInicial:balance}); setSelected(r.id);
  }
  hide('acc-overlay'); render();
}
function deleteAcc(){
  if(accounts().length<=1){ hide('acc-overlay'); return; }
  const n = transactions().filter(t=>affects(t,editAccId)).length;
  if(n && !confirm(`Esta cuenta tiene ${n} movimientos. Se eliminarán también. ¿Continuar?`)) return;
  transactions().filter(t=>affects(t,editAccId)).forEach(t=>removeRec('transactions', t.id));
  removeRec('accounts', editAccId);
  if(state.selectedAccount===editAccId) setSelected(accounts()[0].id);
  hide('acc-overlay'); render();
}

/* ----------------------------- Modal: meta ----------------------------- */
function openGoalModal(id){
  editGoalId=id; const del=document.getElementById('g-delete');
  document.getElementById('g-icon').innerHTML = GOAL_ICONS.map(i=>`<option value="${i}">${i}</option>`).join('');
  if(id){ const g=state.goals.find(x=>x.id===id); if(!g) return;
    document.getElementById('goal-title').textContent='Editar meta';
    document.getElementById('g-name').value=g.name; document.getElementById('g-icon').value=g.icon||'🎯';
    document.getElementById('g-target').value=g.target; document.getElementById('g-saved').value=g.saved;
    document.getElementById('g-date').value=g.targetDate||''; del.classList.remove('hidden');
  } else {
    document.getElementById('goal-title').textContent='Nueva meta';
    document.getElementById('g-name').value=''; document.getElementById('g-icon').value='🎯';
    document.getElementById('g-target').value=''; document.getElementById('g-saved').value='0';
    document.getElementById('g-date').value=''; del.classList.add('hidden');
  }
  show('goal-overlay'); document.getElementById('g-name').focus();
}
function saveGoal(){
  const name=document.getElementById('g-name').value.trim()||'Meta';
  const icon=document.getElementById('g-icon').value;
  const target=Math.abs(parseFloat(document.getElementById('g-target').value))||0;
  const saved=Math.abs(parseFloat(document.getElementById('g-saved').value))||0;
  const targetDate=document.getElementById('g-date').value||null;
  if(editGoalId){ const g=state.goals.find(x=>x.id===editGoalId); Object.assign(g,{name,icon,target,saved,targetDate}); touch('goals', g); }
  else addRec('goals', {name, icon, target, saved, targetDate});
  hide('goal-overlay'); render();
}
function deleteGoal(){ removeRec('goals', editGoalId); hide('goal-overlay'); render(); }
function openContrib(id){ contribGoalId=id; document.getElementById('c-amount').value=''; show('contrib-overlay'); document.getElementById('c-amount').focus(); }
function saveContrib(){
  const amt=Math.abs(parseFloat(document.getElementById('c-amount').value));
  if(amt&&!isNaN(amt)){ const g=state.goals.find(x=>x.id===contribGoalId); if(g){ g.saved=(Number(g.saved)||0)+amt; touch('goals', g); } }
  hide('contrib-overlay'); render();
}

/* ----------------------------- Modal: presupuesto ----------------------------- */
function openBudgetModal(name){
  budgetCatName=name; document.getElementById('b-cat').value=name;
  const c=catObj(name); document.getElementById('b-amount').value=c?c.budget:0;
  show('budget-overlay'); document.getElementById('b-amount').focus();
}
function saveBudget(){
  const v=Math.abs(parseFloat(document.getElementById('b-amount').value))||0;
  let c=catObj(budgetCatName);
  if(!c){ c=addRec('categories', {id:budgetCatName, name:budgetCatName, budget:v}); }
  else { c.budget=v; touch('categories', c); }
  hide('budget-overlay'); render();
}

/* ----------------------------- Modal: deuda ----------------------------- */
function openDebtModal(id){
  editDebtId=id; const del=document.getElementById('d-delete');
  document.getElementById('d-icon').innerHTML = DEBT_ICONS.map(i=>`<option value="${i}">${i}</option>`).join('');
  if(id){ const d=state.debts.find(x=>x.id===id); if(!d) return;
    document.getElementById('debt-title').textContent='Editar deuda';
    document.getElementById('d-name').value=d.name; document.getElementById('d-icon').value=d.icon||'💳';
    document.getElementById('d-balance').value=d.balance; document.getElementById('d-original').value=d.original||'';
    document.getElementById('d-apr').value=d.apr||''; document.getElementById('d-pay').value=d.pay||'';
    del.classList.remove('hidden');
  } else {
    document.getElementById('debt-title').textContent='Nueva deuda';
    ['d-name','d-balance','d-original','d-apr','d-pay'].forEach(i=>document.getElementById(i).value='');
    document.getElementById('d-icon').value='💳'; del.classList.add('hidden');
  }
  show('debt-overlay'); document.getElementById('d-name').focus();
}
function saveDebt(){
  const name=document.getElementById('d-name').value.trim()||'Deuda';
  const icon=document.getElementById('d-icon').value;
  const balance=Math.abs(parseFloat(document.getElementById('d-balance').value))||0;
  const original=Math.abs(parseFloat(document.getElementById('d-original').value))||0;
  const apr=Math.abs(parseFloat(document.getElementById('d-apr').value))||0;
  const pay=Math.abs(parseFloat(document.getElementById('d-pay').value))||0;
  if(editDebtId){ const d=state.debts.find(x=>x.id===editDebtId); Object.assign(d,{name,icon,balance,original,apr,pay}); touch('debts', d); }
  else addRec('debts', {name, icon, balance, original:original||balance, apr, pay});
  hide('debt-overlay'); render();
}
function deleteDebt(){ removeRec('debts', editDebtId); hide('debt-overlay'); render(); }
function openDebtPayment(id){
  payDebtId=id; const d=state.debts.find(x=>x.id===id);
  document.getElementById('dpay-title').textContent='Pago a '+ (d?d.name:'deuda');
  document.getElementById('dp-amount').value = d&&d.pay>0?d.pay:'';
  document.getElementById('dp-fromacc').checked=true;
  document.getElementById('dp-acc-label').style.display='flex';
  document.getElementById('dp-account').innerHTML = accounts().map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('');
  document.getElementById('dp-account').value = state.selectedAccount || (accounts()[0]||{}).id;
  show('dpay-overlay'); document.getElementById('dp-amount').focus();
}
function saveDebtPayment(){
  const amt=Math.abs(parseFloat(document.getElementById('dp-amount').value));
  if(!amt||isNaN(amt)){ document.getElementById('dp-amount').focus(); return; }
  const d=state.debts.find(x=>x.id===payDebtId); if(!d){ hide('dpay-overlay'); return; }
  d.balance = Math.max(0, d.balance - amt); touch('debts', d);
  if(document.getElementById('dp-fromacc').checked){
    const account=document.getElementById('dp-account').value;
    addRec('transactions', { date:isoOf(today), kind:'gasto', desc:'Pago '+d.name, amount:amt, category:'Otros', account });
  }
  hide('dpay-overlay'); render();
}

/* ----------------------------- Datos / respaldo ----------------------------- */
function openSettings(){
  document.getElementById('settings-version').textContent = 'Versión ' + ((window.MD_CONFIG&&window.MD_CONFIG.VERSION)||'2') + (IS_ELECTRON?' · Mac':' · Web');
  show('settings-overlay');
}
function backupJson(){ return JSON.stringify(state, null, 2); }
async function doBackup(){
  const stamp = isoOf(today).replace(/-/g,'');
  const name=`MiDineroPro-respaldo-${stamp}.json`;
  if(IS_ELECTRON){
    const res = await window.api.backupSave({ json: backupJson(), suggestedName:name });
    if(res && res.ok) toast('Respaldo guardado.'); else if(res && res.error) alert('No se pudo respaldar: '+res.error);
    return;
  }
  const blob=new Blob([backupJson()],{type:'application/json'});
  const file = new File([blob], name, {type:'application/json'});
  if(navigator.canShare && navigator.canShare({files:[file]})){ try{ await navigator.share({files:[file], title:'Respaldo Mi Dinero Pro'}); return; }catch(e){} }
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click();
}
async function doRestore(){
  if(IS_ELECTRON){
    const res = await window.api.backupOpen();
    if(!res || !res.ok){ if(res&&res.error) alert('No se pudo leer el archivo: '+res.error); return; }
    applyRestore(res.data); return;
  }
  document.getElementById('st-file').value=''; document.getElementById('st-file').click();
}
function onRestoreFile(e){
  const f=e.target.files && e.target.files[0]; if(!f) return;
  const rd=new FileReader(); rd.onload=()=>{ try{ applyRestore(JSON.parse(rd.result)); }catch(err){ alert('Ese archivo no es un respaldo válido.'); } }; rd.readAsText(f);
}
function applyRestore(d){
  if(!d || !Array.isArray(d.accounts) || !Array.isArray(d.transactions)){ alert('Ese archivo no parece un respaldo válido de Mi Dinero Pro.'); return; }
  if(!confirm('Esto reemplazará los datos de este dispositivo con los del respaldo' + (Sync.configured()?' y los subirá a la nube':'') + '. ¿Continuar?')) return;
  state = Store.normalize(JSON.parse(JSON.stringify(d)));
  // Todo el respaldo cuenta como modificado ahora, para que gane en la nube.
  const t=Store.now(); Store.COLS.forEach(c=>state[c].forEach(r=>{ r.updatedAt=t; }));
  window.App.state = state; Store.markAllDirty(state); persist(); Sync.schedule();
  hide('settings-overlay'); navTo('resumen'); toast('Datos restaurados.');
}
function doWipe(){
  if(!confirm('¿Borrar TODOS los datos de este dispositivo y empezar de cero?' + (Sync.configured()?' También se desvinculará de la nube (los datos en la nube no se borran).':''))) return;
  Sync.desvincular();
  state = Store.defaultState(); window.App.state = state; Store.clearAllDirty(); persist();
  hide('settings-overlay'); navTo('resumen');
}

/* ----------------------------- Exportar ----------------------------- */
function monthTx(y,m){ return transactions().filter(t=>inMonth(t.date,y,m)).sort(byDateAsc); }
async function exportCsvMonth(){
  const rows=[['Fecha','Tipo','Descripción','Categoría','Cuenta','Monto']];
  monthTx(infY,infM).forEach(t=>rows.push([t.date,t.kind,t.desc,t.category||'',acc(t.account)?.name||'', (t.kind==='ingreso'?'':'-')+t.amount]));
  const csv='﻿'+rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const name=`MiDinero_${MES_CORTO[infM]}${infY}.csv`;
  const blob=new Blob([csv],{type:'text/csv'});
  const file=new File([blob], name, {type:'text/csv'});
  if(!IS_ELECTRON && navigator.canShare && navigator.canShare({files:[file]})){ try{ await navigator.share({files:[file], title:name}); return; }catch(e){} }
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click();
}
function reportHtml(){
  const tot=monthTotals(infY,infM);
  const txs=monthTx(infY,infM);
  const cs={}; txs.forEach(t=>{ if(t.kind==='gasto') cs[t.category]=(cs[t.category]||0)+t.amount; });
  const cats=Object.keys(cs).sort((a,b)=>cs[b]-cs[a]);
  const accRows=accounts().map(a=>`<tr><td>${esc(a.name)}</td><td style="text-align:right">${fmt(balanceOf(a))}</td></tr>`).join('');
  const catRows=cats.map(c=>`<tr><td>${esc(c)}</td><td style="text-align:right">${fmt(cs[c])}</td><td style="text-align:right">${Math.round(cs[c]/(tot.gas||1)*100)}%</td></tr>`).join('')||'<tr><td colspan="3" style="color:#888">Sin gastos</td></tr>';
  const txRows=txs.map(t=>`<tr><td>${shortDate(t.date)}</td><td>${esc(t.desc)}</td><td>${esc(t.category||(t.kind==='traspaso'?'Traspaso':''))}</td><td>${esc(acc(t.account)?.name||'')}</td><td style="text-align:right;color:${t.kind==='ingreso'?'#179e4e':(t.kind==='gasto'?'#d12d22':'#333')}">${t.kind==='ingreso'?'+':(t.kind==='gasto'?'-':'')}${fmt(t.amount)}</td></tr>`).join('')||'<tr><td colspan="5" style="color:#888">Sin movimientos este mes</td></tr>';
  const goalsRows=goals().map(g=>{const p=g.target>0?Math.round(g.saved/g.target*100):0;return `<tr><td>${g.icon||''} ${esc(g.name)}</td><td style="text-align:right">${fmt(g.saved)} / ${fmt(g.target)}</td><td style="text-align:right">${p}%</td></tr>`;}).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Reporte ${MES_LARGO[infM]} ${infY}</title><style>
    body{font-family:-apple-system,Helvetica,Arial,sans-serif;color:#1a1a1a;margin:0;padding:28px 30px;font-size:12px;background:#fff}
    h1{font-size:20px;margin:0 0 2px} .sub{color:#777;font-size:11px;margin-bottom:18px}
    .grid{display:flex;gap:10px;margin-bottom:20px} .box{flex:1;border:1px solid #e3e3e3;border-radius:10px;padding:12px 14px}
    .box .l{font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.4px} .box .v{font-size:18px;font-weight:700;margin-top:3px}
    h2{font-size:13px;margin:20px 0 8px;border-bottom:2px solid #1a1a1a;padding-bottom:5px}
    table{width:100%;border-collapse:collapse} td,th{padding:6px 8px;border-bottom:1px solid #eee;text-align:left}
    th{font-size:10px;text-transform:uppercase;color:#888} .foot{margin-top:26px;color:#aaa;font-size:10px;text-align:center}
    @media print{ .noprint{display:none} }</style></head><body>
    <h1>Reporte financiero — ${MES_LARGO[infM]} ${infY}</h1>
    <div class="sub">Mi Dinero Pro · Generado el ${today.getDate()} de ${MES_LARGO[today.getMonth()].toLowerCase()} de ${today.getFullYear()}</div>
    <div class="grid">
      <div class="box"><div class="l">Ingresos</div><div class="v" style="color:#179e4e">${fmt(tot.ing)}</div></div>
      <div class="box"><div class="l">Gastos</div><div class="v" style="color:#d12d22">${fmt(tot.gas)}</div></div>
      <div class="box"><div class="l">Balance</div><div class="v">${fmt(tot.net)}</div></div>
      <div class="box"><div class="l">Patrimonio neto</div><div class="v">${fmt(totalNetWorth())}</div></div>
    </div>
    <h2>Saldos de cuentas</h2><table><tbody>${accRows}</tbody></table>
    <h2>Gastos por categoría</h2><table><thead><tr><th>Categoría</th><th style="text-align:right">Monto</th><th style="text-align:right">%</th></tr></thead><tbody>${catRows}</tbody></table>
    ${goalsRows?`<h2>Metas de ahorro</h2><table><tbody>${goalsRows}</tbody></table>`:''}
    <h2>Movimientos del mes (${txs.length})</h2><table><thead><tr><th>Fecha</th><th>Descripción</th><th>Categoría</th><th>Cuenta</th><th style="text-align:right">Monto</th></tr></thead><tbody>${txRows}</tbody></table>
    <div class="foot">Generado por Mi Dinero Pro</div></body></html>`;
}
async function exportPdfMonth(){
  const ep=document.getElementById('exp-pdf'); if(ep){ep.textContent='Generando…'; ep.disabled=true;}
  const res=await window.api.exportPdf({ html: reportHtml(), suggestedName:`MiDinero_${MES_CORTO[infM]}${infY}.pdf` });
  if(ep){ep.textContent='⤓ PDF del mes'; ep.disabled=false;}
  if(res && res.error) alert('No se pudo exportar: '+res.error);
}
async function exportPrintMonth(){
  const html=reportHtml(); const name=`MiDinero_${MES_CORTO[infM]}${infY}.html`;
  const blob=new Blob([html],{type:'text/html'}); const file=new File([blob], name, {type:'text/html'});
  if(navigator.canShare && navigator.canShare({files:[file]})){ try{ await navigator.share({files:[file], title:'Reporte del mes'}); return; }catch(e){} }
  const w=window.open('', '_blank'); if(w){ w.document.write(html); w.document.close(); setTimeout(()=>{ try{w.print();}catch(e){} }, 400); }
  else { const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); }
}


/* ----------------------------- Tema ----------------------------- */
function temaActual(){ try{ return localStorage.getItem('midinero.tema')||'clasico'; }catch(e){ return 'clasico'; } }
function fondoActual(){ try{ return localStorage.getItem('midinero.fondo')||'1'; }catch(e){ return '1'; } }
function applyTema(){
  const t=temaActual(), f=fondoActual();
  document.documentElement.dataset.tema=t; document.documentElement.dataset.fondo=f;
  const m=document.querySelector('meta[name="theme-color"]'); if(m) m.content = (t==='madrid'?'#05050f':'#0a0a0c');
}
function refreshTemaModal(){
  const t=temaActual(), f=fondoActual();
  document.querySelectorAll('.tema-card').forEach(b=>b.classList.toggle('active', b.dataset.tema===t));
  document.getElementById('tema-fondos').classList.toggle('hidden', t!=='madrid');
  document.querySelectorAll('.fondo-btn').forEach(b=>b.classList.toggle('active', b.dataset.fondo===f));
}
function openTema(){ refreshTemaModal(); show('tema-overlay'); }
function bindTema(){
  document.getElementById('tema-close').addEventListener('click', ()=>hide('tema-overlay'));
  document.querySelectorAll('.tema-card').forEach(b=> b.addEventListener('click', ()=>{
    try{ localStorage.setItem('midinero.tema', b.dataset.tema); }catch(e){}
    applyTema(); refreshTemaModal(); render();
  }));
  document.querySelectorAll('.fondo-btn').forEach(b=> b.addEventListener('click', ()=>{
    try{ localStorage.setItem('midinero.fondo', b.dataset.fondo); }catch(e){}
    applyTema(); refreshTemaModal();
  }));
}

/* ----------------------------- Nube / sincronización ----------------------------- */
function bindSync(){
  Sync.onStatus((st, msg)=>{
    const pill=document.getElementById('sync-pill');
    pill.className='sync-pill '+st; pill.title=msg||''; pill.querySelector('.txt').textContent = st==='busy'?'Sincronizando':(st==='ok'?'Nube ✓':(st==='off'?'Nube':(st==='offline'?'Sin señal':'Error')));
    const ico=document.getElementById('sync-ico'); ico.className='nav-ico sync-ico '+st;
    if(!document.getElementById('sync-overlay').classList.contains('hidden')) renderSyncBody();
    if(view==='mas' && !modalOpen()) render();
  });
  if(!Sync.configured()){ const pill=document.getElementById('sync-pill'); pill.className='sync-pill off'; }
}
function openSync(){ renderSyncBody(); show('sync-overlay'); }
function renderSyncBody(){
  const si=Sync.info(); const body=document.getElementById('sync-body');
  const estado = si.running?['busy','Sincronizando…']:(si.lastError?['error','Último intento falló: '+si.lastError]:(si.lastOk?['ok','Sincronizado '+Sync.fmtHace(si.lastOk)]:['', 'Aún no se ha sincronizado']));
  const avanzado = `<details class="sy-adv" ${si.custom||!si.serverReady?'open':''}><summary>Servidor (avanzado)</summary>
      <label>URL del proyecto Supabase<input class="sy-input" id="sy-url" placeholder="https://xxxx.supabase.co" value="${esc(si.url)}" /></label>
      <label>Llave pública (anon key)<input class="sy-input" id="sy-key" placeholder="eyJ…" value="${esc(si.key)}" /></label>
      <div class="sy-row" style="margin-top:8px"><button class="btn" id="sy-saveserver">Guardar servidor</button></div></details>`;
  if(!si.serverReady){
    body.innerHTML = `<div class="sy-sec">
      <p class="sy-meta">La nube todavía no está configurada en esta versión de la app. Cuando el proyecto de Supabase esté listo, sus datos quedan dentro de la app y aquí solo tendrás que <b>vincular</b> tus dispositivos. Si ya tienes la URL y la llave, pégalas abajo.</p>${avanzado}</div>`;
  } else if(!si.configured){
    body.innerHTML = `<div class="sy-sec">
      <p class="sy-meta">Vincula tus dispositivos con una <b>clave de sincronización</b>. Guárdala bien: es lo único que protege tus datos y no se puede recuperar.</p>
      <div class="sy-row"><button class="btn primary" id="sy-crear">Crear espacio nuevo (primera vez)</button></div>
      <p class="sy-meta" style="margin-top:6px">¿Ya creaste el espacio en tu otro dispositivo? Escribe o escanea su clave:</p>
      <input class="sy-input clave" id="sy-clave" placeholder="XXXX-XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters" enterkeyhint="go" />
      <div class="sy-row"><button class="btn" id="sy-scan">📷 Escanear QR</button><button class="btn primary" id="sy-vincular">Vincular</button></div>
      <div class="sy-err" id="sy-err"></div>${avanzado}</div>`;
  } else {
    const claveFmt = Sync.normalizarClave(si.clave);
    body.innerHTML = `<div class="sy-sec">
      <div class="sy-status ${estado[0]}"><span class="dot"></span><span>${esc(estado[1])}${si.pending?` · ${si.pending} por subir`:''}</span></div>
      <p class="sy-meta">Esta es tu clave de sincronización. En el otro dispositivo: <b>Nube → Vincular</b>, y escanea este código o escribe la clave.</p>
      <div class="sy-clave" id="sy-clave-txt">${esc(claveFmt)}</div>
      <div class="sy-qr" id="sy-qr"></div>
      <div class="sy-row"><button class="btn" id="sy-copiar">Copiar clave</button><button class="btn primary" id="sy-ahora">Sincronizar ahora</button></div>
      <div class="sy-row"><button class="btn danger" id="sy-desv">Desvincular este dispositivo</button></div>
      <p class="sy-meta">Los datos se suben automáticamente cada vez que cambias algo y se bajan al abrir la app, al volver a ella y cada minuto. Sin señal, todo se guarda en el dispositivo y se sube después.</p>
      <details class="sy-adv"><summary>Servidor (avanzado)</summary><p>${esc(si.url)}</p></details></div>`;
    drawQr(Sync.enlaceVinculacion());
    document.getElementById('sy-copiar').addEventListener('click', async()=>{ try{ await navigator.clipboard.writeText(claveFmt); toast('Clave copiada'); }catch(e){ prompt('Copia tu clave:', claveFmt); } });
    document.getElementById('sy-ahora').addEventListener('click', ()=>Sync.run('manual'));
    document.getElementById('sy-desv').addEventListener('click', ()=>{ if(confirm('¿Desvincular este dispositivo de la nube? Tus datos locales se conservan.')){ Sync.desvincular(); renderSyncBody(); } });
  }
  const ss=document.getElementById('sy-saveserver');
  if(ss) ss.addEventListener('click', ()=>{ Sync.setServer(document.getElementById('sy-url').value, document.getElementById('sy-key').value); toast('Servidor guardado'); renderSyncBody(); });
  const cr=document.getElementById('sy-crear');
  if(cr) cr.addEventListener('click', async()=>{
    cr.disabled=true; cr.textContent='Creando…';
    try{ const clave=await Sync.crearEspacio(); toast('Espacio creado'); renderSyncBody(); Sync.run('crear'); }
    catch(e){ cr.disabled=false; cr.textContent='Crear espacio nuevo (primera vez)'; document.getElementById('sy-err').textContent='No se pudo crear: '+(e.message||e); }
  });
  const vb=document.getElementById('sy-vincular');
  if(vb) vb.addEventListener('click', ()=> vincularCon(document.getElementById('sy-clave').value));
  const sc=document.getElementById('sy-scan'); if(sc) sc.addEventListener('click', startScan);
  const ci=document.getElementById('sy-clave');
  if(ci){
    // Al completar los 16 caracteres se vincula solo (no hace falta tocar el botón).
    ci.addEventListener('input', ()=>{ ci.value=Sync.normalizarClave(ci.value).slice(0,19); if(Sync.claveLimpia(ci.value).length>=16) vincularCon(ci.value); });
    ci.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); ci.blur(); vincularCon(ci.value); } });
  }
}
let vinculando=false;
async function vincularCon(texto){
  if(vinculando || Sync.configured()) return;
  const err=document.getElementById('sy-err'); if(err) err.textContent='';
  const vb=document.getElementById('sy-vincular'); if(vb){ vb.disabled=true; vb.textContent='Vinculando…'; }
  vinculando=true;
  try{
    await Sync.vincular(texto);
    toast('Dispositivo vinculado'); renderSyncBody(); await Sync.run('vincular');
  }catch(e){ const m=(e.message||String(e)); if(err) err.textContent = m.includes('clave_invalida') ? 'Esa clave no existe. Revísala o crea un espacio nuevo.' : 'No se pudo vincular: '+m; else alert('No se pudo vincular: '+m); }
  finally{ vinculando=false; const b=document.getElementById('sy-vincular'); if(b){ b.disabled=false; b.textContent='Vincular'; } }
}
function drawQr(text){
  const box=document.getElementById('sy-qr'); if(!box) return;
  if(!text){ box.innerHTML=''; return; }
  try{
    const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
    box.innerHTML = qr.createImgTag(4, 0);
  }catch(e){ box.innerHTML='<span style="color:#333;font-size:12px">No se pudo generar el QR</span>'; }
}
// Si la app se abre con un enlace de vinculación (#vincular=…), vincula de inmediato.
function handleLinkHash(){
  const p=Sync.leerEnlace(location.hash);
  if(!p) return;
  history.replaceState(null,'',location.pathname+location.search);
  if(p.url && p.key) Sync.setServer(p.url, p.key);
  setTimeout(()=>{ vincularCon(p.clave).then(()=>{ if(!window.navigator.standalone && !IS_ELECTRON) toast('Vinculado. Para instalar la app: Compartir → Añadir a pantalla de inicio', 6000); }); }, 300);
}

/* ----------------------------- Escáner QR (cámara) ----------------------------- */
let scanStream=null, scanRaf=null;
async function startScan(){
  const msg=document.getElementById('scan-msg'); msg.textContent='';
  show('scan-overlay');
  try{
    scanStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ ideal:'environment' } }, audio:false });
  }catch(e){ msg.textContent='No se pudo abrir la cámara ('+(e.message||e)+'). Escribe la clave a mano.'; return; }
  const video=document.getElementById('scan-video'); video.srcObject=scanStream; await video.play().catch(()=>{});
  const canvas=document.getElementById('scan-canvas'); const ctx=canvas.getContext('2d', { willReadFrequently:true });
  const tick=()=>{
    if(!scanStream) return;
    if(video.readyState===video.HAVE_ENOUGH_DATA){
      canvas.width=video.videoWidth; canvas.height=video.videoHeight;
      ctx.drawImage(video,0,0,canvas.width,canvas.height);
      const img=ctx.getImageData(0,0,canvas.width,canvas.height);
      const code = window.jsQR ? jsQR(img.data, img.width, img.height, { inversionAttempts:'dontInvert' }) : null;
      if(code && code.data){
        const p=Sync.leerEnlace(code.data) || (Sync.claveLimpia(code.data).length>=12 ? {clave:Sync.claveLimpia(code.data)} : null);
        if(p){ stopScan(); hide('scan-overlay'); if(p.url&&p.key) Sync.setServer(p.url,p.key); vincularCon(p.clave); return; }
        msg.textContent='Ese código no es de Mi Dinero Pro.';
      }
    }
    scanRaf=requestAnimationFrame(tick);
  };
  scanRaf=requestAnimationFrame(tick);
}
function stopScan(){
  if(scanRaf) cancelAnimationFrame(scanRaf); scanRaf=null;
  if(scanStream){ scanStream.getTracks().forEach(t=>t.stop()); scanStream=null; }
  const v=document.getElementById('scan-video'); if(v) v.srcObject=null;
}

init();
