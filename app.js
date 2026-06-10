/* ===========================================================
   Planner pessoal · Pedro
   Tudo client-side, persistido em localStorage.
   Valores financeiros armazenados em CENTAVOS (inteiros) —
   nunca em float — para precisão absoluta.
   =========================================================== */

const STORE_KEY = 'planner_v2';
const LEGACY_KEY = 'planner_v1';
const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const LEARN_TYPES = [
  { key: 'aprendi',   label: 'Aprendi',   ico: '◎', hint: 'Conhecimento novo que entrou no repertório' },
  { key: 'aprimorei', label: 'Aprimorei', ico: '◈', hint: 'Habilidade existente que ficou mais afiada' },
  { key: 'criei',     label: 'Criei',     ico: '✦', hint: 'Algo que saiu das suas mãos: projeto, automação, solução' },
];
const FIN_CATS = ['Salário', 'Extra', 'Moradia', 'Alimentação', 'Transporte', 'Saúde', 'Estudos', 'Lazer', 'Assinaturas', 'Outros'];
const DEFAULT_PROTOCOLS = [
  { name: 'Protocolo 1 · Acordar às 06:00', desc: 'Todos os dias, sem exceção.', items: ['Acordei às 06:00'] },
  { name: 'Protocolo 2 · Vitamina D', desc: 'Tomar vitamina D todos os dias.', items: ['Tomei a vitamina D'] },
  { name: 'Protocolo 3 · Hidratação', desc: 'Garrafa ou copo de água sempre por perto.', items: ['Água ao acordar', 'Água antes de dormir'] },
  { name: 'Protocolo 4 · Disciplina', desc: 'Cumprir o primeiro protocolo.', items: ['Protocolo 1 cumprido'] },
];

/* ---------- moeda: centavos <-> texto ---------- */
const BRLfmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
function brl(cents) { return BRLfmt.format(cents / 100); }
function parseCents(str) {
  // aceita "1.234,56", "1234,56", "1234.56", "1234"
  if (typeof str === 'number') return Math.round(str * 100);
  let s = String(str || '').trim().replace(/[R$\s]/g, '');
  if (!s) return NaN;
  const neg = /^-/.test(s); s = s.replace(/^-/, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const v = parseFloat(s);
  if (isNaN(v)) return NaN;
  return (neg ? -1 : 1) * Math.round(v * 100);
}

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
    learn: [],
    finance: { reserveCents: 400000, entries: [] }, // R$ 4.000,00 de reserva
    protocols: [],
  };
}
function migrate() {
  // v1 -> v2: aproveita lançamentos financeiros antigos (eram float em `amount`)
  try {
    const old = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
    if (old && !db._migratedV1) {
      (old.finance || []).forEach(f => {
        db.finance.entries.push({
          id: f.id || uid(), type: f.type, desc: f.desc, cat: f.cat || 'Outros',
          cents: Math.round((+f.amount || 0) * 100), date: f.date,
        });
      });
      db._migratedV1 = true;
    }
  } catch (e) {}
  // garante os protocolos padrão (sem duplicar)
  DEFAULT_PROTOCOLS.forEach(dp => {
    if (!db.protocols.some(p => p.name === dp.name)) {
      db.protocols.push({
        id: uid(), name: dp.name, desc: dp.desc, daily: true, lastReset: todayStr(),
        items: dp.items.map(t => ({ id: uid(), text: t, done: false })),
      });
    }
  });
  // reset diário dos protocolos
  const today = todayStr();
  db.protocols.forEach(p => {
    if (p.daily && p.lastReset !== today) {
      p.items.forEach(i => i.done = false);
      p.lastReset = today;
    }
  });
}
function save() { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function todayStr() { return localISO(new Date()); }
function localISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

/* ===========================================================
   NAVEGAÇÃO
   =========================================================== */
const TITLES = {
  hoje:       ['Hoje', 'Protocolos, agenda e evolução do dia'],
  trabalho:   ['Trabalho', 'Registro semanal do que você aprendeu, aprimorou e criou'],
  financeiro: ['Financeiro', 'Reserva, receitas e gastos com precisão de centavos'],
  protocolos: ['Protocolos', 'Rotinas diárias inegociáveis'],
};

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});
function switchView(v) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
  document.getElementById('viewTitle').textContent = TITLES[v][0];
  document.getElementById('viewSub').textContent = TITLES[v][1];
  if (v === 'hoje') renderHoje();
  if (v === 'trabalho') renderLearn();
  if (v === 'financeiro') renderFin();
  if (v === 'protocolos') renderProtos();
}
function refreshAll() {
  const active = document.querySelector('.view.active').id.replace('view-', '');
  switchView(active);
}
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => switchView(b.dataset.go));

/* ===========================================================
   SEMANAS (domingo a sábado)
   =========================================================== */
function weekStart(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x;
}
function weekRange(d) {
  const start = weekStart(d);
  const end = new Date(start); end.setDate(start.getDate() + 6);
  return [localISO(start), localISO(end)];
}
function entriesOfWeek(d) {
  const [a, b] = weekRange(d);
  return db.learn.filter(e => e.date >= a && e.date <= b);
}

