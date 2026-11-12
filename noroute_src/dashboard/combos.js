/* ---------------- combos page ---------------- */

let combos = [];
let comboDraft = { id: '', name: '', models: [] };
let comboCatalog = [];

function renderCombos() {
  const list = $('comboList');
  if (!list) return;

  $('comboCount').textContent = `${combos.length} total`;
  list.innerHTML = combos.length
    ? combos.map((combo) => `<div class="combo-row" data-combo-row="${escapeHtml(combo.id)}">
        <div class="combo-main">
          <strong>${escapeHtml(combo.name)}</strong>
          <code class="combo-name">${escapeHtml(combo.name)}</code>
          <ol class="combo-models">${combo.models.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ol>
        </div>
        <div class="combo-actions">
          <button class="btn btn-ghost btn-xs" type="button" data-combo-edit="${escapeHtml(combo.id)}">Edit</button>
          <button class="btn btn-ghost btn-xs danger" type="button" data-combo-delete="${escapeHtml(combo.id)}">Delete</button>
        </div>
      </div>`).join('')
    : `<div class="list-empty">
        <strong>No combos yet</strong>
        <span>Create one to give clients a single model name that falls back through several providers.</span>
      </div>`;
  staggerChildren(list, '.combo-row', `combos:${combos.map((combo) => combo.id).join('|')}`);
}

