/* ===========================================================
   Planner pessoal · Pedro
   Tudo client-side, persistido em localStorage.
   Valores financeiros em CENTAVOS (inteiros) — nunca float.
   Trabalho = diário semanal: documento escrito + tabela de tarefas.
   Cérebro = documento-mestre de contexto, acessível de qualquer aba.
   =========================================================== */

const STORE_KEY = 'planner_v2';
const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const TASK_TYPES = [
  { key: 'aprendi',   label: 'Aprendi' },
  { key: 'aprimorei', label: 'Aprimorei' },
  { key: 'criei',     label: 'Criei' },
];
const BLOCK_TYPES = [
  { key: 'work',     label: 'Trabalho',  color: 'amber'  },
  { key: 'study',    label: 'Estudo',    color: 'blue'   },
  { key: 'health',   label: 'Saúde',     color: 'green'  },
  { key: 'personal', label: 'Pessoal',   color: 'accent' },
  { key: 'external', label: 'Externo',   color: 'cyan'   },
];
const FIN_CATS = ['Salário', 'Extra', 'Moradia', 'Alimentação', 'Transporte', 'Saúde', 'Estudos', 'Lazer', 'Assinaturas', 'Outros'];
const DEFAULT_PROTOCOLS = [
  { name: 'Protocolo 1 · Acordar às 06:00', desc: 'Todos os dias, sem exceção.', items: ['Acordei às 06:00'] },
  { name: 'Protocolo 2 · Vitamina D', desc: 'Tomar vitamina D todos os dias.', items: ['Tomei a vitamina D'] },
  { name: 'Protocolo 3 · Hidratação', desc: 'Garrafa ou copo de água sempre por perto.', items: ['Água ao acordar', 'Água antes de dormir'] },
  { name: 'Protocolo 4 · Disciplina', desc: 'Cumprir o primeiro protocolo.', items: ['Protocolo 1 cumprido'] },
];
const DOC_TEMPLATE = `# Semana

## Aprendi
-

## Aprimorei
-

## Criei
-

## Reflexão da semana
`;

/* ---------- moeda: centavos <-> texto ---------- */
const BRLfmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
function brl(cents) { return BRLfmt.format(cents / 100); }
function parseCents(str) {
  if (typeof str === 'number') return Math.round(str * 100);
  let s = String(str || '').trim().replace(/[R$\s]/g, '');
  if (!s) return NaN;
  const neg = /^-/.test(s); s = s.replace(/^-/, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const v = parseFloat(s);
  if (isNaN(v)) return NaN;
  return (neg ? -1 : 1) * Math.round(v * 100);
}

/* ---------- sync (declarado antes de save()) ---------- */
let ghSha = null;
let brainSha = null;
let syncTimer = null;
let pushing = false;

/* ---------- estado ---------- */
let db = load();
let finDate = new Date();
let weekRef = new Date();
migrate();
save();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return blank();
}
function blank() {
  return {
    weeks: {},   // chave = ISO do domingo da semana -> { doc, tasks: [] }
    brain: '',
    finance: { reserveCents: 400000, entries: [] }, // R$ 4.000,00 de reserva
    protocols: [],
    agenda: {},
    updatedAt: 0,
  };
}
function migrate() {
  if (!db.weeks) db.weeks = {};
  if (db.brain === undefined) db.brain = '';
  // v2 antigo: learn[] -> tasks da semana correspondente
  if (Array.isArray(db.learn)) {
    db.learn.forEach(e => {
      const wk = getWeek(new Date(e.date + 'T00:00'));
      wk.tasks.push({
        id: e.id || uid(), title: e.title, type: e.type, date: e.date,
        review: false, timeMin: null, link: '', tags: e.skills || [], notes: e.desc || '',
      });
    });
    delete db.learn;
  }
  if (!db.agenda) db.agenda = {};
  Object.values(db.weeks).forEach(w => { if (w.sessionNote === undefined) w.sessionNote = ''; });
  DEFAULT_PROTOCOLS.forEach(dp => {
    if (!db.protocols.some(p => p.name === dp.name)) {
      db.protocols.push({
        id: uid(), name: dp.name, desc: dp.desc, daily: true, lastReset: todayStr(),
        items: dp.items.map(t => ({ id: uid(), text: t, done: false })),
      });
    }
  });
  const today = todayStr();
  db.protocols.forEach(p => {
    if (p.daily && p.lastReset !== today) {
      p.items.forEach(i => i.done = false);
      p.lastReset = today;
    }
  });
}
function save() {
  db.updatedAt = Date.now();
  localStorage.setItem(STORE_KEY, JSON.stringify(db));
  scheduleCloudPush();
}

/* ===========================================================
   SYNC EM NUVEM — repo brain (privado) como fonte de verdade.
   planner/data.json guarda todo o estado; cerebro.md é lido
   e salvo direto pelo painel Cérebro. Última escrita vence.
   =========================================================== */
const GH_OWNER = 'pedrodramaral1';
const GH_REPO = 'brain';
const GH_DATA_PATH = 'planner/data.json';

