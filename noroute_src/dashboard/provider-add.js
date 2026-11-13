/* ---------------- add provider ---------------- */

let createProviderOpener = null;

// Conventional endpoint per wire format. Used to prefill the chat path and to
// decide whether a path is still auto-generated before replacing it.
const FORMAT_PATHS = { openai: '/chat/completions', responses: '/responses', anthropic: '/messages' };
const WIRE_FORMATS = Object.keys(FORMAT_PATHS);

function createProviderModal() {
  return $('createProviderModal');
}

function createProviderForm() {
  return $('addProviderForm');
}

function slugifyProviderName(raw) {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// Keep the path in step with the format without clobbering an endpoint the
// user typed themselves: only empty or still-conventional paths are replaced.
function syncChatPathToFormat(form) {
  const chatPath = form.elements.chatPath;
  const format = form.elements.format.value;
  const preset = FORMAT_PATHS[format] || FORMAT_PATHS.openai;
  const current = chatPath.value.trim();
  if (!current || Object.values(FORMAT_PATHS).includes(current)) chatPath.value = preset;
}

function setFormatValue(form, value) {
  form.elements.format.value = WIRE_FORMATS.includes(value) ? value : 'openai';
}

function fillPrefixFromName() {
  const form = createProviderForm();
  if (!form) return;
  const name = form.querySelector('input[name="name"]');
  const prefix = form.querySelector('input[name="prefix"]');
  // Only auto-fill when the user hasn't touched the prefix field yet.
  if (!name || !prefix || prefix.dataset.touched === 'true') return;
  const raw = name.value.trim();
  prefix.value = raw ? slugifyProviderName(raw).slice(0, 30) || 'provider' : '';
}

function closeCreateProvider() {
  const modal = createProviderModal();
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove('modal-open');
  const opener = createProviderOpener;
  createProviderOpener = null;
  requestAnimationFrame(() => opener?.focus?.());
}

function openCreateProvider(opener = document.activeElement) {
  const modal = createProviderModal();
  const form = createProviderForm();
  if (!modal || !form) return;
  createProviderOpener = opener;
  modal.hidden = false;
  document.body.classList.add('modal-open');
  detailNote($('addProviderNote'), '');
  fillPrefixFromName();
  requestAnimationFrame(() => form.querySelector('input[name="name"]')?.focus());
}

const addProviderForm = createProviderForm();

if (addProviderForm) {
  const addProviderName = addProviderForm.querySelector('input[name="name"]');
  const addProviderPrefix = addProviderForm.querySelector('input[name="prefix"]');
  const addProviderFormat = addProviderForm.querySelector('select[name="format"]');

  addProviderName?.addEventListener('input', fillPrefixFromName);
  // Mark prefix as touched when the user focuses it, so we don't overwrite
  // a manual edit later.
  addProviderPrefix?.addEventListener('focus', () => {
    addProviderPrefix.dataset.touched = 'true';
  });
  addProviderFormat?.addEventListener('change', () => syncChatPathToFormat(addProviderForm));
}

document.querySelectorAll('[data-create-provider-close]').forEach((el) => el.addEventListener('click', closeCreateProvider));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && createProviderModal() && !createProviderModal().hidden) closeCreateProvider();
});

addProviderForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const note = $('addProviderNote');
  const button = form.querySelector('button[type="submit"]');
  const values = Object.fromEntries(new FormData(form).entries());
  const format = WIRE_FORMATS.includes(values.format) ? values.format : 'openai';
  const payload = {
    name: values.name.trim(),
    prefix: values.prefix.trim(),
    baseUrl: values.baseUrl.trim(),
    format,
    chatPath: values.chatPath.trim() || FORMAT_PATHS[format],
  };

  button.disabled = true;
  detailNote(note, 'Creating provider…');
  try {
    const res = await fetch('/api/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    closeCreateProvider();
    form.reset();
    const prefix = form.querySelector('input[name="prefix"]');
    if (prefix) prefix.dataset.touched = 'false';
    detailNote(note, '');
    await refresh();
    navigate(`/providers/${encodeURIComponent(body.created)}`);
  } catch (err) {
    detailNote(note, err.message, 'bad');
  } finally {
    button.disabled = false;
  }
});

/* ---------------- edit provider ---------------- */

let editProviderOpener = null;

function providerList(value) {
  return Array.isArray(value) ? value.join(', ') : value || '';
}

