/* ===========================================================
   Planner pessoal · Pedro
   Tudo client-side, persistido em localStorage.
   =========================================================== */

const STORE_KEY = 'planner_v1';
const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const STATUSES = [
  { key: 'todo',  label: 'A fazer' },
  { key: 'doing', label: 'Fazendo' },
  { key: 'done',  label: 'Feito' },
];
const PRIOS = ['alta', 'media', 'baixa'];
const FIN_CATS = ['Salário', 'Extra', 'Moradia', 'Alimentação', 'Transporte', 'Saúde', 'Estudos', 'Lazer', 'Assinaturas', 'Outros'];

/* ---------- estado ---------- */
let db = load();
let finDate = new Date();
save();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {
    work: [],
    studies: { goalMin: 300, sessions: [] },
    finance: [],
    protocols: [],
  };
}
function save() { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function brl(v) { return (v < 0 ? '-' : '') + 'R$ ' + Math.abs(v).toFixed(2).replace('.', ','); }
function fmtMin(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h${m ? String(m).padStart(2, '0') : ''}` : `${m}min`;
}

/* ===========================================================
   NAVEGAÇÃO
   =========================================================== */
const TITLES = {
  hoje:       ['Hoje', 'Resumo do dia em todas as áreas'],
  trabalho:   ['Trabalho', 'Tarefas e acompanhamento do que está em andamento'],
  estudos:    ['Estudos', 'Sessões de estudo e progresso da meta semanal'],
  financeiro: ['Financeiro', 'Receitas, gastos e saldo do mês'],
  protocolos: ['Protocolos', 'Checklists reutilizáveis para rotinas'],
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
  if (v === 'trabalho') renderWork();
  if (v === 'estudos') renderStudies();
  if (v === 'financeiro') renderFin();
  if (v === 'protocolos') renderProtos();
}
function refreshAll() {
  const active = document.querySelector('.view.active').id.replace('view-', '');
  switchView(active);
}

/* ===========================================================
   HOJE (dashboard)
   =========================================================== */
function weekStartStr() {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay()); // domingo
  return d.toISOString().slice(0, 10);
}
function weekSessions() {
  const ws = weekStartStr();
  return db.studies.sessions.filter(s => s.date >= ws);
}
function monthFinance(date) {
  const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0');
  const prefix = `${y}-${m}`;
  return db.finance.filter(f => (f.date || '').startsWith(prefix));
}

function renderHoje() {
  const pend = db.work.filter(t => t.status !== 'done');
  const doing = db.work.filter(t => t.status === 'doing');
  const wkMin = weekSessions().reduce((a, s) => a + (+s.minutes || 0), 0);
  const fin = monthFinance(new Date());
  const inc = fin.filter(f => f.type === 'in').reduce((a, f) => a + (+f.amount || 0), 0);
  const exp = fin.filter(f => f.type === 'out').reduce((a, f) => a + (+f.amount || 0), 0);

  document.getElementById('hojeKpis').innerHTML = `
    ${kpi('', pend.length, 'Tarefas pendentes')}
    ${kpi('amber', doing.length, 'Em andamento')}
    ${kpi('blue', fmtMin(wkMin), 'Estudo na semana')}
    ${kpi(inc - exp >= 0 ? 'green' : 'red', brl(inc - exp), 'Saldo do mês')}
  `;

  // tarefas pendentes (mais urgentes primeiro)
  const prioOrder = { alta: 0, media: 1, baixa: 2 };
  const tasks = [...pend]
    .sort((a, b) => (prioOrder[a.prio] ?? 3) - (prioOrder[b.prio] ?? 3) || (a.date || '9999').localeCompare(b.date || '9999'))
    .slice(0, 5);
  document.getElementById('hojeTarefas').innerHTML = tasks.length ? tasks.map(t =>
    `<li><span style="flex:1">${esc(t.title)}</span>${t.prio ? `<span class="tc-prio ${t.prio}">${t.prio}</span>` : ''}</li>`
  ).join('') : `<li class="empty">Nenhuma tarefa pendente 🎉</li>`;

  // estudo da semana
  const goal = db.studies.goalMin || 1;
  const pct = Math.min(100, Math.round((wkMin / goal) * 100));
  document.getElementById('hojeStudyFill').style.width = pct + '%';
  document.getElementById('hojeStudyLabel').textContent = `${fmtMin(wkMin)} de ${fmtMin(goal)} (${pct}%)`;
  const recent = [...weekSessions()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
  document.getElementById('hojeEstudos').innerHTML = recent.length ? recent.map(s =>
    `<li><span style="flex:1">${esc(s.subject)}</span><span class="badge-num">${fmtMin(+s.minutes || 0)}</span></li>`
  ).join('') : `<li class="empty">Nenhuma sessão esta semana.</li>`;

  // financeiro
  document.getElementById('hojeFin').innerHTML = `
    <div class="row"><span class="muted">Receitas</span><span class="pos">+ ${brl(inc)}</span></div>
    <div class="row"><span class="muted">Gastos</span><span class="neg">− ${brl(exp)}</span></div>
    <div class="row"><span>Saldo</span><span class="saldo ${inc - exp >= 0 ? 'pos' : 'neg'}">${brl(inc - exp)}</span></div>
  `;

  // protocolos
  document.getElementById('hojeProtocolos').innerHTML = db.protocols.length ? db.protocols.slice(0, 4).map(p => {
    const done = p.items.filter(i => i.done).length;
    return `<li><span style="flex:1">${esc(p.name)}</span><span class="badge-num">${done}/${p.items.length}</span></li>`;
  }).join('') : `<li class="empty">Nenhum protocolo criado.</li>`;
}
function kpi(cls, val, label) {
  return `<div class="kpi ${cls}"><div class="kpi-val">${val}</div><div class="kpi-label">${label}</div></div>`;
}
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => switchView(b.dataset.go));

/* ===========================================================
   TRABALHO — kanban
   =========================================================== */
function renderWork() {
  const search = (document.getElementById('workSearch').value || '').toLowerCase();
  const board = document.getElementById('workBoard');

  board.innerHTML = STATUSES.map(s => {
    const items = db.work.filter(t =>
      t.status === s.key &&
      (!search || t.title.toLowerCase().includes(search) || (t.desc || '').toLowerCase().includes(search))
    ).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));

    return `<div class="column" data-status="${s.key}">
      <div class="column-head"><span class="dot ${s.key}"></span> ${s.label} <span class="count">${items.length}</span></div>
      ${items.map(taskCard).join('') || '<div class="empty">Sem tarefas</div>'}
    </div>`;
  }).join('');

  setupDragDrop();
  board.querySelectorAll('.task-card').forEach(card => {
    card.querySelector('.tc-edit').onclick = e => { e.stopPropagation(); openWorkModal(card.dataset.id); };
    card.querySelector('.tc-del').onclick = e => {
      e.stopPropagation();
      if (confirm('Excluir esta tarefa?')) {
        db.work = db.work.filter(x => x.id !== card.dataset.id);
        save(); toast('Tarefa excluída'); renderWork();
      }
    };
  });
}
function taskCard(t) {
  const dt = t.date ? new Date(t.date + 'T00:00') : null;
  const dateStr = dt ? `${dt.getDate()}/${dt.getMonth() + 1}` : '';
  return `<div class="task-card" draggable="true" data-id="${t.id}">
    <h4>${esc(t.title)}</h4>
    ${t.desc ? `<p>${esc(t.desc)}</p>` : ''}
    <div class="tc-foot">
      ${t.prio ? `<span class="tc-prio ${t.prio}">${t.prio}</span>` : ''}
      ${dateStr ? `<span class="tc-date">${dateStr}</span>` : ''}
      <span class="tc-actions">
        <button class="tc-mini tc-edit">Editar</button>
        <button class="tc-mini tc-del">Excluir</button>
      </span>
    </div>
  </div>`;
}
function setupDragDrop() {
  let dragId = null;
  document.querySelectorAll('.task-card').forEach(card => {
    card.addEventListener('dragstart', () => { dragId = card.dataset.id; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  document.querySelectorAll('.column').forEach(col => {
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', e => {
      e.preventDefault(); col.classList.remove('drag-over');
      const t = db.work.find(x => x.id === dragId);
      if (t && t.status !== col.dataset.status) {
        t.status = col.dataset.status; save(); renderWork();
      }
    });
  });
}
document.getElementById('workSearch').oninput = renderWork;
document.getElementById('addWorkBtn').onclick = () => openWorkModal();

/* ===========================================================
   ESTUDOS
   =========================================================== */
function renderStudies() {
  const wk = weekSessions();
  const wkMin = wk.reduce((a, s) => a + (+s.minutes || 0), 0);
  const goal = db.studies.goalMin || 1;
  const pct = Math.min(100, Math.round((wkMin / goal) * 100));
  document.getElementById('studyFill').style.width = pct + '%';
  document.getElementById('studyLabel').textContent = `${fmtMin(wkMin)} de ${fmtMin(goal)} (${pct}%)`;

  // por matéria (na semana)
  const bySub = {};
  wk.forEach(s => { bySub[s.subject] = (bySub[s.subject] || 0) + (+s.minutes || 0); });
  document.getElementById('studyBySubject').innerHTML = Object.keys(bySub).length
    ? Object.entries(bySub).sort((a, b) => b[1] - a[1]).map(([sub, min]) =>
        `<span>📖 ${esc(sub)}: <strong>${fmtMin(min)}</strong></span>`).join('')
    : '<span class="muted">Sem sessões esta semana.</span>';

  // histórico
  const sessions = [...db.studies.sessions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 50);
  document.getElementById('sessionList').innerHTML = sessions.length ? sessions.map(s => {
    const dt = new Date(s.date + 'T00:00');
    return `<li data-id="${s.id}">
      <span class="sess-date">${dt.getDate()}/${dt.getMonth() + 1}</span>
      <strong>${esc(s.subject)}</strong>
      <span class="sess-notes">${esc(s.notes || '')}</span>
      <span class="sess-min">${fmtMin(+s.minutes || 0)}</span>
      <button class="tc-mini sess-del">✕</button>
    </li>`;
  }).join('') : `<li class="empty">Nenhuma sessão registrada ainda.</li>`;

  document.querySelectorAll('.sess-del').forEach(b => b.onclick = () => {
    const id = b.closest('li').dataset.id;
    if (confirm('Excluir esta sessão?')) {
      db.studies.sessions = db.studies.sessions.filter(s => s.id !== id);
      save(); toast('Sessão excluída'); renderStudies();
    }
  });
}
document.getElementById('studyQuickForm').onsubmit = e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  if (!data.subject.trim() || !data.minutes) return;
  db.studies.sessions.push({ id: uid(), subject: data.subject.trim(), minutes: +data.minutes, date: data.date, notes: data.notes.trim() });
  save(); toast('Sessão registrada'); e.target.reset();
  e.target.querySelector('[name="date"]').value = todayStr();
  renderStudies();
};
document.getElementById('editGoalBtn').onclick = () => {
  modalTitle.textContent = 'Meta semanal de estudo';
  modalForm.innerHTML = `
    ${field('Meta em minutos por semana (ex.: 300 = 5h)', 'goal', 'number', db.studies.goalMin)}
    <div class="modal-actions">
      <button type="button" class="btn-ghost" data-cancel>Cancelar</button>
      <button type="submit" class="btn-primary">Salvar</button>
    </div>`;
  wireModal(data => {
    db.studies.goalMin = Math.max(1, +data.goal || 300);
    save(); toast('Meta atualizada'); renderStudies();
  });
};

/* ===========================================================
   FINANCEIRO
   =========================================================== */
function renderFin() {
  const y = finDate.getFullYear(), m = finDate.getMonth();
  document.getElementById('finMonthLabel').textContent = `${MONTHS[m]} ${y}`;
  const entries = monthFinance(finDate).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const inc = entries.filter(f => f.type === 'in').reduce((a, f) => a + (+f.amount || 0), 0);
  const exp = entries.filter(f => f.type === 'out').reduce((a, f) => a + (+f.amount || 0), 0);

  document.getElementById('finKpis').innerHTML = `
    ${kpi('green', brl(inc), 'Receitas')}
    ${kpi('red', brl(exp), 'Gastos')}
    ${kpi(inc - exp >= 0 ? 'blue' : 'red', brl(inc - exp), 'Saldo do mês')}
  `;

  document.getElementById('finList').innerHTML = entries.length ? entries.map(f => {
    const dt = new Date(f.date + 'T00:00');
    return `<li data-id="${f.id}">
      <span class="fin-ico ${f.type}">${f.type === 'in' ? '↑' : '↓'}</span>
      <span class="fin-desc">${esc(f.desc)}<small>${esc(f.cat || '')} · ${dt.getDate()}/${dt.getMonth() + 1}</small></span>
      <span class="fin-val ${f.type}">${f.type === 'in' ? '+' : '−'} ${brl(+f.amount || 0)}</span>
      <button class="tc-mini fin-edit">Editar</button>
      <button class="tc-mini fin-del">✕</button>
    </li>`;
  }).join('') : `<li class="empty">Nenhum lançamento neste mês.</li>`;

  document.querySelectorAll('.fin-edit').forEach(b => b.onclick = () => openFinModal(b.closest('li').dataset.id));
  document.querySelectorAll('.fin-del').forEach(b => b.onclick = () => {
    const id = b.closest('li').dataset.id;
    if (confirm('Excluir este lançamento?')) {
      db.finance = db.finance.filter(f => f.id !== id);
      save(); toast('Lançamento excluído'); renderFin();
    }
  });
}
document.getElementById('finPrev').onclick = () => { finDate.setMonth(finDate.getMonth() - 1); renderFin(); };
document.getElementById('finNext').onclick = () => { finDate.setMonth(finDate.getMonth() + 1); renderFin(); };
document.getElementById('addFinBtn').onclick = () => openFinModal();

/* ===========================================================
   PROTOCOLOS
   =========================================================== */
function renderProtos() {
  const grid = document.getElementById('protoGrid');
  grid.innerHTML = db.protocols.length ? db.protocols.map(p => {
    const done = p.items.filter(i => i.done).length;
    return `<div class="proto-card" data-id="${p.id}">
      <h3>${esc(p.name)}</h3>
      ${p.desc ? `<p>${esc(p.desc)}</p>` : ''}
      <ul class="proto-items">
        ${p.items.map(i => `<li class="${i.done ? 'done' : ''}">
          <input type="checkbox" data-item="${i.id}" ${i.done ? 'checked' : ''} />
          <span>${esc(i.text)}</span>
        </li>`).join('')}
      </ul>
      <div class="proto-foot">
        <span class="proto-prog">${done}/${p.items.length} concluídos</span>
        <button class="tc-mini proto-reset">↺ Reiniciar</button>
        <button class="tc-mini proto-edit">Editar</button>
      </div>
    </div>`;
  }).join('') : `<div class="empty">Nenhum protocolo ainda. Crie checklists para rotinas que você repete.</div>`;

  grid.querySelectorAll('input[data-item]').forEach(cb => cb.onchange = () => {
    const p = db.protocols.find(x => x.id === cb.closest('.proto-card').dataset.id);
    const item = p.items.find(i => i.id === cb.dataset.item);
    item.done = cb.checked; save(); renderProtos();
  });
  grid.querySelectorAll('.proto-reset').forEach(b => b.onclick = () => {
    const p = db.protocols.find(x => x.id === b.closest('.proto-card').dataset.id);
    p.items.forEach(i => i.done = false); save(); toast('Protocolo reiniciado'); renderProtos();
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
  return `<div class="field"><label>${label}</label><input type="${type}" name="${name}" value="${v}" ${type === 'number' ? 'min="0" step="any"' : ''} /></div>`;
}
function wireModal(onSubmit, onDelete) {
  overlay.hidden = false;
  modalForm.onsubmit = e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(modalForm).entries());
    onSubmit(data); closeModal();
  };
  modalForm.querySelector('[data-cancel]').onclick = closeModal;
  const del = modalForm.querySelector('[data-del]');
  if (del && onDelete) del.onclick = () => { if (confirm('Excluir definitivamente?')) { onDelete(); closeModal(); } };
}

/* ---- Tarefa de trabalho ---- */
function openWorkModal(id) {
  const t = id ? db.work.find(x => x.id === id) : null;
  modalTitle.textContent = t ? 'Editar tarefa' : 'Nova tarefa';
  modalForm.innerHTML = `
    ${field('Título', 'title', 'text', t?.title || '')}
    ${field('Descrição', 'desc', 'textarea', t?.desc || '')}
    <div class="field-row">
      ${field('Prioridade', 'prio', 'select', t?.prio || 'media', PRIOS)}
      ${field('Prazo', 'date', 'date', t?.date || '')}
    </div>
    ${field('Status', 'status', 'select', t ? STATUSES.find(s => s.key === t.status).label : 'A fazer', STATUSES.map(s => s.label))}
    <div class="modal-actions">
      ${t ? '<button type="button" class="btn-del" data-del>Excluir</button>' : ''}
      <button type="button" class="btn-ghost" data-cancel>Cancelar</button>
      <button type="submit" class="btn-primary">${t ? 'Salvar' : 'Criar'}</button>
    </div>`;
  wireModal(data => {
    if (!data.title.trim()) { toast('Dê um título primeiro'); return; }
    const statusKey = STATUSES.find(s => s.label === data.status)?.key || 'todo';
    if (t) Object.assign(t, { ...data, status: statusKey });
    else db.work.push({ id: uid(), ...data, status: statusKey });
    save(); toast(t ? 'Tarefa atualizada' : 'Tarefa criada'); refreshAll();
  }, t && (() => { db.work = db.work.filter(x => x.id !== id); save(); toast('Tarefa excluída'); refreshAll(); }));
}

/* ---- Lançamento financeiro ---- */
function openFinModal(id) {
  const f = id ? db.finance.find(x => x.id === id) : null;
  modalTitle.textContent = f ? 'Editar lançamento' : 'Novo lançamento';
  modalForm.innerHTML = `
    ${field('Descrição', 'desc', 'text', f?.desc || '')}
    <div class="field-row">
      ${field('Tipo', 'type', 'select', f ? (f.type === 'in' ? 'Receita' : 'Gasto') : 'Gasto', ['Receita', 'Gasto'])}
      ${field('Valor (R$)', 'amount', 'number', f?.amount || '')}
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
    if (!data.desc.trim() || !data.amount) { toast('Preencha descrição e valor'); return; }
    const entry = { desc: data.desc.trim(), type: data.type === 'Receita' ? 'in' : 'out', amount: +data.amount, cat: data.cat, date: data.date };
    if (f) Object.assign(f, entry);
    else db.finance.push({ id: uid(), ...entry });
    save(); toast(f ? 'Lançamento atualizado' : 'Lançamento registrado'); refreshAll();
  }, f && (() => { db.finance = db.finance.filter(x => x.id !== id); save(); toast('Lançamento excluído'); refreshAll(); }));
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
    else db.protocols.push({ id: uid(), name: data.name.trim(), desc: data.desc.trim(), items: newItems });
    save(); toast(p ? 'Protocolo atualizado' : 'Protocolo criado'); refreshAll();
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
   EXPORTAR / IMPORTAR
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
      if (!data.work || !data.studies) throw new Error();
      db = data; save(); toast('Dados importados'); refreshAll();
    } catch { toast('Arquivo inválido'); }
  };
  reader.readAsText(file);
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
  // tema (escuro por padrão)
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
  document.querySelector('#studyQuickForm [name="date"]').value = todayStr();
  document.getElementById('viewSub').textContent = TITLES.hoje[1];
  renderHoje();
})();
