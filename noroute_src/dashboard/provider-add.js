/* ---------------- add provider ---------------- */

$('closeAddProvider')?.addEventListener('click', () => {
  $('addProviderCard').hidden = true;
});

$('addProviderForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const note = $('addProviderNote');
  const button = form.querySelector('button[type="submit"]');
  const data = Object.fromEntries(new FormData(form).entries());
  data.prefix = data.prefix.trim();

  button.disabled = true;
  detailNote(note, 'Creating provider…');
  try {
    const res = await fetch('/api/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    form.reset();
    $('addProviderCard').hidden = true;
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
  form.elements.chatPath.value = config.chatPath || '/chat/completions';
  form.elements.format.value = config.format || 'openai';
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
  detailNote($('editProviderNote'), '');
  $('editProviderModal').hidden = false;
  form.elements.id.focus();
}

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
      models, headers: providerJson(values.headers, 'Request headers'), baseUrlEnv: values.baseUrlEnv.trim(),
      refresh: values.refreshUrl.trim() ? { url: values.refreshUrl.trim(), headers: providerJson(values.refreshHeaders, 'Refresh headers') } : null,
      quota: values.quotaUrl.trim() ? { url: values.quotaUrl.trim(), parse: values.quotaParser.trim() } : null,
      checkin: values.checkinUrl.trim() ? { url: values.checkinUrl.trim() } : null,
      reasoning: providerJson(values.reasoning, 'Reasoning config'),
    };
  } catch (err) {
    detailNote(note, err.message, 'bad');
    return;
  }
  if (!models.length) { detailNote(note, 'Add at least one model.', 'bad'); return; }

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