function providerJson(value, label) {
  const text = String(value || '').trim() || '{}';
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${label} must be valid JSON.`); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(`${label} must be a JSON object.`);
  return parsed;
}

function closeEditProvider() {
  $('editProviderModal').hidden = true;
  editProviderOpener?.focus?.();
  editProviderOpener = null;
}

function openEditProvider(opener = document.activeElement) {
  if (!detail?.provider) return;
  const provider = detail.provider;
  const config = provider.config || provider;
  const summary = latest?.providers?.find((item) => item.id === provider.id) || {};
  const form = $('editProviderForm');
  editProviderOpener = opener;
  form.reset();
  form.elements.id.value = config.id || '';
  form.elements.name.value = config.name || '';
  form.elements.prefix.value = config.prefix || provider.prefix || provider.id;
  form.elements.website.value = config.website || summary.website || '';
  form.elements.baseUrl.value = config.baseUrl || summary.baseUrl || '';
  // The stored path is kept as-is; changing the format later only rewrites it
  // while it is still one of the conventional endpoints.
  setFormatValue(form, config.format);
  form.elements.chatPath.value = config.chatPath || FORMAT_PATHS[form.elements.format.value];
  form.elements.forceStream.checked = config.forceStream === true;
  form.elements.requiresAccount.checked = config.requiresAccount === true;
  form.elements.models.value = providerList(config.models || detail.models?.map((model) => model.id));
  form.elements.headers.value = JSON.stringify(config.headers || {}, null, 2);
  form.elements.baseUrlEnv.value = config.baseUrlEnv || '';
  form.elements.refreshUrl.value = config.refresh?.url || '';
  form.elements.refreshHeaders.value = JSON.stringify(config.refresh?.headers || {}, null, 2);
  form.elements.quotaUrl.value = config.quota?.url || '';
  form.elements.quotaParser.value = config.quota?.parse || '';
  form.elements.checkinUrl.value = config.checkin?.url || '';
  form.elements.reasoning.value = JSON.stringify(config.reasoning || {}, null, 2);
  // Assigning .value above does not fire `change`, so repaint the custom
  // selects to show the stored format instead of the previous one.
  syncCustomSelects();
  detailNote($('editProviderNote'), '');
  $('editProviderModal').hidden = false;
  form.elements.id.focus();
}

$('editProviderForm')?.elements.format?.addEventListener('change', () => syncChatPathToFormat($('editProviderForm')));

$('editProviderForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  const values = Object.fromEntries(new FormData(form).entries());
  const models = values.models.split(/[\n,]+/).map((model) => model.trim()).filter(Boolean);
  const prefix = values.prefix.trim();
  const note = $('editProviderNote');
  let payload;
  try {
    payload = {
      id: values.id.trim(), prefix, name: values.name.trim(), website: values.website.trim(),
      baseUrl: values.baseUrl.trim(), chatPath: values.chatPath.trim(), format: values.format.trim(),
      forceStream: form.elements.forceStream.checked, requiresAccount: form.elements.requiresAccount.checked,
      // A provider may legitimately have no models until they are added on its
      // Models tab; send nothing so PATCH keeps the current (empty) catalog.
      ...(models.length ? { models } : {}),
      headers: providerJson(values.headers, 'Request headers'), baseUrlEnv: values.baseUrlEnv.trim(),
      refresh: values.refreshUrl.trim() ? { url: values.refreshUrl.trim(), headers: providerJson(values.refreshHeaders, 'Refresh headers') } : null,
      quota: values.quotaUrl.trim() ? { url: values.quotaUrl.trim(), parse: values.quotaParser.trim() } : null,
      checkin: values.checkinUrl.trim() ? { url: values.checkinUrl.trim() } : null,
      reasoning: providerJson(values.reasoning, 'Reasoning config'),
    };
  } catch (err) {
    detailNote(note, err.message, 'bad');
    return;
  }
  // Clearing a catalog that already has models is almost always a mistake; a
  // provider that never had models can still be saved.
  if (!models.length && (detail?.models?.length || 0) > 0) {
    detailNote(note, 'Add at least one model, or remove them from the Models tab.', 'bad');
    return;
  }

  button.disabled = true;
  detailNote(note, 'Saving provider…');
  try {
    const res = await fetch(`/api/providers/${encodeURIComponent(currentDetailId)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    const updatedId = body.provider?.id || body.updated || body.id || payload.id;
    closeEditProvider();
    await refresh();
    if (updatedId !== currentDetailId) navigate(`/providers/${encodeURIComponent(updatedId)}`);
    else await loadDetail();
  } catch (err) {
    detailNote(note, err.message, 'bad');
  } finally {
    button.disabled = false;
  }
});

document.querySelectorAll('[data-edit-provider-close]').forEach((el) => el.addEventListener('click', closeEditProvider));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('editProviderModal').hidden) closeEditProvider(); });