/* ===========================================================
   HOJE
   =========================================================== */
function renderHoje() {
  const wk = entriesOfWeek(new Date());
  const fin = monthEntries(new Date());
  const exp = fin.filter(f => f.type === 'out').reduce((a, f) => a + f.cents, 0);
  const totalCents = db.finance.reserveCents + db.finance.entries.reduce((a, f) => a + (f.type === 'in' ? f.cents : -f.cents), 0);
  const allItems = db.protocols.flatMap(p => p.items);
  const doneItems = allItems.filter(i => i.done).length;

  document.getElementById('hojeKpis').innerHTML = `
    ${kpi('blue', wk.length, 'Registros técnicos na semana')}
    ${kpi(doneItems === allItems.length && allItems.length ? 'green' : 'amber', `${doneItems}/${allItems.length}`, 'Protocolos de hoje')}
    ${kpi(totalCents >= 0 ? 'green' : 'red', brl(totalCents), 'Patrimônio (reserva + fluxo)')}
    ${kpi('red', brl(exp), 'Gastos no mês')}
  `;

  // protocolos interativos direto no dashboard
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

  // aprendizados da semana
  const recent = [...wk].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  document.getElementById('hojeAprendizados').innerHTML = recent.length ? recent.map(e => {
    const t = LEARN_TYPES.find(t => t.key === e.type);
    return `<li><span class="lt-badge ${e.type}">${t.ico} ${t.label}</span><span style="flex:1">${esc(e.title)}</span></li>`;
  }).join('') : '<li class="empty">Nada registrado esta semana ainda.</li>';
}
function kpi(cls, val, label) {
  return `<div class="kpi ${cls}"><div class="kpi-val">${val}</div><div class="kpi-label">${label}</div></div>`;
}

/* ===========================================================
   TRABALHO — registro semanal de evolução técnica
   =========================================================== */
function renderLearn() {
  const [a, b] = weekRange(weekRef);
  const da = new Date(a + 'T00:00'), dbb = new Date(b + 'T00:00');
  document.getElementById('weekLabel').textContent =
    `${da.getDate()} ${MONTHS[da.getMonth()].slice(0,3)} – ${dbb.getDate()} ${MONTHS[dbb.getMonth()].slice(0,3)} ${dbb.getFullYear()}`;

  const wk = entriesOfWeek(weekRef);
  document.getElementById('learnLists').innerHTML = LEARN_TYPES.map(t => {
    const items = wk.filter(e => e.type === t.key).sort((x, y) => y.date.localeCompare(x.date));
    return `<div class="learn-col">
      <div class="learn-col-head"><span class="lt-badge ${t.key}">${t.ico} ${t.label}</span><span class="count">${items.length}</span></div>
      <p class="learn-hint">${t.hint}</p>
      <ul class="learn-list">
        ${items.map(e => `<li data-id="${e.id}">
          <div class="ll-main">
            <strong>${esc(e.title)}</strong>
            ${e.desc ? `<p>${esc(e.desc)}</p>` : ''}
            ${(e.skills || []).length ? `<div class="ll-skills">${e.skills.map(s => `<span class="skill-tag">${esc(s)}</span>`).join('')}</div>` : ''}
          </div>
          <div class="ll-side">
            <span class="muted">${e.date.slice(8,10)}/${e.date.slice(5,7)}</span>
            <button class="tc-mini ll-edit">Editar</button>
          </div>
        </li>`).join('') || '<li class="empty">Sem registros nesta semana.</li>'}
      </ul>
      <button class="btn-soft learn-add" data-type="${t.key}">+ ${t.label.toLowerCase()} algo</button>
    </div>`;
  }).join('');

  document.querySelectorAll('.learn-add').forEach(b => b.onclick = () => openLearnModal(null, b.dataset.type));
  document.querySelectorAll('.ll-edit').forEach(b => b.onclick = () => openLearnModal(b.closest('li').dataset.id));

  renderSkillBars();
}
function renderSkillBars() {
  const counts = {};
  db.learn.forEach(e => (e.skills || []).forEach(s => {
    const k = s.trim(); if (k) counts[k] = (counts[k] || 0) + 1;
  }));
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 14);
  const max = sorted[0]?.[1] || 1;
  document.getElementById('skillBars').innerHTML = sorted.length ? sorted.map(([skill, n]) => `
    <div class="sb-row">
      <span class="sb-label">${esc(skill)}</span>
      <div class="sb-track"><div class="sb-fill" style="width:${Math.round(n / max * 100)}%"></div></div>
      <span class="sb-num">${n}</span>
    </div>`).join('') : '<div class="empty">Adicione tags de tecnologia nos registros para ver sua evolução aqui.</div>';
}
document.getElementById('weekPrev').onclick = () => { weekRef.setDate(weekRef.getDate() - 7); renderLearn(); };
document.getElementById('weekNext').onclick = () => { weekRef.setDate(weekRef.getDate() + 7); renderLearn(); };
document.getElementById('weekToday').onclick = () => { weekRef = new Date(); renderLearn(); };
document.getElementById('addLearnBtn').onclick = () => openLearnModal();

