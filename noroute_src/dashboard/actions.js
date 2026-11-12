/* ---------------- actions ---------------- */

async function copyBase() {
  const url = `${location.origin}/v1`;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    const area = document.createElement('textarea');
    area.value = url;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }

  const button = $('copyBase');
  if (button) {
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = 'Copy'; }, 1400);
  }
}

$('autostartToggle')?.addEventListener('change', async (event) => {
  const toggle = event.currentTarget;
  const note = $('autostartNote');
  const enabled = toggle.checked;
  toggle.disabled = true;
  detailNote(note, enabled ? 'Enabling autostart…' : 'Disabling autostart…');
  try {
    const res = await fetch('/api/settings/autostart', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Autostart update failed (${res.status})`);
    toggle.checked = body.enabled;
    detailNote(note, body.enabled ? 'Autostart enabled.' : 'Autostart disabled.', 'ok');
  } catch (err) {
    toggle.checked = !enabled;
    detailNote(note, err.message, 'bad');
  } finally {
    toggle.disabled = false;
  }
});

$('exportAccounts')?.addEventListener('click', async () => {
  const note = $('backupNote');
  try {
    const res = await fetch('/api/settings/accounts/export');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error?.message || `Export failed (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'norouter-accounts.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    detailNote(note, 'Accounts downloaded. Keep the file safe.', 'ok');
  } catch (err) {
    detailNote(note, err.message, 'bad');
  }
});

$('restoreAccountsFile')?.addEventListener('change', async (event) => {
  const note = $('backupNote');
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch (err) {
    detailNote(note, `That is not valid JSON: ${err.message}`, 'bad');
    return;
  }
  const count = Array.isArray(payload?.accounts) ? payload.accounts.length : Array.isArray(payload) ? payload.length : 0;
  openConfirmation({
    title: 'Restore accounts?',
    message: `This merges ${count || 'the'} accounts from "${file.name}". Duplicates are skipped and no existing account is deleted.`,
    confirmLabel: 'Restore accounts',
    run: async () => {
      try {
        const res = await fetch('/api/settings/accounts/restore', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error?.message || `Restore failed (${res.status})`);
        detailNote(note, `${body.added} added${body.duplicates ? ` · ${body.duplicates} duplicates skipped` : ''}${body.invalid ? ` · ${body.invalid} invalid` : ''}${body.unknownProviders ? ` · ${body.unknownProviders} unknown providers` : ''}.`, 'ok');
      } catch (err) {
        detailNote(note, err.message, 'bad');
      }
    },
  });
});

$('saveServerPort')?.addEventListener('click', async () => {
  const input = $('serverPort');
  const note = $('serverPortNote');
  const button = $('saveServerPort');
  const port = Number(input?.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    detailNote(note, 'Port must be an integer between 1 and 65535.', 'bad');
    return;
  }
  button.disabled = true;
  detailNote(note, 'Checking port…');
  try {
    const res = await fetch('/api/settings/port', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Port change failed (${res.status})`);
    detailNote(note, `Port changed to ${port}. Reconnecting…`, 'ok');
    window.setTimeout(() => location.href = `${location.protocol}//${location.hostname}:${port}${location.pathname}`, 500);
  } catch (err) {
    detailNote(note, err.message, 'bad');
    button.disabled = false;
  }
});

$('copyBase')?.addEventListener('click', copyBase);
$('copyApiKey')?.addEventListener('click', async () => {
  if (!dashboardApiKeySecret) return;
  await copyText(dashboardApiKeySecret);
  const button = $('copyApiKey');
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = 'Copy'; }, 1400);
});
$('copyCurl')?.addEventListener('click', async () => {
  const block = $('curlBlock');
  try {
    await navigator.clipboard.writeText(block.textContent);
  } catch {
    // Clipboard blocked; the block is selectable, so leave it as is.
  }
  const btn = $('copyCurl');
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
});

