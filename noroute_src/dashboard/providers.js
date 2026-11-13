/* ---------------- providers page ---------------- */

function renderCurlExample(providers = latest?.providers || []) {
  const curl = $('curlBlock');
  if (!curl) return;
  const first = providers.find((provider) => provider.prefix && provider.modelIds?.[0]);
  const model = first ? `${first.prefix}/${first.modelIds[0]}` : 'prefix/model-id';
  curl.textContent = [
    `curl ${location.origin}/v1/chat/completions \\`,
    '  -H "Content-Type: application/json" \\',
    '  -H "Authorization: Bearer $NOROUTER_API_KEY" \\',
    `  -d '{"model":"${model}",`,
    "        \"messages\":[{\"role\":\"user\",\"content\":\"halo\"}]}'",
  ].join('\n');
}

async function refreshProviderQuota() {
  if (currentPath !== '/providers' || document.visibilityState !== 'visible' || providerQuotaRefreshing) return;
  const providers = (latest?.providers || []).filter((provider) => provider.quotaSupported);
  if (!providers.length || Date.now() - providerQuotaLastRefresh < PROVIDER_QUOTA_REFRESH_MS) return;
  providerQuotaRefreshing = true;
  if (currentPath === '/providers') renderCurrent();
  try {
    await Promise.all(providers.map((provider) => fetch(`/api/providers/${encodeURIComponent(provider.id)}/accounts/quota-order/refresh`, { method: 'POST' }).catch(() => null)));
    providerQuotaLastRefresh = Date.now();
    await refresh();
  } finally {
    providerQuotaRefreshing = false;
    if (currentPath === '/providers') renderCurrent();
  }
}

function renderProviderCards(data) {
  const host = $('providerCards');
  if (!host) return;

  const card = (p) => {
    const ready = isReady(p.credential);
    const prefix = p.prefix || p.id;
    const quota = p.quota || {};
    const quotaKnown = Number.isFinite(quota.percent);
    const quotaLoading = providerQuotaRefreshing && p.quotaSupported && !quotaKnown;
    const quotaPercent = quotaKnown ? Math.min(100, Math.max(0, quota.percent)) : 0;
    const quotaLabel = quotaLoading ? 'Reading quota…' : quotaKnown ? `${quotaPercent}% quota used` : p.quotaSupported ? 'Quota not read' : 'No quota';
    const quotaTitle = quotaKnown ? `${quota.accounts || 0} account${quota.accounts === 1 ? '' : 's'} measured` : p.quotaSupported ? 'Quota is read from provider accounts' : 'This provider has no quota endpoint';
    return `<a class="card pcard" href="/providers/${encodeURIComponent(p.id)}">
      <div class="pcard-head">
        <div class="pcard-avatar">${escapeHtml(initialOf(p.name))}</div>
        <div class="pcard-id">
          <div class="pcard-title">${escapeHtml(p.name)}</div>
          <div class="pcard-sub"><code>${escapeHtml(prefix)}</code></div>
        </div>
        <span class="status-pill ${ready ? 'ok' : 'bad'}"><span class="dot"></span>${ready ? 'Ready' : 'No account'}</span>
      </div>
      <div class="pcard-summary">
        <span><strong>${p.accounts || 0}</strong> ${p.accounts === 1 ? 'account' : 'accounts'}</span>
        <span><strong>${p.models}</strong> models</span>
      </div>
      <div class="pcard-quota${quotaLoading ? ' is-loading' : ''}" title="${escapeHtml(quotaTitle)}">
        <div class="pcard-quota-label"><span>Quota</span><strong>${quotaLabel}</strong></div>
        ${quotaKnown ? `<div class="pcard-quota-track" role="progressbar" aria-label="${escapeHtml(p.name)} quota used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${quotaPercent}"><span style="width:${quotaPercent}%"></span></div>` : ''}
      </div>
      <div class="pcard-foot"><span>Open provider</span><span aria-hidden="true">→</span></div>
    </a>`;
  };

  // With no providers the grid would be a bare row of one tile; say what the
  // page is for and keep the grid shape rather than collapsing to nothing.
  const empty = data.providers.length
    ? ''
    : `<article class="card pcard pcard-empty">
        <strong class="pcard-title">No providers yet</strong>
        <p class="pcard-sub">Add an endpoint to route requests through it.</p>
      </article>`;

  host.innerHTML = empty + data.providers.map(card).join('') + `<button class="pcard-add" id="openAddProvider" type="button">
    <span class="pcard-add-icon" aria-hidden="true">+</span>
    <strong>Add a provider</strong>
    <span>Any endpoint works, including a local server.</span>
  </button>`;
  staggerChildren(host, '.pcard, .pcard-add', `providers:${data.providers.map((p) => p.id).join('|')}`);

  const count = $('pgCount');
  if (count) {
    count.textContent = `${data.providers.length} total`;
    count.title = `${data.providers.length} provider${data.providers.length === 1 ? '' : 's'}`;
  }

  $('openAddProvider')?.addEventListener('click', (event) => openCreateProvider(event.currentTarget));

  renderCurlExample(data.providers);
}