/* ===========================================================
   FINANCEIRO
   =========================================================== */
function monthEntries(date) {
  const prefix = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  return db.finance.entries.filter(f => (f.date || '').startsWith(prefix));
}
function renderFin() {
  const y = finDate.getFullYear(), m = finDate.getMonth();
  document.getElementById('finMonthLabel').textContent = `${MONTHS[m]} ${y}`;
  document.getElementById('catMonthLabel').textContent = `${MONTHS[m]} ${y}`;
  const entries = monthEntries(finDate).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const inc = entries.filter(f => f.type === 'in').reduce((a, f) => a + f.cents, 0);
  const exp = entries.filter(f => f.type === 'out').reduce((a, f) => a + f.cents, 0);
  const totalCents = db.finance.reserveCents + db.finance.entries.reduce((a, f) => a + (f.type === 'in' ? f.cents : -f.cents), 0);

  document.getElementById('finKpis').innerHTML = `
    ${kpi(totalCents >= 0 ? 'green' : 'red', brl(totalCents), 'Patrimônio total')}
    ${kpi('', brl(db.finance.reserveCents), 'Reserva')}
    ${kpi('green', brl(inc), 'Receitas no mês')}
    ${kpi('red', brl(exp), 'Gastos no mês')}
    ${kpi(inc - exp >= 0 ? 'blue' : 'red', brl(inc - exp), 'Resultado do mês')}
  `;

  document.getElementById('finList').innerHTML = entries.length ? entries.map(f => `
    <li data-id="${f.id}">
      <span class="fin-ico ${f.type}">${f.type === 'in' ? '↑' : '↓'}</span>
      <span class="fin-desc">${esc(f.desc)}<small>${esc(f.cat || '')} · ${f.date.slice(8,10)}/${f.date.slice(5,7)}</small></span>
      <span class="fin-val ${f.type}">${f.type === 'in' ? '+' : '−'} ${brl(f.cents)}</span>
      <button class="tc-mini fin-edit">Editar</button>
      <button class="tc-mini fin-del">✕</button>
    </li>`).join('') : '<li class="empty">Nenhum lançamento neste mês.</li>';

  // gastos por categoria
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
    // dedup: ignora transações idênticas já importadas
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
  // CSV do BB: colunas com data dd/mm/yyyy e valor; tolerante a variações
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
    if (/saldo/i.test(desc)) return; // linhas de saldo não são transações
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
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
function closeModal() { overlay.hidden = true; modalForm.innerHTML = ''; }

function field(label, name, type = 'text', value = '', opts = null) {
  const v = esc(value ?? '');
  if (type === 'textarea') return `<div class="field"><label>${label}</label><textarea name="${name}">${v}</textarea></div>`;
  if (type === 'select') {
    const options = opts.map(o => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('');
    return `<div class="field"><label>${label}</label><select name="${name}">${options}</select></div>`;
  }
  return `<div class="field"><label>${label}</label><input type="${type}" name="${name}" value="${v}" /></div>`;
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

/* ---- Registro de evolução (Trabalho) ---- */
function openLearnModal(id, presetType) {
  const e = id ? db.learn.find(x => x.id === id) : null;
  modalTitle.textContent = e ? 'Editar registro' : 'Novo registro técnico';
  const typeLabel = k => LEARN_TYPES.find(t => t.key === k)?.label;
  modalForm.innerHTML = `
    ${field('Tipo', 'type', 'select', typeLabel(e?.type || presetType || 'aprendi'), LEARN_TYPES.map(t => t.label))}
    ${field('O quê', 'title', 'text', e?.title || '')}
    ${field('Detalhes (opcional)', 'desc', 'textarea', e?.desc || '')}
    ${field('Tecnologias/habilidades (separe por vírgula)', 'skills', 'text', (e?.skills || []).join(', '))}
    ${field('Data', 'date', 'date', e?.date || todayStr())}
    <div class="modal-actions">
      ${e ? '<button type="button" class="btn-del" data-del>Excluir</button>' : ''}
      <button type="button" class="btn-ghost" data-cancel>Cancelar</button>
      <button type="submit" class="btn-primary">${e ? 'Salvar' : 'Registrar'}</button>
    </div>`;
  wireModal(data => {
    if (!data.title.trim()) { toast('Descreva o que você aprendeu/aprimorou/criou'); return; }
    const entry = {
      type: LEARN_TYPES.find(t => t.label === data.type)?.key || 'aprendi',
      title: data.title.trim(), desc: data.desc.trim(),
      skills: data.skills.split(',').map(s => s.trim()).filter(Boolean),
      date: data.date || todayStr(),
    };
    if (e) Object.assign(e, entry);
    else db.learn.push({ id: uid(), ...entry });
    save(); toast(e ? 'Registro atualizado' : 'Evolução registrada'); closeModal(); refreshAll();
  }, e && (() => { db.learn = db.learn.filter(x => x.id !== id); save(); toast('Registro excluído'); refreshAll(); }));
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
      db = data; save(); toast('Dados importados'); refreshAll();
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
  document.getElementById('viewSub').textContent = TITLES.hoje[1];
  renderHoje();
})();