function ghToken() { return localStorage.getItem('planner_gh_token') || ''; }
function ghHeaders() {
  return { 'Authorization': `Bearer ${ghToken()}`, 'Accept': 'application/vnd.github+json' };
}
// base64 unicode-safe (btoa puro quebra com acentos)
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
async function ghGet(path) {
  const r = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`, { headers: ghHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('GitHub ' + r.status);
  return r.json();
}
async function ghPut(path, content, sha, message) {
  const body = { message, content: b64encode(content) };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`, {
    method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('GitHub ' + r.status);
  return r.json();
}

function setSync(state) {
  const btn = document.getElementById('syncBtn');
  const hint = document.getElementById('syncHint');
  if (!btn) return;
  const map = {
    off:  ['⇅ Ativar sync', 'Dados neste navegador.'],
    busy: ['⟳ Sincronizando…', 'Enviando para o brain repo…'],
    ok:   ['✓ Sincronizado', 'Em nuvem: brain repo (privado).'],
    err:  ['⚠ Erro de sync', 'Falha ao falar com o GitHub. Confira o token.'],
  };
  btn.textContent = map[state][0];
  hint.textContent = map[state][1];
}

async function cloudPull() {
  if (!ghToken()) { setSync('off'); return; }
  try {
    setSync('busy');
    const f = await ghGet(GH_DATA_PATH);
    if (f) {
      ghSha = f.sha;
      const remote = JSON.parse(b64decode(f.content));
      if ((remote.updatedAt || 0) > (db.updatedAt || 0)) {
        db = remote;
        migrate();
        localStorage.setItem(STORE_KEY, JSON.stringify(db));
        refreshAll();
      }
    }
    setSync('ok');
  } catch (e) { setSync('err'); }
}

function scheduleCloudPush() {
  if (!ghToken()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(cloudPush, 1600);
}

async function cloudPush() {
  if (!ghToken() || pushing) return;
  pushing = true;
  setSync('busy');
  const payload = JSON.stringify(db, null, 2);
  try {
    const r = await ghPut(GH_DATA_PATH, payload, ghSha, `Planner ${todayStr()}`);
    ghSha = r.content.sha;
    setSync('ok');
  } catch (e) {
    // sha desatualizado (alguém salvou em outro dispositivo): repuxa o sha e tenta de novo
    try {
      const f = await ghGet(GH_DATA_PATH);
      ghSha = f ? f.sha : null;
      const r = await ghPut(GH_DATA_PATH, payload, ghSha, `Planner ${todayStr()}`);
      ghSha = r.content.sha;
      setSync('ok');
    } catch { setSync('err'); }
  } finally { pushing = false; }
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function todayStr() { return localISO(new Date()); }
function localISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

/* ---------- semanas ---------- */
function weekStart(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay()); // domingo
  return x;
}
function weekKey(d) { return localISO(weekStart(d)); }
function getWeek(d) {
  const k = weekKey(d);
  if (!db.weeks[k]) db.weeks[k] = { doc: '', tasks: [], sessionNote: '' };
  return db.weeks[k];
}
function weekNumber(d) {
  // número ISO da semana
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() + 3 - ((x.getDay() + 6) % 7));
  const jan4 = new Date(x.getFullYear(), 0, 4);
  return 1 + Math.round(((x - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

/* ===========================================================
   MARKDOWN simples (seguro: tudo escapado antes)
   =========================================================== */
function mdInline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
function md(src) {
  if (!src || !src.trim()) return '';
  const lines = esc(src).split(/\r?\n/);
  let html = '', inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (const ln of lines) {
    if (/^\s*[-•] /.test(ln)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${mdInline(ln.replace(/^\s*[-•] /, ''))}</li>`;
      continue;
    }
    closeList();
    if (/^### /.test(ln)) html += `<h4>${mdInline(ln.slice(4))}</h4>`;
    else if (/^## /.test(ln)) html += `<h3>${mdInline(ln.slice(3))}</h3>`;
    else if (/^# /.test(ln)) html += `<h2>${mdInline(ln.slice(2))}</h2>`;
    else if (/^---+\s*$/.test(ln)) html += '<hr>';
    else if (ln.trim() === '') html += '';
    else html += `<p>${mdInline(ln)}</p>`;
  }
  closeList();
  return html;
}

/* ===========================================================
   NAVEGAÇÃO
   =========================================================== */
const TITLES = {
  hoje:       ['Hoje', 'dia a dia'],
  trabalho:   ['Trabalho', 'semana'],
  financeiro: ['Financeiro', 'controle'],
  protocolos: ['Protocolos', 'hábitos'],
};

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});
function switchView(v) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
  document.getElementById('viewTitle').textContent = TITLES[v][0];
  document.getElementById('viewEyebrow').textContent = TITLES[v][1];
  if (v === 'hoje') renderHoje();
  if (v === 'trabalho') renderWeek();
  if (v === 'financeiro') renderFin();
  if (v === 'protocolos') renderProtos();
}
function refreshAll() {
  const active = document.querySelector('.view.active').id.replace('view-', '');
  switchView(active);
}
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => switchView(b.dataset.go));

/* ===========================================================
   HOJE
   =========================================================== */
function renderHoje() {
  renderDayView();
  const wk = getWeek(new Date());
  const fin = monthEntries(new Date());
  const exp = fin.filter(f => f.type === 'out').reduce((a, f) => a + f.cents, 0);
  const totalCents = db.finance.reserveCents + db.finance.entries.reduce((a, f) => a + (f.type === 'in' ? f.cents : -f.cents), 0);
  const allItems = db.protocols.flatMap(p => p.items);
  const doneItems = allItems.filter(i => i.done).length;

  document.getElementById('hojeKpis').innerHTML = `
    ${kpi('blue', wk.tasks.length, 'Tarefas na semana')}
    ${kpi(doneItems === allItems.length && allItems.length ? 'green' : 'amber', `${doneItems}/${allItems.length}`, 'Protocolos de hoje')}
    ${kpi(totalCents >= 0 ? 'green' : 'red', brl(totalCents), 'Patrimônio')}
    ${kpi('red', brl(exp), 'Gastos no mês')}
  `;

  document.getElementById('hojeProtocolos').innerHTML = db.protocols.map(p =>
    p.items.map(i => `<li class="${i.done ? 'done' : ''}">
      <input type="checkbox" data-proto="${p.id}" data-item="${i.id}" ${i.done ? 'checked' : ''} />
      <span>${esc(i.text)}</span>
      <small class="muted" style="margin-left:auto">${esc(p.name.split('·')[0].trim())}</small>
    </li>`).join('')
  ).join('') || '<li class="empty">Nenhum protocolo.</li>';
  document.querySelectorAll('#hojeProtocolos input[data-proto]').forEach(cb => cb.onchange = () => {
    const p = db.protocols.find(x => x.id === cb.dataset.proto);
    const item = p.items.find(i => i.id === cb.dataset.item);
    item.done = cb.checked; save(); renderHoje();
  });

  const recent = [...wk.tasks].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 5);
  document.getElementById('hojeSemana').innerHTML = recent.length ? recent.map(t =>
    `<li><span class="badge-type ${t.type}">${typeLabel(t.type)}</span><span style="flex:1">${esc(t.title)}</span>${t.review ? '<span class="badge-review">revisar</span>' : ''}</li>`
  ).join('') : '<li class="empty">Semana em branco.</li>';
}
function kpi(cls, val, label) {
  return `<div class="kpi ${cls}"><div class="kpi-val">${val}</div><div class="kpi-label">${label}</div></div>`;
}
function typeLabel(k) { return TASK_TYPES.find(t => t.key === k)?.label || k; }

/* ===========================================================
   AGENDA / HORÁRIOS — Google Calendar API + local fallback
   =========================================================== */
const toMin = t => { const [h, m] = (t || '00:00').split(':').map(Number); return h * 60 + m; };
const toTime = m => `${String(~~(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const durFmt = m => m >= 60 ? `${~~(m / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}` : `${m}min`;

let scheduleViewDate = new Date();
let gcalToken = null;
let gcalCache  = {};    // { 'YYYY-MM-DD': [block, ...] }
let gcalTokenClient = null;

function gcalClientId() { return localStorage.getItem('planner_gcal_client_id') || ''; }

function formatDayLabel(d) {
  const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const td = todayStr();
  const ds = localISO(d);
  if (ds === td) return `Hoje · ${d.getDate()} ${MONTHS[d.getMonth()].slice(0,3)}`;
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  if (ds === localISO(tomorrow)) return `Amanhã · ${d.getDate()} ${MONTHS[d.getMonth()].slice(0,3)}`;
  return `${days[d.getDay()]} · ${d.getDate()} ${MONTHS[d.getMonth()].slice(0,3)} ${d.getFullYear()}`;
}

/* ---- OAuth / GCal API ---- */
function initGcalClient() {
  const id = gcalClientId();
  if (!id || !window.google?.accounts?.oauth2) return;
  gcalTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: id,
    scope: 'https://www.googleapis.com/auth/calendar.events',
    callback: resp => {
      if (resp.access_token) {
        gcalToken = resp.access_token;
        gcalCache  = {};
        setGcalStatus('ok');
        renderDayView();
      } else {
        setGcalStatus('err');
      }
    },
  });
}

function setGcalStatus(state) {
  const btn = document.getElementById('gcalConnectBtn');
  if (!btn) return;
  const map = { idle: '📅 Conectar GCal', ok: '✓ GCal conectado', err: '⚠ Reconectar GCal', busy: '⟳ …' };
  btn.textContent = map[state] || map.idle;
  btn.dataset.state = state;
}

async function gcalFetchDay(dateStr) {
  if (!gcalToken) return null;
  const tMin = encodeURIComponent(dateStr + 'T00:00:00-03:00');
  const tMax = encodeURIComponent(dateStr + 'T23:59:59-03:00');
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${tMin}&timeMax=${tMax}&singleEvents=true&orderBy=startTime&maxResults=50`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${gcalToken}` } });
  if (r.status === 401) { gcalToken = null; setGcalStatus('err'); return null; }
  if (!r.ok) return null;
  const data = await r.json();
  return (data.items || []).map(gcalItemToBlock).filter(b => b.start !== b.end);
}

function gcalItemToBlock(ev) {
  const toHH = dt => (dt || '').slice(11, 16) || '00:00';
  return {
    id: ev.id, gcalId: ev.id, source: 'gcal',
    title: ev.summary || '(sem título)',
    start: toHH(ev.start?.dateTime), end: toHH(ev.end?.dateTime),
    notes: ev.description || '',
    type: 'external',
  };
}

async function gcalCreateEvent(dateStr, title, start, end, notes, type) {
  if (!gcalToken) return null;
  const tz = 'America/Sao_Paulo';
  const body = {
    summary: title,
    description: notes || '',
    start: { dateTime: `${dateStr}T${start}:00`, timeZone: tz },
    end:   { dateTime: `${dateStr}T${end}:00`,   timeZone: tz },
    colorId: { work:'5', study:'1', health:'2', personal:'3', external:'8' }[type] || '8',
  };
  const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST', headers: { Authorization: `Bearer ${gcalToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) return null;
  return r.json();
}

async function gcalUpdateEvent(gcalId, dateStr, title, start, end, notes, type) {
  if (!gcalToken || !gcalId) return null;
  const tz = 'America/Sao_Paulo';
  const body = {
    summary: title,
    description: notes || '',
    start: { dateTime: `${dateStr}T${start}:00`, timeZone: tz },
    end:   { dateTime: `${dateStr}T${end}:00`,   timeZone: tz },
    colorId: { work:'5', study:'1', health:'2', personal:'3', external:'8' }[type] || '8',
  };
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${gcalId}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${gcalToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.ok ? r.json() : null;
}

async function gcalDeleteEvent(gcalId) {
  if (!gcalToken || !gcalId) return;
  await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${gcalId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${gcalToken}` },
  });
}

/* ---- day view ---- */
function getDayBlocks(dateStr) {
  if (!db.agenda[dateStr]) db.agenda[dateStr] = [];
  return db.agenda[dateStr];
}

function calcFreeSlots(blocks, from = '06:00', to = '23:30') {
  const sorted = [...blocks].sort((a, b) => toMin(a.start) - toMin(b.start));
  const free = [], end = toMin(to);
  let cur = toMin(from);
  for (const b of sorted) {
    const bs = toMin(b.start), be = toMin(b.end);
    if (bs > cur + 14) free.push({ start: toTime(cur), end: b.start, min: bs - cur });
    cur = Math.max(cur, be);
  }
  if (cur + 14 < end) free.push({ start: toTime(cur), end: to, min: end - cur });
  return free;
}

function gcalNewLink(date, start, end) {
  const fmt = (d, t) => d.replace(/-/g,'') + 'T' + t.replace(':','') + '00';
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=Novo+evento&dates=${fmt(date,start)}/${fmt(date,end)}&sf=true`;
}

async function renderDayView() {
  const el = document.getElementById('scheduleTimeline');
  if (!el) return;

  const dateStr = localISO(scheduleViewDate);
  document.getElementById('schedDayLabel').textContent = formatDayLabel(scheduleViewDate);

  // Source: GCal when connected, local planner otherwise
  let blocks;
  if (gcalToken) {
    if (!gcalCache[dateStr]) {
      el.innerHTML = '<div class="sched-loading">Carregando…</div>';
      gcalCache[dateStr] = await gcalFetchDay(dateStr) || getDayBlocks(dateStr);
    }
    blocks = gcalCache[dateStr];
  } else {
    blocks = getDayBlocks(dateStr).slice();
  }

  const sorted = [...blocks].sort((a, b) => toMin(a.start) - toMin(b.start));

  if (!sorted.length) {
    el.innerHTML = `<div class="sched-empty">
      <p class="muted">${gcalToken ? 'Nenhum evento no Google Calendar.' : 'Nenhum compromisso registrado.'}</p>
      <p class="muted" style="font-size:12px;margin-top:4px">${gcalToken ? 'Adicione um evento — ele vai direto pro GCal.' : 'Conecte o GCal ou adicione eventos manualmente.'}</p>
    </div>`;
    return;
  }

  // Build interleaved items (blocks + free slots)
  const items = [];
  let cur = toMin('06:00');
  for (const b of sorted) {
    const bs = toMin(b.start);
    if (bs > cur + 14) items.push({ isFree: true, start: toTime(cur), end: b.start, min: bs - cur });
    items.push({ ...b, isFree: false });
    cur = Math.max(cur, toMin(b.end));
  }
  const dayEnd = toMin('23:30');
  if (cur + 14 < dayEnd) items.push({ isFree: true, start: toTime(cur), end: '23:30', min: dayEnd - cur });

  el.innerHTML = items.map(item => {
    if (item.isFree) {
      return `<div class="sched-free">
        <div class="sched-free-info">
          <span class="sched-free-label">livre</span>
          <span class="sched-free-time">${item.start} – ${item.end}</span>
          <span class="sched-free-dur">${durFmt(item.min)}</span>
        </div>
        <a class="btn-soft sched-gcal-link" href="${gcalNewLink(dateStr, item.start, item.end)}" target="_blank" rel="noopener">+ GCal ↗</a>
      </div>`;
    }
    const isGcal = item.source === 'gcal';
    const bt = BLOCK_TYPES.find(t => t.key === item.type) || BLOCK_TYPES[4];
    const blockMin = toMin(item.end) - toMin(item.start);
    return `<div class="sched-block sched-block-${item.type}" data-id="${item.id}">
      <div class="sched-block-accent sched-accent-${item.type}"></div>
      <div class="sched-block-body">
        <div class="sched-block-top">
          <strong>${esc(item.title)}</strong>
          ${isGcal ? '<span class="sched-gcal-badge">GCal</span>' : `<span class="sched-type-chip sched-chip-${item.type}">${bt.label}</span>`}
        </div>
        <span class="sched-block-time">${item.start} – ${item.end} · ${durFmt(blockMin)}</span>
        ${item.notes ? `<small class="muted">${esc(item.notes)}</small>` : ''}
      </div>
      <div class="sched-block-actions">
        <button class="tc-mini sched-edit" data-id="${item.id}" title="Editar">✎</button>
        <button class="tc-mini sched-del" data-id="${item.id}" title="Excluir">✕</button>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.sched-edit').forEach(b => {
    b.onclick = () => {
      const block = blocks.find(x => x.id === b.dataset.id);
      if (block) openBlockModal(block, dateStr);
    };
  });
  el.querySelectorAll('.sched-del').forEach(b => {
    b.onclick = async () => {
      const block = blocks.find(x => x.id === b.dataset.id);
      if (!block) return;
      if (block.gcalId) await gcalDeleteEvent(block.gcalId);
      else {
        db.agenda[dateStr] = getDayBlocks(dateStr).filter(x => x.id !== block.id);
        save();
      }
      gcalCache[dateStr] = null;
      toast('Evento excluído');
      renderDayView();
    };
  });
}

function openBlockModal(blockOrId, dateStr) {
  const ds = dateStr || localISO(scheduleViewDate);
  const block = typeof blockOrId === 'string'
    ? getDayBlocks(ds).find(b => b.id === blockOrId)
    : blockOrId;

  modalTitle.textContent = block ? 'Editar evento' : 'Novo evento';
  const typeVal = BLOCK_TYPES.find(t => t.key === (block?.type || 'work'))?.label || 'Trabalho';
  modalForm.innerHTML = `
    ${field('Título', 'title', 'text', block?.title || '')}
    <div class="field-row">
      ${field('Início', 'start', 'time', block?.start || '08:00')}
      ${field('Fim', 'end', 'time', block?.end || '09:00')}
    </div>
    ${field('Tipo', 'type', 'select', typeVal, BLOCK_TYPES.map(t => t.label))}
    ${field('Notas (opcional)', 'notes', 'text', block?.notes || '')}
    <div class="modal-actions">
      ${block ? '<button type="button" class="btn-del" data-del>Excluir</button>' : ''}
      <button type="button" class="btn-ghost" data-cancel>Cancelar</button>
      <button type="submit" class="btn-primary">${block ? 'Salvar' : 'Adicionar'}</button>
    </div>`;

  wireModal(async data => {
    if (!data.title.trim()) { toast('Dê um título'); return; }
    if (!data.start || !data.end || data.start >= data.end) { toast('Horário inválido'); return; }
    const type = BLOCK_TYPES.find(t => t.label === data.type)?.key || 'work';
    const entry = { title: data.title.trim(), start: data.start, end: data.end, type, notes: data.notes.trim() };

    if (gcalToken) {
      setGcalStatus('busy');
      if (block?.gcalId) {
        await gcalUpdateEvent(block.gcalId, ds, entry.title, entry.start, entry.end, entry.notes, type);
        toast('Evento atualizado no GCal');
      } else {
        const ev = await gcalCreateEvent(ds, entry.title, entry.start, entry.end, entry.notes, type);
        toast(ev ? 'Evento criado no GCal' : 'Salvo localmente (falha no GCal)');
        if (!ev) { getDayBlocks(ds).push({ id: uid(), ...entry }); save(); }
      }
      setGcalStatus('ok');
    } else {
      const localBlocks = getDayBlocks(ds);
      if (block) Object.assign(block, entry);
      else localBlocks.push({ id: uid(), ...entry });
      save();
      toast(block ? 'Atualizado' : 'Evento adicionado');
    }
    gcalCache[ds] = null;
    closeModal();
    renderDayView();
  }, block && (async () => {
    if (block.gcalId) await gcalDeleteEvent(block.gcalId);
    else { db.agenda[ds] = getDayBlocks(ds).filter(x => x.id !== block.id); save(); }
    gcalCache[ds] = null;
    toast('Excluído');
    closeModal();
    renderDayView();
  }));
}

/* ---- day navigation ---- */
document.getElementById('schedDayPrev').onclick  = () => { scheduleViewDate.setDate(scheduleViewDate.getDate() - 1); renderDayView(); };
document.getElementById('schedDayNext').onclick  = () => { scheduleViewDate.setDate(scheduleViewDate.getDate() + 1); renderDayView(); };
document.getElementById('schedDayToday').onclick = () => { scheduleViewDate = new Date(); renderDayView(); };
document.getElementById('addBlockBtn').onclick   = () => openBlockModal(null);

/* ---- GCal connect button ---- */
document.getElementById('gcalConnectBtn').onclick = () => {
  if (!gcalClientId()) {
    openGcalSetupModal();
    return;
  }
  if (!gcalTokenClient) { initGcalClient(); }
  if (gcalToken) { gcalToken = null; gcalCache = {}; setGcalStatus('idle'); renderDayView(); toast('GCal desconectado'); return; }
  gcalTokenClient?.requestAccessToken();
};

function openGcalSetupModal() {
  modalTitle.textContent = 'Conectar Google Calendar';
  modalForm.innerHTML = `
    ${field('Client ID do Google Cloud', 'clientId', 'text', gcalClientId())}
    <div class="field">
      <p class="muted" style="font-size:12px;line-height:1.6">
        1. Acessa <strong>console.cloud.google.com</strong><br>
        2. Cria um projeto → ativa <strong>Google Calendar API</strong><br>
        3. Credenciais → OAuth 2.0 → Aplicativo da Web<br>
        4. Origem autorizada: <code>https://pedrodramaral1.github.io</code><br>
        5. Copia o Client ID e cola acima.
      </p>
    </div>
    <div class="modal-actions">
      ${gcalClientId() ? '<button type="button" class="btn-del" data-del>Remover</button>' : ''}
      <button type="button" class="btn-ghost" data-cancel>Cancelar</button>
      <button type="submit" class="btn-primary">Salvar e conectar</button>
    </div>`;
  wireModal(data => {
    const id = data.clientId.trim();
    if (!id) { toast('Cole o Client ID'); return; }
    localStorage.setItem('planner_gcal_client_id', id);
    closeModal();
    initGcalClient();
    setTimeout(() => gcalTokenClient?.requestAccessToken(), 100);
  }, () => {
    localStorage.removeItem('planner_gcal_client_id');
    gcalToken = null; gcalTokenClient = null; gcalCache = {};
    setGcalStatus('idle');
    toast('Client ID removido');
    closeModal();
  });
}

/* ===========================================================
   TRABALHO — diário semanal
   =========================================================== */
function renderWeek() {
  // se editor inline estiver aberto, salva antes de mudar
  if (docEditor && !docEditor.hidden) {
    getWeek(weekRef).doc = docEditor.value;
    save();
    docEditor.hidden = true;
    docBody.hidden = false;
  }
  if (sessionEditor && !sessionEditor.hidden) {
    getWeek(weekRef).sessionNote = sessionEditor.value;
    save();
    sessionEditor.hidden = true;
    sessionBody.hidden = false;
  }
  const start = weekStart(weekRef);
  const end = new Date(start); end.setDate(start.getDate() + 6);
  const wk = getWeek(weekRef);

  document.getElementById('weekLabel').textContent = `Semana ${weekNumber(weekRef)}`;
  document.getElementById('weekRangeLabel').textContent =
    `${start.getDate()} ${MONTHS[start.getMonth()].slice(0,3).toLowerCase()} – ${end.getDate()} ${MONTHS[end.getMonth()].slice(0,3).toLowerCase()} ${end.getFullYear()}`;

  // documento (inline editable)
  renderWeekDoc();

  // filtros por tipo
  const counts = { aprendi: 0, aprimorei: 0, criei: 0 };
  wk.tasks.forEach(t => { if (counts[t.type] !== undefined) counts[t.type]++; });
  document.getElementById('typeFilters').innerHTML = TASK_TYPES.map(x => `
    <button class="tf-chip ${taskFilter === x.key ? 'active' : ''}" data-type="${x.key}">
      <span class="type-dot ${x.key}"></span>${counts[x.key]}
    </button>`).join('');
  document.querySelectorAll('.tf-chip').forEach(b => b.onclick = () => {
    taskFilter = taskFilter === b.dataset.type ? null : b.dataset.type;
    renderWeek();
  });

  // tabela de tarefas
  const tasks = [...wk.tasks]
    .filter(t => !taskFilter || t.type === taskFilter)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const tbody = document.getElementById('wtableBody');
  tbody.innerHTML = tasks.length ? tasks.map(t => `
    <tr data-id="${t.id}" class="type-row-${t.type}">
      <td class="col-title"><strong>${esc(t.title)}</strong>${t.notes ? `<small>${esc(t.notes)}</small>` : ''}</td>
      <td class="td-center"><span class="type-dot ${t.type}" title="${typeLabel(t.type)}"></span></td>
      <td class="td-date">${t.date ? `${t.date.slice(8,10)}/${t.date.slice(5,7)}` : '—'}</td>
      <td class="td-center"><input type="checkbox" class="t-review" ${t.review ? 'checked' : ''} /></td>
      <td class="td-date">${t.timeMin ? t.timeMin + ' min' : '—'}</td>
      <td class="td-center">${t.link ? `<a class="t-link" href="${esc(t.link)}" target="_blank" rel="noopener">↗</a>` : '—'}</td>
      <td>${(t.tags || []).map(s => `<span class="skill-tag">${esc(s)}</span>`).join(' ')}</td>
      <td class="td-center"><button class="tc-mini t-edit" title="Editar">✎</button></td>
    </tr>`).join('') : '<tr><td colspan="8" class="empty td-empty">—</td></tr>';

  const rev = wk.tasks.filter(t => t.review).length;
  const mins = wk.tasks.reduce((a, t) => a + (t.timeMin || 0), 0);
  const hrs = mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60 ? String(mins % 60).padStart(2, '0') : ''}` : `${mins} min`;
  document.getElementById('weekStats').textContent =
    wk.tasks.length ? `${wk.tasks.length} tarefa(s)${mins ? ' · ' + hrs : ''}${rev ? ' · ' + rev + ' p/ revisar' : ''}` : '';

  tbody.querySelectorAll('.t-review').forEach(cb => cb.onchange = () => {
    const t = wk.tasks.find(x => x.id === cb.closest('tr').dataset.id);
    t.review = cb.checked; save(); renderWeek();
  });
  tbody.querySelectorAll('.t-edit').forEach(b => b.onclick = () => openTaskModal(b.closest('tr').dataset.id));

  renderSkillBars();
  renderWeekSession();
}
function renderSkillBars() {
  const counts = {};
  Object.values(db.weeks).forEach(w => w.tasks.forEach(t => (t.tags || []).forEach(s => {
    const k = s.trim(); if (k) counts[k] = (counts[k] || 0) + 1;
  })));
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 14);
  const max = sorted[0]?.[1] || 1;
  document.getElementById('skillBars').innerHTML = sorted.length ? sorted.map(([skill, n]) => `
    <div class="sb-row">
      <span class="sb-label">${esc(skill)}</span>
      <div class="sb-track"><div class="sb-fill" style="width:${Math.round(n / max * 100)}%"></div></div>
      <span class="sb-num">${n}</span>
    </div>`).join('') : '<div class="empty">Adicione tags nas tarefas.</div>';
}
document.getElementById('weekPrev').onclick = () => { weekRef.setDate(weekRef.getDate() - 7); taskFilter = null; renderWeek(); };
document.getElementById('weekNext').onclick = () => { weekRef.setDate(weekRef.getDate() + 7); taskFilter = null; renderWeek(); };
document.getElementById('weekToday').onclick = () => { weekRef = new Date(); taskFilter = null; renderWeek(); };
document.getElementById('addTaskBtn').onclick = () => openTaskModal();

/* ---- registro rápido: digita + Enter, sem modal ---- */
let taskFilter = null;
const qaTitle = document.getElementById('qaTitle');
const qaType = document.getElementById('qaType');
qaTitle.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const title = qaTitle.value.trim();
  if (!title) return;
  getWeek(weekRef).tasks.push({
    id: uid(), title, type: qaType.value, date: todayStr(),
    review: false, timeMin: null, link: '', tags: [], notes: '',
  });
  save();
  qaTitle.value = '';
  renderWeek();
  qaTitle.focus();
});

/* ---- documento inline editable ---- */
const docBody = document.getElementById('docBody');
const docEditor = document.getElementById('docInlineEditor');

function renderWeekDoc() {
  const wk = getWeek(weekRef);
  if (wk.doc && wk.doc.trim()) {
    docBody.innerHTML = md(wk.doc);
    docBody.classList.remove('doc-empty');
  } else {
    docBody.innerHTML = `<p class="doc-placeholder">clique para escrever&hellip;</p>`;
    docBody.classList.add('doc-empty');
  }
}

docBody.addEventListener('click', () => {
  const wk = getWeek(weekRef);
  docEditor.value = wk.doc || DOC_TEMPLATE;
  docBody.hidden = true;
  docEditor.hidden = false;
  docEditor.focus();
});

docEditor.addEventListener('blur', () => {
  const wk = getWeek(weekRef);
  wk.doc = docEditor.value;
  save();
  docEditor.hidden = true;
  docBody.hidden = false;
  renderWeekDoc();
});

/* ---- notas de sessão (integração brain) ---- */
const sessionBody = document.getElementById('sessionBody');
const sessionEditor = document.getElementById('sessionEditor');

function renderWeekSession() {
  const wk = getWeek(weekRef);
  if (wk.sessionNote && wk.sessionNote.trim()) {
    sessionBody.innerHTML = md(wk.sessionNote);
    sessionBody.classList.remove('doc-empty');
  } else {
    sessionBody.innerHTML = `<p class="doc-placeholder">notas desta sessão para o brain&hellip;</p>`;
    sessionBody.classList.add('doc-empty');
  }
}

sessionBody.addEventListener('click', () => {
  const wk = getWeek(weekRef);
  sessionEditor.value = wk.sessionNote || '';
  sessionBody.hidden = true;
  sessionEditor.hidden = false;
  sessionEditor.focus();
});

sessionEditor.addEventListener('blur', () => {
  const wk = getWeek(weekRef);
  wk.sessionNote = sessionEditor.value;
  save();
  sessionEditor.hidden = true;
  sessionBody.hidden = false;
  renderWeekSession();
});

document.getElementById('copySessionBtn').onclick = () => {
  const wk = getWeek(weekRef);
  if (!wk.sessionNote?.trim()) { toast('Nada para copiar'); return; }
  navigator.clipboard.writeText(wk.sessionNote).then(() => toast('Notas copiadas'));
};

document.getElementById('genNoteBtn').onclick = () => {
  const wk = getWeek(weekRef);
  if (!wk.tasks.length) { toast('Sem tarefas nesta semana'); return; }
  const byType = { aprendi: [], aprimorei: [], criei: [] };
  wk.tasks.forEach(t => { if (byType[t.type]) byType[t.type].push(t.title); });
  const range = document.getElementById('weekRangeLabel').textContent;
  let note = `## Semana ${weekNumber(weekRef)} · ${range}\n\n`;
  if (byType.aprendi.length)   note += `**Aprendi:** ${byType.aprendi.join(', ')}\n`;
  if (byType.aprimorei.length) note += `**Aprimorei:** ${byType.aprimorei.join(', ')}\n`;
  if (byType.criei.length)     note += `**Criei:** ${byType.criei.join(', ')}\n`;
  const revTasks = wk.tasks.filter(t => t.review);
  if (revTasks.length) note += `\n**Para revisar:** ${revTasks.map(t => t.title).join(', ')}\n`;
  wk.sessionNote = note.trim();
  save();
  renderWeekSession();
  sessionBody.hidden = false;
  sessionEditor.hidden = true;
  toast('Resumo gerado — edite e copie para o brain');
};

/* ---- tarefa da semana (estilo tabela de tracking) ---- */
function openTaskModal(id) {
  const wk = getWeek(weekRef);
  const t = id ? wk.tasks.find(x => x.id === id) : null;
  modalTitle.textContent = t ? 'Editar tarefa' : 'Nova tarefa da semana';
  modalForm.innerHTML = `
    ${field('Tarefa', 'title', 'text', t?.title || '')}
    ${field('Notas (opcional)', 'notes', 'text', t?.notes || '')}
    <div class="field-row">
      ${field('Tipo', 'type', 'select', typeLabel(t?.type || 'aprendi'), TASK_TYPES.map(x => x.label))}
      ${field('Data', 'date', 'date', t?.date || todayStr())}
    </div>
    <div class="field-row">
      ${field('Tempo gasto (min)', 'timeMin', 'number', t?.timeMin || '')}
      ${field('Link (opcional)', 'link', 'text', t?.link || '')}
    </div>
    ${field('Tags de tecnologia (separe por vírgula)', 'tags', 'text', (t?.tags || []).join(', '))}
    <div class="modal-actions">
      ${t ? '<button type="button" class="btn-del" data-del>Excluir</button>' : ''}
      <button type="button" class="btn-ghost" data-cancel>Cancelar</button>
      <button type="submit" class="btn-primary">${t ? 'Salvar' : 'Adicionar'}</button>
    </div>`;
  wireModal(data => {
    if (!data.title.trim()) { toast('Dê um nome à tarefa'); return; }
    const entry = {
      title: data.title.trim(), notes: data.notes.trim(),
      type: TASK_TYPES.find(x => x.label === data.type)?.key || 'aprendi',
      date: data.date || todayStr(),
      timeMin: data.timeMin ? Math.max(0, parseInt(data.timeMin, 10)) : null,
      link: data.link.trim(),
      tags: data.tags.split(',').map(s => s.trim()).filter(Boolean),
    };
    if (t) Object.assign(t, entry);
    else wk.tasks.push({ id: uid(), review: false, ...entry });
    save(); toast(t ? 'Tarefa atualizada' : 'Tarefa adicionada'); closeModal(); refreshAll();
  }, t && (() => { wk.tasks = wk.tasks.filter(x => x.id !== id); save(); toast('Tarefa excluída'); refreshAll(); }));
}

/* ===========================================================
   CÉREBRO — documento-mestre, sempre acessível
   =========================================================== */
const brainOverlay = document.getElementById('brainOverlay');
const brainBody = document.getElementById('brainBody');
const brainEditor = document.getElementById('brainEditor');
const brainFoot = document.getElementById('brainFoot');

function renderBrain() {
  if (db.brain && db.brain.trim()) {
    brainBody.innerHTML = md(db.brain);
  } else {
    brainBody.innerHTML = `<p class="doc-placeholder">Clique em <strong>✎ Editar</strong> para começar.</p>`;
  }
}
async function openBrain() {
  renderBrain();
  brainOverlay.hidden = false;
  brainBody.hidden = false;
  brainEditor.hidden = true;
  brainFoot.hidden = true;
  // com sync ativo, o painel mostra o cerebro.md real do repo
  if (ghToken()) {
    try {
      const f = await ghGet('cerebro.md');
      if (f) {
        brainSha = f.sha;
        db.brain = b64decode(f.content);
        localStorage.setItem(STORE_KEY, JSON.stringify(db));
        renderBrain();
      }
    } catch {}
  }
}
function closeBrain() { brainOverlay.hidden = true; }
document.getElementById('brainBtn').onclick = openBrain;
document.getElementById('brainClose').onclick = closeBrain;
brainOverlay.addEventListener('click', e => { if (e.target === brainOverlay) closeBrain(); });
document.getElementById('brainEditBtn').onclick = () => {
  brainEditor.value = db.brain || '# Cérebro\n\n## Quem eu sou\n- \n\n## Metas 2026\n- \n\n## Projetos ativos\n- \n\n## Princípios\n- ';
  brainBody.hidden = true;
  brainEditor.hidden = false;
  brainFoot.hidden = false;
  brainEditor.focus();
};
document.getElementById('brainSaveBtn').onclick = async () => {
  db.brain = brainEditor.value;
  save();
  renderBrain();
  brainBody.hidden = false;
  brainEditor.hidden = true;
  brainFoot.hidden = true;
  if (ghToken()) {
    try {
      const r = await ghPut('cerebro.md', db.brain, brainSha, `Atualiza cerebro via planner ${todayStr()}`);
      brainSha = r.content.sha;
      toast('Cérebro salvo no brain repo');
    } catch { toast('Salvo aqui; falha ao enviar pro GitHub'); }
  } else {
    toast('Cérebro atualizado');
  }
};

/* ===========================================================
   SESSÕES — lista e visualização das sessões do brain repo
   =========================================================== */

/* --- abas do cérebro --- */
document.querySelectorAll('.brain-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.brain-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('brainTabCerebro').hidden = (tab !== 'cerebro');
    document.getElementById('brainTabSessoes').hidden = (tab !== 'sessoes');
    if (tab === 'sessoes') loadSessoes();
  });
});

async function loadSessoes() {
  const list = document.getElementById('sessoesList');
  if (!ghToken()) {
    list.innerHTML = `<p class="sessoes-empty">Ative o sync para visualizar as sessões do brain repo.</p>`;
    return;
  }
  list.innerHTML = `<p class="sessoes-loading"><span>⟳</span> Carregando sessões…</p>`;
  try {
    const files = await ghGet('sessoes');
    if (!files || !Array.isArray(files)) {
      list.innerHTML = `<p class="sessoes-empty">Nenhuma sessão encontrada.</p>`;
      return;
    }
    const sessions = files
      .filter(f => f.name.endsWith('.md') && f.name !== 'TEMPLATE.md')
      .sort((a, b) => b.name.localeCompare(a.name));
    if (!sessions.length) {
      list.innerHTML = `<p class="sessoes-empty">Nenhuma sessão registrada ainda.</p>`;
      return;
    }
    list.innerHTML = sessions.map(f => {
      const dateStr = f.name.replace('.md', '');
      const label = formatSessionDate(dateStr);
      return `<div class="sessao-item" data-file="${f.name}" data-date="${dateStr}" data-label="${label}">
        <div class="sessao-item-info">
          <span class="sessao-item-date">${label}</span>
          <span class="sessao-item-meta">${dateStr}</span>
        </div>
        <span class="sessao-item-arrow">›</span>
      </div>`;
    }).join('');
    list.querySelectorAll('.sessao-item').forEach(el => {
      el.addEventListener('click', () => openSessaoDetalhe(el.dataset.file, el.dataset.date, el.dataset.label));
    });
  } catch {
    list.innerHTML = `<p class="sessoes-empty">Falha ao carregar sessões. Verifique o token.</p>`;
  }
}

function formatSessionDate(str) {
  const [y, m, d] = str.split('-');
  if (!y || !m || !d) return str;
  const months = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  return `${parseInt(d)} de ${months[parseInt(m) - 1]} de ${y}`;
}

async function openSessaoDetalhe(filename, dateStr, label) {
  const overlay = document.getElementById('sessionDetailOverlay');
  const body = document.getElementById('sessionDetailBody');
  const titleEl = document.getElementById('sessionDetailTitle');
  const dateEl = document.getElementById('sessionDetailDate');

  dateEl.textContent = dateStr;
  titleEl.textContent = label;
  body.innerHTML = `<p class="sessoes-loading">⟳ Carregando…</p>`;
  overlay.hidden = false;

  try {
    const f = await ghGet(`sessoes/${filename}`);
    if (f) {
      const content = b64decode(f.content);
      body.innerHTML = md(content);
      overlay.dataset.printContent = content;
      overlay.dataset.printLabel = label;
      overlay.dataset.printDate = dateStr;
    } else {
      body.innerHTML = `<p class="sessoes-empty">Arquivo não encontrado.</p>`;
    }
  } catch {
    body.innerHTML = `<p class="sessoes-empty">Falha ao carregar sessão.</p>`;
  }
}

document.getElementById('sessionDetailClose').onclick = () => {
  document.getElementById('sessionDetailOverlay').hidden = true;
};
document.getElementById('sessionDetailOverlay').addEventListener('click', e => {
  if (e.target === document.getElementById('sessionDetailOverlay'))
    document.getElementById('sessionDetailOverlay').hidden = true;
});

document.getElementById('sessionPrintBtn').onclick = () => {
  const overlay = document.getElementById('sessionDetailOverlay');
  const content = overlay.dataset.printContent || '';
  const label = overlay.dataset.printLabel || 'Sessão';
  const dateStr = overlay.dataset.printDate || '';

  let root = document.getElementById('sessionPrintRoot');
  if (!root) {
    root = document.createElement('div');
    root.id = 'sessionPrintRoot';
    document.body.appendChild(root);
  }
  root.innerHTML = `
    <div class="print-meta">Planner · Pedro Amaral &nbsp;|&nbsp; ${label} &nbsp;|&nbsp; ${dateStr}</div>
    ${md(content)}
  `;
  window.print();
};

/* ---- modal de sync ---- */
function openSyncModal() {
  modalTitle.textContent = 'Sync em nuvem';
  modalForm.innerHTML = `
    ${field('Token do GitHub', 'token', 'password', ghToken())}
    <p class="muted">Token fine-grained com permissão <strong>Contents: read and write</strong> apenas no repo <strong>brain</strong>. Crie em github.com/settings/personal-access-tokens. Fica salvo só neste navegador.</p>
    <p class="muted">Com o sync ativo, tudo (tarefas, financeiro, protocolos, cérebro) vive no brain repo. Editou ou excluiu aqui, atualiza em todos os dispositivos.</p>
    <div class="modal-actions">
      ${ghToken() ? '<button type="button" class="btn-del" data-del>Desativar</button>' : ''}
      <button type="button" class="btn-ghost" data-cancel>Cancelar</button>
      <button type="submit" class="btn-primary">Ativar</button>
    </div>`;
  wireModal(data => {
    const t = data.token.trim();
    if (!t) { toast('Cole o token'); return; }
    localStorage.setItem('planner_gh_token', t);
    closeModal();
    toast('Sync ativado');
    ghSha = null;
    cloudPull().then(() => cloudPush());
  }, ghToken() ? (() => {
    localStorage.removeItem('planner_gh_token');
    setSync('off');
    toast('Sync desativado');
  }) : null);
}
document.getElementById('syncBtn').onclick = openSyncModal;

/* ===========================================================
   FINANCEIRO
   =========================================================== */
function monthEntries(date) {
  const prefix = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  return db.finance.entries.filter(f => (f.date || '').startsWith(prefix));
}
function renderFin() {
  const y = finDate.getFullYear(), m = finDate.getMonth();
  const monthLabel = `${MONTHS[m]} ${y}`;
  document.getElementById('finMonthLabel').textContent = monthLabel;
  document.getElementById('finMonthLabelSub').textContent = monthLabel;
  document.getElementById('catMonthLabel').textContent = monthLabel;

  const entries = monthEntries(finDate).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const inc = entries.filter(f => f.type === 'in').reduce((a, f) => a + f.cents, 0);
  const exp = entries.filter(f => f.type === 'out').reduce((a, f) => a + f.cents, 0);
  const totalCents = db.finance.reserveCents + db.finance.entries.reduce((a, f) => a + (f.type === 'in' ? f.cents : -f.cents), 0);
  const result = inc - exp;

  document.getElementById('finKpis').innerHTML = `
    ${kpi(totalCents >= 0 ? 'green' : 'red', brl(totalCents), 'Patrimônio')}
    ${kpi('green', brl(inc), 'Entradas')}
    ${kpi('red', brl(exp), 'Saídas')}
    ${kpi(result >= 0 ? 'blue' : 'red', brl(result), 'Resultado')}
  `;

  // Agrupa por data com cabeçalho de dia
  if (entries.length) {
    const grouped = {};
    entries.forEach(f => { const d = f.date || todayStr(); (grouped[d] = grouped[d] || []).push(f); });
    const days = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
    let html = '';
    days.forEach(dk => {
      const dayEntries = grouped[dk];
      const dayResult = dayEntries.reduce((a, f) => a + (f.type === 'in' ? f.cents : -f.cents), 0);
      html += `<li class="fin-date-header">
        <span>${dk.slice(8, 10)}/${dk.slice(5, 7)}</span>
        <span class="fin-day-total ${dayResult >= 0 ? 'in' : 'out'}">${dayResult >= 0 ? '+' : '−'} ${brl(Math.abs(dayResult))}</span>
      </li>`;
      dayEntries.forEach(f => {
        html += `<li data-id="${f.id}" class="fin-item">
          <span class="fin-ico ${f.type}">${f.type === 'in' ? '↑' : '↓'}</span>
          <span class="fin-desc">${esc(f.desc)}<small>${esc(f.cat || '')}</small></span>
          <span class="fin-val ${f.type}">${f.type === 'in' ? '+' : '−'} ${brl(f.cents)}</span>
          <div class="fin-item-btns">
            <button class="tc-mini fin-edit" title="Editar">✎</button>
            <button class="tc-mini fin-del" title="Excluir">✕</button>
          </div>
        </li>`;
      });
    });
    document.getElementById('finList').innerHTML = html;
  } else {
    document.getElementById('finList').innerHTML = '<li class="empty">Nenhum lançamento neste mês.</li>';
  }

  const byCat = {};
  entries.filter(f => f.type === 'out').forEach(f => { byCat[f.cat || 'Outros'] = (byCat[f.cat || 'Outros'] || 0) + f.cents; });
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const maxCat = cats[0]?.[1] || 1;
  document.getElementById('catBars').innerHTML = cats.length ? cats.map(([cat, cents]) => `
    <div class="sb-row">
      <span class="sb-label">${esc(cat)}</span>
      <div class="sb-track"><div class="sb-fill red" style="width:${Math.round(cents / maxCat * 100)}%"></div></div>
      <span class="sb-num">${brl(cents)}</span>
    </div>`).join('') : '<div class="empty">Sem gastos neste mês.</div>';

  document.querySelectorAll('.fin-edit').forEach(b => b.onclick = () => openFinModal(b.closest('li').dataset.id));
  document.querySelectorAll('.fin-del').forEach(b => b.onclick = () => {
    const id = b.closest('li').dataset.id;
    if (confirm('Excluir este lançamento?')) {
      db.finance.entries = db.finance.entries.filter(f => f.id !== id);
      save(); toast('Lançamento excluído'); renderFin();
    }
  });
}
document.getElementById('finPrev').onclick = () => { finDate.setMonth(finDate.getMonth() - 1); renderFin(); };
document.getElementById('finNext').onclick = () => { finDate.setMonth(finDate.getMonth() + 1); renderFin(); };
document.getElementById('addFinBtn').onclick = () => openFinModal();
document.getElementById('reserveBtn').onclick = openReserveModal;

/* ---- Finance quick-add (setup único) ---- */
(function setupFinQa() {
  const descEl   = document.getElementById('finQaDesc');
  const amtEl    = document.getElementById('finQaAmount');
  const typeEl   = document.getElementById('finQaType');
  const catEl    = document.getElementById('finQaCat');
  const btn      = document.getElementById('finQaBtn');
  catEl.innerHTML = FIN_CATS.map(c => `<option>${c}</option>`).join('');
  function commit() {
    const desc = descEl.value.trim();
    if (!desc) { toast('Descreva o lançamento'); descEl.focus(); return; }
    const cents = parseCents(amtEl.value);
    if (isNaN(cents) || cents <= 0) { toast('Valor inválido — ex: 45,90'); amtEl.focus(); return; }
    db.finance.entries.push({ id: uid(), desc, type: typeEl.value, cents, cat: catEl.value, date: todayStr() });
    save();
    descEl.value = ''; amtEl.value = '';
    toast('Lançado');
    renderFin();
    descEl.focus();
  }
  btn.onclick = commit;
  amtEl.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); });
  descEl.addEventListener('keydown', e => { if (e.key === 'Enter') amtEl.focus(); });
})();

/* ---- Importação de extrato do Banco do Brasil (OFX / CSV) ---- */
document.getElementById('bbImportBtn').onclick = () => document.getElementById('bbFile').click();
document.getElementById('bbFile').onchange = e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const text = reader.result;
    let txs = [];
    if (/OFX|<STMTTRN>/i.test(text)) txs = parseOFX(text);
    else txs = parseCSVExtrato(text);
    if (!txs.length) { toast('Nenhuma transação reconhecida no arquivo'); return; }
    const seen = new Set(db.finance.entries.map(f => `${f.date}|${f.type}|${f.cents}|${f.desc}`));
    let added = 0;
    txs.forEach(t => {
      const key = `${t.date}|${t.type}|${t.cents}|${t.desc}`;
      if (!seen.has(key)) { db.finance.entries.push({ id: uid(), ...t }); seen.add(key); added++; }
    });
    save(); renderFin();
    toast(added ? `${added} transação(ões) importada(s) do extrato` : 'Nada novo — extrato já estava importado');
  };
  reader.readAsText(file, 'ISO-8859-1');
  e.target.value = '';
};
function parseOFX(text) {
  const txs = [];
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  blocks.forEach(b => {
    const grab = tag => (b.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i')) || [])[1]?.trim();
    const amt = parseCents((grab('TRNAMT') || '').replace(',', '.'));
    const dt = grab('DTPOSTED') || '';
    const date = `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
    const desc = grab('MEMO') || grab('NAME') || 'Transação BB';
    if (!isNaN(amt) && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      txs.push({ type: amt >= 0 ? 'in' : 'out', cents: Math.abs(amt), desc, cat: 'Outros', date });
    }
  });
  return txs;
}
function parseCSVExtrato(text) {
  const txs = [];
  text.split(/\r?\n/).forEach(line => {
    const cols = line.split(/[;,](?=(?:[^"]*"[^"]*")*[^"]*$)/).map(c => c.replace(/^"|"$/g, '').trim());
    const dateCol = cols.find(c => /^\d{2}\/\d{2}\/\d{4}$/.test(c));
    if (!dateCol) return;
    const valCol = [...cols].reverse().find(c => /^-?[\d.]+,\d{2}$/.test(c) || /^-?\d+\.\d{2}$/.test(c));
    if (!valCol) return;
    const cents = parseCents(valCol);
    if (isNaN(cents) || cents === 0) return;
    const [d, m, y] = dateCol.split('/');
    const desc = cols.filter(c => c && c !== dateCol && c !== valCol && !/^\d+$/.test(c)).join(' · ').slice(0, 80) || 'Transação BB';
    if (/saldo/i.test(desc)) return;
    txs.push({ type: cents >= 0 ? 'in' : 'out', cents: Math.abs(cents), desc, cat: 'Outros', date: `${y}-${m}-${d}` });
  });
  return txs;
}

/* ===========================================================
   PROTOCOLOS
   =========================================================== */
function renderProtos() {
  const grid = document.getElementById('protoGrid');
  grid.innerHTML = db.protocols.length ? db.protocols.map(p => {
    const done = p.items.filter(i => i.done).length;
    const complete = done === p.items.length && p.items.length > 0;
    return `<div class="proto-card ${complete ? 'complete' : ''}" data-id="${p.id}">
      <h3>${esc(p.name)} ${complete ? '✓' : ''}</h3>
      ${p.desc ? `<p>${esc(p.desc)}</p>` : ''}
      <ul class="proto-items">
        ${p.items.map(i => `<li class="${i.done ? 'done' : ''}">
          <input type="checkbox" data-item="${i.id}" ${i.done ? 'checked' : ''} />
          <span>${esc(i.text)}</span>
        </li>`).join('')}
      </ul>
      <div class="proto-foot">
        <span class="proto-prog">${done}/${p.items.length} hoje</span>
        <button class="tc-mini proto-edit">Editar</button>
      </div>
    </div>`;
  }).join('') : '<div class="empty">Nenhum protocolo.</div>';

  grid.querySelectorAll('input[data-item]').forEach(cb => cb.onchange = () => {
    const p = db.protocols.find(x => x.id === cb.closest('.proto-card').dataset.id);
    const item = p.items.find(i => i.id === cb.dataset.item);
    item.done = cb.checked; save(); renderProtos();
  });
  grid.querySelectorAll('.proto-edit').forEach(b => b.onclick = () => openProtoModal(b.closest('.proto-card').dataset.id));
}
document.getElementById('addProtoBtn').onclick = () => openProtoModal();

/* ===========================================================
   MODAIS
   =========================================================== */
const overlay = document.getElementById('modalOverlay');
const modalForm = document.getElementById('modalForm');
const modalTitle = document.getElementById('modalTitle');
document.getElementById('modalClose').onclick = closeModal;
overlay.onclick = e => { if (e.target === overlay) closeModal(); };
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!overlay.hidden) closeModal();
    else if (!brainOverlay.hidden) closeBrain();
  }
});
function closeModal() { overlay.hidden = true; modalForm.innerHTML = ''; }

function field(label, name, type = 'text', value = '', opts = null) {
  const v = esc(value ?? '');
  if (type === 'textarea') return `<div class="field"><label>${label}</label><textarea name="${name}">${v}</textarea></div>`;
  if (type === 'select') {
    const options = opts.map(o => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('');
    return `<div class="field"><label>${label}</label><select name="${name}">${options}</select></div>`;
  }
  return `<div class="field"><label>${label}</label><input type="${type}" name="${name}" value="${v}" ${type === 'number' ? 'min="0"' : ''} /></div>`;
}
function wireModal(onSubmit, onDelete) {
  overlay.hidden = false;
  modalForm.onsubmit = e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(modalForm).entries());
    onSubmit(data);
  };
  modalForm.querySelector('[data-cancel]').onclick = closeModal;
  const del = modalForm.querySelector('[data-del]');
  if (del && onDelete) del.onclick = () => { if (confirm('Excluir definitivamente?')) { onDelete(); closeModal(); } };
}

/* ---- Lançamento financeiro ---- */
function openFinModal(id) {
  const f = id ? db.finance.entries.find(x => x.id === id) : null;
  modalTitle.textContent = f ? 'Editar lançamento' : 'Novo lançamento';
  modalForm.innerHTML = `
    ${field('Descrição', 'desc', 'text', f?.desc || '')}
    <div class="field-row">
      ${field('Tipo', 'type', 'select', f ? (f.type === 'in' ? 'Receita' : 'Gasto') : 'Gasto', ['Receita', 'Gasto'])}
      ${field('Valor (R$) — ex.: 1.234,56', 'amount', 'text', f ? (f.cents / 100).toFixed(2).replace('.', ',') : '')}
    </div>
    <div class="field-row">
      ${field('Categoria', 'cat', 'select', f?.cat || 'Outros', FIN_CATS)}
      ${field('Data', 'date', 'date', f?.date || todayStr())}
    </div>
    <div class="modal-actions">
      ${f ? '<button type="button" class="btn-del" data-del>Excluir</button>' : ''}
      <button type="button" class="btn-ghost" data-cancel>Cancelar</button>
      <button type="submit" class="btn-primary">${f ? 'Salvar' : 'Lançar'}</button>
    </div>`;
  wireModal(data => {
    const cents = parseCents(data.amount);
    if (!data.desc.trim()) { toast('Descreva o lançamento'); return; }
    if (isNaN(cents) || cents <= 0) { toast('Valor inválido — use o formato 1.234,56'); return; }
    const entry = { desc: data.desc.trim(), type: data.type === 'Receita' ? 'in' : 'out', cents, cat: data.cat, date: data.date };
    if (f) Object.assign(f, entry);
    else db.finance.entries.push({ id: uid(), ...entry });
    save(); toast(f ? 'Lançamento atualizado' : 'Lançamento registrado'); closeModal(); refreshAll();
  }, f && (() => { db.finance.entries = db.finance.entries.filter(x => x.id !== id); save(); toast('Lançamento excluído'); refreshAll(); }));
}

/* ---- Reserva ---- */
function openReserveModal() {
  modalTitle.textContent = 'Reserva financeira';
  modalForm.innerHTML = `
    ${field('Valor da reserva (R$)', 'reserve', 'text', (db.finance.reserveCents / 100).toFixed(2).replace('.', ','))}
    <p class="muted">A reserva é o seu ponto de partida. O patrimônio total = reserva + (receitas − gastos) registrados.</p>
    <div class="modal-actions">
      <button type="button" class="btn-ghost" data-cancel>Cancelar</button>
      <button type="submit" class="btn-primary">Salvar</button>
    </div>`;
  wireModal(data => {
    const cents = parseCents(data.reserve);
    if (isNaN(cents) || cents < 0) { toast('Valor inválido'); return; }
    db.finance.reserveCents = cents;
    save(); toast('Reserva atualizada'); closeModal(); refreshAll();
  });
}

/* ---- Protocolo ---- */
function openProtoModal(id) {
  const p = id ? db.protocols.find(x => x.id === id) : null;
  modalTitle.textContent = p ? 'Editar protocolo' : 'Novo protocolo';
  const items = p ? p.items.map(i => i.text) : [''];
  modalForm.innerHTML = `
    ${field('Nome do protocolo', 'name', 'text', p?.name || '')}
    ${field('Descrição (opcional)', 'desc', 'text', p?.desc || '')}
    <div class="field">
      <label>Itens do checklist</label>
      <div class="items-editor" id="itemsEditor">
        ${items.map(t => itemRow(t)).join('')}
      </div>
      <button type="button" class="btn-soft" id="addItemBtn" style="margin-top:7px">+ Adicionar item</button>
    </div>
    <div class="modal-actions">
      ${p ? '<button type="button" class="btn-del" data-del>Excluir</button>' : ''}
      <button type="button" class="btn-ghost" data-cancel>Cancelar</button>
      <button type="submit" class="btn-primary">${p ? 'Salvar' : 'Criar'}</button>
    </div>`;

  const editor = modalForm.querySelector('#itemsEditor');
  modalForm.querySelector('#addItemBtn').onclick = () => {
    editor.insertAdjacentHTML('beforeend', itemRow(''));
    wireItemRows(editor);
    editor.lastElementChild.querySelector('input').focus();
  };
  wireItemRows(editor);

  wireModal(data => {
    if (!data.name.trim()) { toast('Dê um nome ao protocolo'); return; }
    const texts = [...editor.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
    if (!texts.length) { toast('Adicione pelo menos um item'); return; }
    const newItems = texts.map(text => {
      const existing = p?.items.find(i => i.text === text);
      return { id: existing?.id || uid(), text, done: existing?.done || false };
    });
    if (p) Object.assign(p, { name: data.name.trim(), desc: data.desc.trim(), items: newItems });
    else db.protocols.push({ id: uid(), name: data.name.trim(), desc: data.desc.trim(), daily: true, lastReset: todayStr(), items: newItems });
    save(); toast(p ? 'Protocolo atualizado' : 'Protocolo criado'); closeModal(); refreshAll();
  }, p && (() => { db.protocols = db.protocols.filter(x => x.id !== id); save(); toast('Protocolo excluído'); refreshAll(); }));
}
function itemRow(text) {
  return `<div class="item-row">
    <input type="text" value="${esc(text)}" placeholder="Item do checklist" />
    <button type="button" class="btn-icon item-del">✕</button>
  </div>`;
}
function wireItemRows(editor) {
  editor.querySelectorAll('.item-del').forEach(b => b.onclick = () => b.closest('.item-row').remove());
}

/* ===========================================================
   EXPORTAR / IMPORTAR (backup completo)
   =========================================================== */
document.getElementById('exportBtn').onclick = () => {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `planner-${todayStr()}.json`;
  a.click();
  toast('Backup exportado');
};
document.getElementById('importBtn').onclick = () => document.getElementById('importFile').click();
document.getElementById('importFile').onchange = e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data.finance || !data.protocols) throw new Error();
      db = data; migrate(); save(); toast('Dados importados'); refreshAll();
    } catch { toast('Arquivo inválido'); }
  };
  reader.readAsText(file);
  e.target.value = '';
};

/* ===========================================================
   TOAST
   =========================================================== */
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.hidden = true, 2400);
}

/* ===========================================================
   BOOT
   =========================================================== */
(function init() {
  if (localStorage.getItem('planner_theme') === 'light') document.documentElement.dataset.theme = 'light';
  const tBtn = document.getElementById('themeToggle');
  const setThemeLabel = () => tBtn.textContent = document.documentElement.dataset.theme === 'light' ? '🌙 Modo escuro' : '☀ Modo claro';
  setThemeLabel();
  tBtn.onclick = () => {
    if (document.documentElement.dataset.theme === 'light') {
      delete document.documentElement.dataset.theme; localStorage.setItem('planner_theme', 'dark');
    } else {
      document.documentElement.dataset.theme = 'light'; localStorage.setItem('planner_theme', 'light');
    }
    setThemeLabel();
  };

  const now = new Date();
  document.getElementById('todayChip').textContent =
    `${now.getDate()} de ${MONTHS[now.getMonth()]} de ${now.getFullYear()}`;
  renderHoje();

  // GCal: inicializa client se houver Client ID salvo
  // GIS script é async — tenta imediatamente e também quando o script carregar
  initGcalClient();
  const gsiScript = document.querySelector('script[src*="accounts.google.com"]');
  if (gsiScript) gsiScript.addEventListener('load', () => initGcalClient());

  // sync: puxa do brain repo ao abrir e ao voltar para a aba
  cloudPull();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ghToken() && !pushing) cloudPull();
  });
})();
