/* ---------------- combos page ---------------- */

let combos = [];
let comboDraft = { id: '', name: '', models: [] };
let comboCatalog = [];

/* ---------------- vision routing ---------------- */

let visionSettings = { enabled: false, strategy: 'order', models: [] };
let visionCatalog = [];
let visionSaving = false;

function paintVisionModelOptions() {
  const select = $('visionModelEntry');
  if (!select) return;
  const available = visionCatalog.filter((id) => !visionSettings.models.includes(id));
  if (!available.length) {
    select.innerHTML = `<option value="">${visionCatalog.length ? 'All enabled models already added' : 'No enabled models available'}</option>`;
    select.disabled = true;
    syncCustomSelects();
    return;
  }
  select.disabled = visionSaving;
  select.innerHTML = available.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('');
  syncCustomSelects();
}

function paintVisionRouting() {
  const toggle = $('visionEnabled');
  if (!toggle) return;
  const { enabled, strategy, models } = visionSettings;
  const missing = models.filter((model) => !visionCatalog.includes(model)).length;
  const usable = models.length - missing;

  toggle.checked = enabled;
  toggle.disabled = visionSaving;

  const state = $('visionStateNote');
  if (state) {
    state.textContent = !enabled
      ? 'Off — requests use the model they asked for.'
      : usable
        ? 'On — every chat request that carries an image is routed through this chain, whatever model or combo the client asked for.'
        : 'On — none of the configured models is available, so requests keep their requested model.';
  }

  // A saved target can disappear when its model is disabled or removed. It stays
  // in the chain so the order survives, but the row says it cannot serve now.
  const count = $('visionCount');
  if (count) {
    count.textContent = missing
      ? `${models.length} model${models.length === 1 ? '' : 's'} · ${missing} unavailable`
      : `${models.length} model${models.length === 1 ? '' : 's'}`;
  }

  document.querySelectorAll('[data-vision-strategy]').forEach((tab) => {
    const active = tab.dataset.visionStrategy === strategy;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-pressed', String(active));
    tab.disabled = visionSaving;
  });

  const chain = $('visionChain');
  if (chain) {
    chain.innerHTML = models.length
      ? models.map((model, index) => {
        const unavailable = !visionCatalog.includes(model);
        return `<li class="combo-chain-item${unavailable ? ' is-missing' : ''}" data-vision-index="${index}">
          <span class="combo-chain-pos">${index + 1}</span>
          <code>${escapeHtml(model)}</code>
          ${unavailable ? '<span class="chip chip-quiet vision-missing">Unavailable</span>' : ''}
          <span class="combo-chain-actions">
            <button class="iconbtn" type="button" data-vision-move="up" data-index="${index}" aria-label="Move ${escapeHtml(model)} up" ${index === 0 || visionSaving ? 'disabled' : ''}>↑</button>
            <button class="iconbtn" type="button" data-vision-move="down" data-index="${index}" aria-label="Move ${escapeHtml(model)} down" ${index === models.length - 1 || visionSaving ? 'disabled' : ''}>↓</button>
            <button class="iconbtn" type="button" data-vision-remove="${index}" aria-label="Remove ${escapeHtml(model)}" ${visionSaving ? 'disabled' : ''}>×</button>
          </span>
        </li>`;
      }).join('')
      : '<li class="combo-chain-empty">No vision models yet. Add one above.</li>';
  }

  const chainNote = $('visionChainNote');
  if (chainNote) {
    // A single target cannot rotate or fall back, so the note stays blank.
    chainNote.textContent = models.length > 1
      ? (strategy === 'round-robin' ? 'Starts at the next model each request' : 'Tries top to bottom')
      : '';
  }

  paintVisionModelOptions();
  const add = $('visionAddModel');
  if (add) add.disabled = visionSaving;
}