async function loadCombos() {
  if (!document.querySelector('[data-page="/combos"]')) return;
  try {
    const res = await fetch('/api/combos', { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || 'Could not load combos.');
    combos = body.combos || [];
    renderCombos();
  } catch (err) {
    detailNote($('comboNote'), err.message, 'bad');
  }
}

// The picker offers exactly the enabled catalog. It reads the admin endpoint,
// not /v1/models, because /v1 is behind REQUIRE_API_KEY while the dashboard is
// not — fetching /v1 from here returned 401 and left the list empty.
function paintComboModelOptions() {
  const select = $('comboModelEntry');
  if (!select) return;
  const available = comboCatalog.filter((id) => !comboDraft.models.includes(id));
  if (!available.length) {
    select.innerHTML = `<option value="">${comboCatalog.length ? 'All enabled models already added' : 'No enabled models available'}</option>`;
    select.disabled = true;
    syncCustomSelects();
    return;
  }
  select.disabled = false;
  select.innerHTML = available.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('');
  syncCustomSelects();
}

async function loadComboCatalog() {
  try {
    const res = await fetch('/api/combos', { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    comboCatalog = (body.catalog || []).map((entry) => entry.id);
    if (!res.ok) throw new Error(body.error?.message || `catalog ${res.status}`);
  } catch {
    comboCatalog = [];
  }
  paintComboModelOptions();
}

function paintComboChain() {
  const chain = $('comboChain');
  if (!chain) return;
  chain.innerHTML = comboDraft.models.length
    ? comboDraft.models.map((model, index) => `<li class="combo-chain-item" data-chain-index="${index}">
        <span class="combo-chain-pos">${index + 1}</span>
        <code>${escapeHtml(model)}</code>
        <span class="combo-chain-actions">
          <button class="iconbtn" type="button" data-combo-move="up" data-index="${index}" aria-label="Move ${escapeHtml(model)} up" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button class="iconbtn" type="button" data-combo-move="down" data-index="${index}" aria-label="Move ${escapeHtml(model)} down" ${index === comboDraft.models.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="iconbtn" type="button" data-combo-remove="${index}" aria-label="Remove ${escapeHtml(model)}">×</button>
        </span>
      </li>`).join('')
    : '<li class="combo-chain-empty">No models yet. Add at least one to save.</li>';
  const note = $('comboChainNote');
  if (note) note.textContent = comboDraft.models.length ? `${comboDraft.models.length} in fallback order` : '';
}

function openComboModal(combo = null) {
  comboDraft = combo
    ? { id: combo.id, name: combo.name, models: [...combo.models] }
    : { id: '', name: '', models: [] };
  $('comboDialogTitle').textContent = combo ? 'Edit combo' : 'Create combo';
  const form = $('comboForm');
  if (form) {
    form.reset();
    form.elements.name.value = comboDraft.name;
  }
  detailNote($('comboFormNote'), '', '');
  paintComboChain();
  loadComboCatalog();
  $('comboModal').hidden = false;
  form?.elements.name.focus();
}

function closeComboModal() {
  const modal = $('comboModal');
  if (modal) modal.hidden = true;
  comboDraft = { id: '', name: '', models: [] };
}

function addComboModel(value) {
  const model = String(value || '').trim();
  if (!model) return;
  if (comboDraft.models.includes(model)) {
    detailNote($('comboFormNote'), `${model} is already in the chain.`, 'bad');
    return;
  }
  comboDraft.models.push(model);
  detailNote($('comboFormNote'), '', '');
  paintComboChain();
  // The picker only lists models that are not in the chain yet.
  paintComboModelOptions();
}

async function saveCombo(event) {
  event.preventDefault();
  const form = $('comboForm');
  const name = form.elements.name.value.trim();
  if (!name) {
    detailNote($('comboFormNote'), 'Combo name is required.', 'bad');
    return;
  }
  if (!comboDraft.models.length) {
    detailNote($('comboFormNote'), 'Add at least one model before saving.', 'bad');
    return;
  }
  const payload = { name, models: comboDraft.models };
  const editing = Boolean(comboDraft.id);
  try {
    const res = await fetch(editing ? `/api/combos/${encodeURIComponent(comboDraft.id)}` : '/api/combos', {
      method: editing ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Save failed (${res.status})`);
    closeComboModal();
    await loadCombos();
    detailNote($('comboNote'), `${body.combo.name} saved.`, 'ok');
  } catch (err) {
    detailNote($('comboFormNote'), err.message, 'bad');
  }
}

$('openCreateCombo')?.addEventListener('click', () => openComboModal());
$('comboForm')?.addEventListener('submit', saveCombo);
document.querySelectorAll('[data-combo-close]').forEach((el) => el.addEventListener('click', closeComboModal));
$('comboAddModel')?.addEventListener('click', () => {
  const select = $('comboModelEntry');
  if (!select || select.disabled) return;
  addComboModel(select.value);
  $('comboAddModel')?.focus();
});
$('comboChain')?.addEventListener('click', (event) => {
  const move = event.target.closest('[data-combo-move]');
  const remove = event.target.closest('[data-combo-remove]');
  if (move) {
    const index = Number(move.dataset.index);
    const target = move.dataset.comboMove === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= comboDraft.models.length) return;
    const [item] = comboDraft.models.splice(index, 1);
    comboDraft.models.splice(target, 0, item);
    paintComboChain();
    // Keep keyboard focus on the same control after the list re-renders.
    $('comboChain')?.querySelector(`[data-combo-move="${move.dataset.comboMove}"][data-index="${target}"]`)?.focus();
    return;
  }
  if (remove) {
    const index = Number(remove.dataset.comboRemove);
    comboDraft.models.splice(index, 1);
    paintComboChain();
    paintComboModelOptions();
    $('comboAddModel')?.focus();
  }
});
$('comboList')?.addEventListener('click', (event) => {
  const edit = event.target.closest('[data-combo-edit]');
  const del = event.target.closest('[data-combo-delete]');
  if (edit) {
    const combo = combos.find((item) => item.id === edit.dataset.comboEdit);
    if (combo) openComboModal(combo);
    return;
  }
  if (del) {
    const combo = combos.find((item) => item.id === del.dataset.comboDelete);
    if (!combo) return;
    openConfirmation({
      title: 'Delete combo?',
      message: `"${combo.name}" will stop resolving for clients immediately. Models it lists are not affected.`,
      confirmLabel: 'Delete combo',
      danger: true,
      run: async () => {
        const res = await fetch(`/api/combos/${encodeURIComponent(combo.id)}`, { method: 'DELETE' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          detailNote($('comboNote'), body.error?.message || `Delete failed (${res.status})`, 'bad');
          return;
        }
        await loadCombos();
        detailNote($('comboNote'), `${combo.name} deleted.`, 'ok');
      },
    }, del);
  }
});