async function loadVisionRouting() {
  if (!document.querySelector('[data-page="/combos"]')) return;
  try {
    const res = await fetch('/api/vision-routing', { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || 'Could not load vision routing.');
    visionSettings = body.vision || visionSettings;
    visionCatalog = (body.catalog || []).map((entry) => entry.id);
    visionSaving = false;
    paintVisionRouting();
  } catch (err) {
    detailNote($('visionNote'), err.message, 'bad');
  }
}

// Every control on the card saves immediately; there is no separate Save button.
// The local state changes first so the toggle and chain react without a round
// trip, and a rejected save restores the previous state.
async function saveVisionRouting(patch, okNote) {
  if (visionSaving) return;
  const previous = visionSettings;
  visionSettings = { ...visionSettings, ...patch };
  visionSaving = true;
  paintVisionRouting();
  try {
    const res = await fetch('/api/vision-routing', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Save failed (${res.status})`);
    visionSettings = body.vision || visionSettings;
    if (Array.isArray(body.catalog)) visionCatalog = body.catalog.map((entry) => entry.id);
    detailNote($('visionNote'), okNote, 'ok');
  } catch (err) {
    visionSettings = previous;
    detailNote($('visionNote'), err.message, 'bad');
  } finally {
    visionSaving = false;
    paintVisionRouting();
  }
}

$('visionEnabled')?.addEventListener('change', (event) => {
  const enabled = event.currentTarget.checked;
  if (enabled && !visionSettings.models.length) {
    event.currentTarget.checked = false;
    detailNote($('visionNote'), 'Add at least one vision model before enabling routing.', 'bad');
    return;
  }
  saveVisionRouting({ enabled }, enabled ? 'Vision routing on.' : 'Vision routing off.');
});

document.querySelectorAll('[data-vision-strategy]').forEach((tab) => {
  tab.addEventListener('click', () => {
    const strategy = tab.dataset.visionStrategy;
    if (visionSaving || strategy === visionSettings.strategy) return;
    saveVisionRouting({ strategy }, strategy === 'round-robin' ? 'Round robin enabled.' : 'Order enabled.');
  });
});

$('visionAddModel')?.addEventListener('click', () => {
  const select = $('visionModelEntry');
  const model = String(select?.value || '').trim();
  if (!model || visionSaving || visionSettings.models.includes(model)) return;
  saveVisionRouting({ models: [...visionSettings.models, model] }, `${model} added.`);
});

$('visionChain')?.addEventListener('click', (event) => {
  if (visionSaving) return;
  const move = event.target.closest('[data-vision-move]');
  const remove = event.target.closest('[data-vision-remove]');
  if (move) {
    const index = Number(move.dataset.index);
    const target = move.dataset.visionMove === 'up' ? index - 1 : index + 1;
    const models = [...visionSettings.models];
    if (target < 0 || target >= models.length) return;
    const [item] = models.splice(index, 1);
    models.splice(target, 0, item);
    saveVisionRouting({ models }, 'Order updated.').then(() => {
      // Keep keyboard focus on the same control after the list re-renders. At either
      // end of the list that arrow is disabled, so fall back to the other one on the
      // same row instead of dropping focus to the body.
      const chainAfter = $('visionChain');
      const same = chainAfter?.querySelector(`[data-vision-move="${move.dataset.visionMove}"][data-index="${target}"]`);
      const otherDir = move.dataset.visionMove === 'up' ? 'down' : 'up';
      const other = chainAfter?.querySelector(`[data-vision-move="${otherDir}"][data-index="${target}"]`);
      (same && !same.disabled ? same : other)?.focus();
    });
    return;
  }
  if (remove) {
    const index = Number(remove.dataset.visionRemove);
    const models = visionSettings.models.filter((_, i) => i !== index);
    const patch = { models };
    // The server refuses an enabled rule with no targets, so removing the last
    // model also turns the rule off instead of failing the save.
    if (!models.length && visionSettings.enabled) patch.enabled = false;
    saveVisionRouting(patch, models.length ? 'Model removed.' : 'Vision routing off.');
  }
});

/* ---------------- model aliases and routing rules ---------------- */

let routingSettings = { aliases: {}, rules: [] };
let routingCatalog = [];
let routingCombos = [];
let routingKeys = [];
let routingSaving = false;
let routingDraft = { id: '', name: '', enabled: true, match: {}, models: [] };

function applyRoutingPayload(body) {
  routingSettings = body.routing || routingSettings;
  routingCatalog = (body.catalog || []).map((entry) => entry.id);
  routingCombos = body.combos || [];
  routingKeys = body.keys || [];
}

function routingTargetOptions() {
  return [
    ...routingCatalog.map((id) => ({ value: id, label: id })),
    ...routingCombos.map((name) => ({ value: name, label: `${name} (combo)` })),
  ];
}

function paintRoutingAliasTarget() {
  const select = $('routingAliasTarget');
  if (!select) return;
  const options = routingTargetOptions();
  if (!options.length) {
    select.innerHTML = '<option value="">No models or combos available</option>';
    select.disabled = true;
    syncCustomSelects();
    return;
  }
  select.disabled = routingSaving;
  select.innerHTML = options.map((entry) => `<option value="${escapeHtml(entry.value)}">${escapeHtml(entry.label)}</option>`).join('');
  syncCustomSelects();
}

function routingConditionChips(match = {}) {
  const chips = [];
  if (match.header?.name) chips.push(`header ${match.header.name} contains ${match.header.value}`);
  if (match.apiKeyId) {
    const key = routingKeys.find((entry) => entry.id === match.apiKeyId);
    chips.push(`key ${key ? key.name : 'removed key'}`);
  }
  if (match.minContextTokens) chips.push(`≥ ${compact(match.minContextTokens)} tokens`);
  if (match.hasTools === true) chips.push('has tools');
  if (match.hasTools === false) chips.push('no tools');
  return chips;
}

function paintRouting() {
  if (!$('routingCard')) return;
  const aliases = Object.entries(routingSettings.aliases || {});
  const rules = routingSettings.rules || [];

  const state = $('routingStateNote');
  if (state) {
    const enabledRules = rules.filter((rule) => rule.enabled).length;
    state.textContent = rules.length
      ? `${enabledRules} of ${rules.length} rule${rules.length === 1 ? '' : 's'} enabled. Rules run top to bottom; the first match wins.`
      : 'Aliases rename a target for clients. Rules reroute a request when its headers, key, size, or tools match.';
  }

  const aliasCount = $('routingAliasCount');
  if (aliasCount) aliasCount.textContent = `${aliases.length} alias${aliases.length === 1 ? '' : 'es'}`;
  const aliasList = $('routingAliasList');
  if (aliasList) {
    aliasList.innerHTML = aliases.length
      ? aliases.map(([name, target]) => `<li class="routing-alias-row">
          <code class="routing-alias-name">${escapeHtml(name)}</code>
          <span class="routing-alias-arrow" aria-hidden="true">→</span>
          <code class="routing-alias-target">${escapeHtml(target)}</code>
          <button class="iconbtn" type="button" data-alias-remove="${escapeHtml(name)}" aria-label="Remove alias ${escapeHtml(name)}" ${routingSaving ? 'disabled' : ''}>×</button>
        </li>`).join('')
      : '<li class="routing-empty">No aliases yet. Clients still send the model name they know.</li>';
  }

  const ruleCount = $('routingRuleCount');
  if (ruleCount) ruleCount.textContent = `${rules.length} rule${rules.length === 1 ? '' : 's'}`;
  const ruleList = $('routingRuleList');
  if (ruleList) {
    ruleList.innerHTML = rules.length
      ? rules.map((rule, index) => {
        const chips = routingConditionChips(rule.match);
        const chain = rule.models.map((model) => {
          const unavailable = !routingCatalog.includes(model);
          return `<li class="routing-rule-model${unavailable ? ' is-missing' : ''}"><code>${escapeHtml(model)}</code>${unavailable ? '<span class="routing-missing">Unavailable</span>' : ''}</li>`;
        }).join('');
        return `<article class="routing-rule-row${rule.enabled ? '' : ' is-off'}" data-rule-row="${escapeHtml(rule.id)}">
          <div class="routing-rule-head">
            <div class="routing-rule-id">
              <span class="combo-chain-pos">${index + 1}</span>
              <div class="routing-rule-text">
                <strong>${escapeHtml(rule.name)}</strong>
                <span class="routing-rule-conditions">${chips.length ? chips.map((chip) => `<span class="chip chip-quiet">${escapeHtml(chip)}</span>`).join('') : '<span class="routing-missing">No condition</span>'}</span>
              </div>
            </div>
            <div class="routing-rule-actions">
              <label class="mini-toggle"><input type="checkbox" data-rule-toggle="${escapeHtml(rule.id)}" ${rule.enabled ? 'checked' : ''} ${routingSaving ? 'disabled' : ''}><span></span><b>${rule.enabled ? 'Enabled' : 'Off'}</b></label>
              <button class="btn btn-ghost btn-xs" type="button" data-rule-edit="${escapeHtml(rule.id)}" ${routingSaving ? 'disabled' : ''}>Edit</button>
              <button class="btn btn-ghost btn-xs danger" type="button" data-rule-delete="${escapeHtml(rule.id)}" ${routingSaving ? 'disabled' : ''}>Delete</button>
            </div>
          </div>
          <ol class="combo-models routing-rule-chain">${chain || '<li class="routing-empty routing-chain-empty">No models</li>'}</ol>
        </article>`;
      }).join('')
      : '<div class="routing-empty">No rules yet. Requests keep the model they ask for until a rule matches.</div>';
  }

  const open = $('openRoutingRule');
  if (open) open.disabled = routingSaving;
  paintRoutingAliasTarget();
}

async function loadRoutingRules() {
  if (!document.querySelector('[data-page="/combos"]')) return;
  try {
    const res = await fetch('/api/routing-rules', { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || 'Could not load routing rules.');
    applyRoutingPayload(body);
    routingSaving = false;
    paintRouting();
  } catch (err) {
    detailNote($('routingNote'), err.message, 'bad');
  }
}

// Aliases and rules save immediately, like the vision card. A rejected save
// leaves the previous state on screen and puts the server message in the note.
async function saveRoutingRules(patch, okNote, failNote) {
  if (routingSaving) return false;
  routingSaving = true;
  paintRouting();
  try {
    const res = await fetch('/api/routing-rules', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Save failed (${res.status})`);
    applyRoutingPayload(body);
    detailNote($('routingNote'), okNote, 'ok');
    return true;
  } catch (err) {
    detailNote(failNote || $('routingNote'), err.message, 'bad');
    return false;
  } finally {
    routingSaving = false;
    paintRouting();
  }
}

$('routingAliasAdd')?.addEventListener('click', () => {
  if (routingSaving) return;
  const input = $('routingAliasName');
  const name = String(input?.value || '').trim();
  const target = String($('routingAliasTarget')?.value || '').trim();
  if (!name) {
    detailNote($('routingNote'), 'Enter the name clients will send.', 'bad');
    input?.focus();
    return;
  }
  if (!target) {
    detailNote($('routingNote'), 'Choose a model or combo target first.', 'bad');
    return;
  }
  if (routingSettings.aliases?.[name]) {
    detailNote($('routingNote'), `An alias named "${name}" already exists.`, 'bad');
    return;
  }
  const aliases = { ...routingSettings.aliases, [name]: target };
  saveRoutingRules({ aliases }, `${name} added.`).then((ok) => {
    if (!ok) return;
    if (input) input.value = '';
    input?.focus();
  });
});

$('routingAliasList')?.addEventListener('click', (event) => {
  const remove = event.target.closest('[data-alias-remove]');
  if (!remove || routingSaving) return;
  const name = remove.dataset.aliasRemove;
  const aliases = { ...routingSettings.aliases };
  delete aliases[name];
  saveRoutingRules({ aliases }, `${name} removed.`);
});

function openRoutingRuleModal(rule = null) {
  routingDraft = rule
    ? { id: rule.id, name: rule.name, enabled: rule.enabled !== false, match: { ...rule.match }, models: [...rule.models] }
    : { id: '', name: '', enabled: true, match: {}, models: [] };
  const form = $('routingRuleForm');
  const keySelect = $('routingRuleKey');
  if (keySelect) {
    keySelect.innerHTML = `<option value="">Any key</option>${routingKeys.map((key) => `<option value="${escapeHtml(key.id)}">${escapeHtml(key.name)}</option>`).join('')}`;
  }
  if (form) {
    const { match } = routingDraft;
    form.reset();
    form.elements.name.value = routingDraft.name;
    form.elements.enabled.checked = routingDraft.enabled;
    form.elements.headerName.value = match.header?.name || '';
    form.elements.headerValue.value = match.header?.value || '';
    form.elements.apiKeyId.value = match.apiKeyId || '';
    form.elements.minContextTokens.value = match.minContextTokens || '';
    form.elements.tools.value = match.hasTools === true ? 'has' : match.hasTools === false ? 'none' : 'any';
  }
  syncCustomSelects();
  $('routingRuleTitle').textContent = rule ? 'Edit rule' : 'New rule';
  detailNote($('routingRuleFormNote'), '', '');
  paintRoutingRuleChain();
  paintRoutingRuleModelOptions();
  $('routingRuleModal').hidden = false;
  form?.elements.name.focus();
}

function closeRoutingRuleModal() {
  const modal = $('routingRuleModal');
  if (modal) modal.hidden = true;
  routingDraft = { id: '', name: '', enabled: true, match: {}, models: [] };
}

function paintRoutingRuleModelOptions() {
  const select = $('routingRuleModelEntry');
  if (!select) return;
  const available = routingCatalog.filter((id) => !routingDraft.models.includes(id));
  if (!available.length) {
    select.innerHTML = `<option value="">${routingCatalog.length ? 'All enabled models already added' : 'No enabled models available'}</option>`;
    select.disabled = true;
    syncCustomSelects();
    return;
  }
  select.disabled = false;
  select.innerHTML = available.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('');
  syncCustomSelects();
}

function paintRoutingRuleChain() {
  const chain = $('routingRuleChain');
  if (!chain) return;
  chain.innerHTML = routingDraft.models.length
    ? routingDraft.models.map((model, index) => {
      const unavailable = !routingCatalog.includes(model);
      return `<li class="combo-chain-item${unavailable ? ' is-missing' : ''}" data-rule-chain-index="${index}">
        <span class="combo-chain-pos">${index + 1}</span>
        <code>${escapeHtml(model)}</code>
        ${unavailable ? '<span class="chip chip-quiet">Unavailable</span>' : ''}
        <span class="combo-chain-actions">
          <button class="iconbtn" type="button" data-rule-move="up" data-index="${index}" aria-label="Move ${escapeHtml(model)} up" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button class="iconbtn" type="button" data-rule-move="down" data-index="${index}" aria-label="Move ${escapeHtml(model)} down" ${index === routingDraft.models.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="iconbtn" type="button" data-rule-remove="${index}" aria-label="Remove ${escapeHtml(model)}">×</button>
        </span>
      </li>`;
    }).join('')
    : '<li class="combo-chain-empty">No models yet. Add at least one to enable the rule.</li>';
  const note = $('routingRuleChainNote');
  if (note) note.textContent = routingDraft.models.length ? `${routingDraft.models.length} in fallback order` : '';
}

function addRoutingRuleModel(value) {
  const model = String(value || '').trim();
  if (!model) return;
  if (routingDraft.models.includes(model)) {
    detailNote($('routingRuleFormNote'), `${model} is already in the chain.`, 'bad');
    return;
  }
  routingDraft.models.push(model);
  detailNote($('routingRuleFormNote'), '', '');
  paintRoutingRuleChain();
  paintRoutingRuleModelOptions();
  $('routingRuleAddModel')?.focus();
}

function routingRuleMatchFromForm(form) {
  const match = {};
  const headerName = form.elements.headerName.value.trim();
  const headerValue = form.elements.headerValue.value.trim();
  if (headerName || headerValue) match.header = { name: headerName, value: headerValue };
  if (form.elements.apiKeyId.value) match.apiKeyId = form.elements.apiKeyId.value;
  const min = form.elements.minContextTokens.value.trim();
  if (min) match.minContextTokens = Number(min);
  if (form.elements.tools.value === 'has') match.hasTools = true;
  else if (form.elements.tools.value === 'none') match.hasTools = false;
  return match;
}

async function saveRoutingRule(event) {
  event.preventDefault();
  const form = $('routingRuleForm');
  const note = $('routingRuleFormNote');
  const name = form.elements.name.value.trim();
  if (!name) {
    detailNote(note, 'Rule name is required.', 'bad');
    return;
  }
  const match = routingRuleMatchFromForm(form);
  if (!Object.keys(match).length) {
    detailNote(note, 'Add at least one match condition.', 'bad');
    return;
  }
  if (match.header && (!match.header.name || !match.header.value)) {
    detailNote(note, 'A header match needs both a name and a value.', 'bad');
    return;
  }
  if (match.minContextTokens !== undefined && (!Number.isInteger(match.minContextTokens) || match.minContextTokens <= 0)) {
    detailNote(note, 'Min context must be a whole number above zero.', 'bad');
    return;
  }
  const enabled = form.elements.enabled.checked;
  if (enabled && !routingDraft.models.length) {
    detailNote(note, 'Add at least one model before enabling this rule.', 'bad');
    return;
  }
  const rule = {
    ...(routingDraft.id ? { id: routingDraft.id } : {}),
    name,
    enabled,
    match,
    models: [...routingDraft.models],
  };
  const rules = routingDraft.id
    ? routingSettings.rules.map((item) => (item.id === routingDraft.id ? rule : item))
    : [...routingSettings.rules, rule];
  const ok = await saveRoutingRules({ rules }, `${name} saved.`, note);
  if (ok) closeRoutingRuleModal();
}

$('openRoutingRule')?.addEventListener('click', () => openRoutingRuleModal());
$('routingRuleForm')?.addEventListener('submit', saveRoutingRule);
document.querySelectorAll('[data-routing-rule-close]').forEach((el) => el.addEventListener('click', closeRoutingRuleModal));
$('routingRuleAddModel')?.addEventListener('click', () => {
  const select = $('routingRuleModelEntry');
  if (!select || select.disabled) return;
  addRoutingRuleModel(select.value);
});
$('routingRuleChain')?.addEventListener('click', (event) => {
  const move = event.target.closest('[data-rule-move]');
  const remove = event.target.closest('[data-rule-remove]');
  if (move) {
    const index = Number(move.dataset.index);
    const target = move.dataset.ruleMove === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= routingDraft.models.length) return;
    const [item] = routingDraft.models.splice(index, 1);
    routingDraft.models.splice(target, 0, item);
    paintRoutingRuleChain();
    $('routingRuleChain')?.querySelector(`[data-rule-move="${move.dataset.ruleMove}"][data-index="${target}"]`)?.focus();
    return;
  }
  if (remove) {
    routingDraft.models.splice(Number(remove.dataset.ruleRemove), 1);
    paintRoutingRuleChain();
    paintRoutingRuleModelOptions();
    $('routingRuleAddModel')?.focus();
  }
});
$('routingRuleList')?.addEventListener('change', (event) => {
  const toggle = event.target.closest('[data-rule-toggle]');
  if (!toggle || routingSaving) return;
  const id = toggle.dataset.ruleToggle;
  const rules = routingSettings.rules.map((rule) => (rule.id === id ? { ...rule, enabled: toggle.checked } : rule));
  saveRoutingRules({ rules }, toggle.checked ? 'Rule enabled.' : 'Rule disabled.');
});
$('routingRuleList')?.addEventListener('click', (event) => {
  const edit = event.target.closest('[data-rule-edit]');
  const del = event.target.closest('[data-rule-delete]');
  if (edit) {
    const rule = routingSettings.rules.find((item) => item.id === edit.dataset.ruleEdit);
    if (rule) openRoutingRuleModal(rule);
    return;
  }
  if (!del) return;
  const rule = routingSettings.rules.find((item) => item.id === del.dataset.ruleDelete);
  if (!rule) return;
  openConfirmation({
    title: 'Delete rule?',
    message: `"${rule.name}" stops rerouting requests as soon as it is removed. Aliases are not affected.`,
    confirmLabel: 'Delete rule',
    danger: true,
    run: async () => {
      const rules = routingSettings.rules.filter((item) => item.id !== rule.id);
      await saveRoutingRules({ rules }, `${rule.name} deleted.`);
    },
  }, del);
});

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

