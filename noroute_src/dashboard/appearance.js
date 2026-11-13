/* ---------------- appearance ---------------- */

const ACCENTS = ['blue', 'amber', 'rose', 'ink', 'graphite', 'slate'];
const ACCENT_NAMES = { blue: 'Blue', amber: 'Amber', rose: 'Rose', ink: 'Ink', graphite: 'Graphite', slate: 'Slate' };
// Older builds stored coloured accents under names this build no longer
// paints. Fold those onto the closest current hue rather than losing the
// saved choice to a neutral swatch.
const LEGACY_ACCENTS = { violet: 'blue', purple: 'blue', indigo: 'blue', teal: 'blue', green: 'blue', cyan: 'blue', orange: 'amber', red: 'rose' };
const savedAccent = document.documentElement.dataset.accent;
const appearance = {
  theme: document.documentElement.dataset.theme || 'light',
  accent: ACCENTS.includes(savedAccent) ? savedAccent : (LEGACY_ACCENTS[savedAccent] || 'blue'),
};

function saveAppearance() {
  try {
    localStorage.setItem(THEME_KEY, appearance.theme);
    localStorage.setItem(ACCENT_KEY, appearance.accent);
  } catch {
    // Private mode with storage blocked: the live change still applies.
  }
}

function applyAppearance() {
  document.documentElement.dataset.theme = appearance.theme;
  document.documentElement.dataset.accent = appearance.accent;
  paintAppearanceControls();
}

function paintAppearanceControls() {
  document.querySelectorAll('[data-theme-value]').forEach((btn) => {
    const active = btn.dataset.themeValue === appearance.theme;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('[data-accent-value]').forEach((btn) => {
    const active = btn.dataset.accentValue === appearance.accent;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  const themeNote = $('themeNote');
  const accentNote = $('accentNote');
  if (themeNote) themeNote.textContent = appearance.theme;
  if (accentNote) accentNote.textContent = ACCENT_NAMES[appearance.accent] || appearance.accent;
}

document.querySelectorAll('[data-theme-value]').forEach((btn) => {
  btn.addEventListener('click', () => {
    appearance.theme = btn.dataset.themeValue;
    saveAppearance();
    applyAppearance();
  });
});

document.querySelectorAll('[data-accent-value]').forEach((btn) => {
  btn.addEventListener('click', () => {
    appearance.accent = btn.dataset.accentValue;
    saveAppearance();
    applyAppearance();
  });
});

document.querySelectorAll('[data-settings-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    settingsTab = btn.dataset.settingsTab;
    paintSettingsTabs();
    if (settingsTab === 'reply') loadReplyFilters();
    if (settingsTab === 'debug') loadRequestLog();
  });
});
$('settingsTabs')?.addEventListener('keydown', (event) => {
  const tabs = [...document.querySelectorAll('[data-settings-tab]')];
  const current = tabs.indexOf(document.activeElement);
  if (current < 0) return;
  let next = null;
  if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  if (next === null) return;
  event.preventDefault();
  tabs[next].focus();
  settingsTab = tabs[next].dataset.settingsTab;
  paintSettingsTabs();
  if (settingsTab === 'reply') loadReplyFilters();
  if (settingsTab === 'debug') loadRequestLog();
});
$('tokenSaverPonytail')?.addEventListener('change', (event) => {
  patchTokenSaver({ ponytail: { enabled: event.currentTarget.checked } });
});
$('tokenSaverRtk')?.addEventListener('change', (event) => {
  patchTokenSaver({ rtk: { enabled: event.currentTarget.checked } });
});
$('tokenSaverCaveman')?.addEventListener('change', (event) => {
  patchTokenSaver({ caveman: { enabled: event.currentTarget.checked } });
});
function replyLanguageLabel(code) {
  if (code === 'auto') return { native: 'Auto', english: 'Match user', flag: '🌐' };
  if (code === 'none') return { native: 'None', english: 'No instruction', flag: '⊘' };
  return REPLY_LANGUAGE_CATALOG.find((item) => item.code === code) || REPLY_LANGUAGE_CATALOG[0];
}

function renderReplyLanguageTrigger() {
  const item = replyLanguageLabel(replyFilters.language);
  const holder = $('replyLanguageFlag');
  if (holder) {
    holder.replaceChildren();
    if (item.flag === '🌐' || item.flag === '⊘') {
      holder.textContent = item.flag;
    } else {
      const img = document.createElement('img');
      img.className = 'reply-language-flag-img';
      img.src = `/assets/flags/${item.flag}.png`;
      img.alt = '';
      holder.append(img);
    }
  }
  if ($('replyLanguageLabel')) $('replyLanguageLabel').textContent = `${item.native} · ${item.english}`;
  const trigger = $('replyLanguageTrigger');
  if (trigger) trigger.setAttribute('aria-label', `Reply language: ${item.native}`);
}

function visibleReplyLanguages() {
  const query = ($('replyLanguageSearch')?.value || '').trim().toLocaleLowerCase();
  if (!query) return REPLY_LANGUAGE_CATALOG;
  return REPLY_LANGUAGE_CATALOG.filter((item) => `${item.code} ${item.native} ${item.english}`.toLocaleLowerCase().includes(query));
}

function renderReplyLanguageGrid() {
  const grid = $('replyLanguageGrid');
  const empty = $('replyLanguageEmpty');
  if (!grid) return;
  grid.replaceChildren();
  const items = visibleReplyLanguages();
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `reply-language-option${item.code === replyFilters.language ? ' is-selected' : ''}`;
    button.dataset.replyLanguage = item.code;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(item.code === replyFilters.language));
    button.title = `${item.native} · ${item.english}`;
    const flag = document.createElement('span');
    flag.className = 'reply-language-option-flag';
    flag.setAttribute('aria-hidden', 'true');
    if (item.flag === '🌐' || item.flag === '⊘') {
      flag.textContent = item.flag;
    } else {
      const img = document.createElement('img');
      img.className = 'reply-language-flag-img';
      img.src = `/assets/flags/${item.flag}.png`;
      img.alt = '';
      flag.append(img);
    }
    const copy = document.createElement('span');
    copy.className = 'reply-language-option-copy';
    const native = document.createElement('strong');
    native.textContent = item.native;
    const english = document.createElement('small');
    english.textContent = item.english;
    copy.append(native, english);
    button.append(flag, copy);
    grid.append(button);
  }
  if (empty) {
    empty.hidden = items.length > 0;
    empty.textContent = items.length ? '' : 'No matching languages.';
  }
}

function closeReplyLanguagePicker({ focus = true } = {}) {
  const popup = $('replyLanguagePopup');
  const trigger = $('replyLanguageTrigger');
  if (!popup || popup.hidden) return;
  popup.hidden = true;
  trigger?.setAttribute('aria-expanded', 'false');
  if (focus) trigger?.focus();
}

function openReplyLanguagePicker() {
  const popup = $('replyLanguagePopup');
  const trigger = $('replyLanguageTrigger');
  if (!popup) return;
  popup.hidden = false;
  trigger?.setAttribute('aria-expanded', 'true');
  $('replyLanguageSearch').value = '';
  renderReplyLanguageGrid();
  $('replyLanguageSearch')?.focus();
}

function moveReplyLanguageFocus(delta, vertical = false) {
  const options = [...document.querySelectorAll('#replyLanguageGrid [data-reply-language]')];
  const current = options.indexOf(document.activeElement);
  if (!options.length) return;
  const columns = Math.max(1, Math.round($('replyLanguageGrid').clientWidth / 150));
  const step = vertical ? columns : 1;
  const next = current < 0 ? 0 : Math.min(options.length - 1, Math.max(0, current + delta * step));
  options[next].focus();
}

async function chooseReplyLanguage(code) {
  const previous = replyFilters.language;
  replyFilters.language = code;
  renderReplyLanguageTrigger();
  renderReplyLanguageGrid();
  closeReplyLanguagePicker();
  try {
    await patchReplyFilters({ language: code });
  } catch {
    replyFilters.language = previous;
    renderReplyLanguageTrigger();
    renderReplyLanguageGrid();
  }
}

$('replyLanguageTrigger')?.addEventListener('click', () => {
  if ($('replyLanguagePopup')?.hidden) openReplyLanguagePicker();
  else closeReplyLanguagePicker();
});
$('replyLanguageSearch')?.addEventListener('input', renderReplyLanguageGrid);
$('replyLanguageGrid')?.addEventListener('click', (event) => {
  const option = event.target.closest('[data-reply-language]');
  if (option) chooseReplyLanguage(option.dataset.replyLanguage);
});
$('replyLanguageGrid')?.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowRight') { event.preventDefault(); moveReplyLanguageFocus(1); }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); moveReplyLanguageFocus(-1); }
  else if (event.key === 'ArrowDown') { event.preventDefault(); moveReplyLanguageFocus(1, true); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); moveReplyLanguageFocus(-1, true); }
  else if (event.key === 'Home') { event.preventDefault(); document.querySelector('#replyLanguageGrid [data-reply-language]')?.focus(); }
  else if (event.key === 'End') { event.preventDefault(); [...document.querySelectorAll('#replyLanguageGrid [data-reply-language]')].at(-1)?.focus(); }
});
document.querySelectorAll('[data-reply-language-close]').forEach((element) => element.addEventListener('click', () => closeReplyLanguagePicker()));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('replyLanguagePopup')?.hidden) closeReplyLanguagePicker();
});
$('replyVerbosity')?.addEventListener('change', (event) => {
  patchReplyFilters({ verbosity: event.currentTarget.value });
});
$('replyCoding')?.addEventListener('change', (event) => {
  patchReplyFilters({ coding: event.currentTarget.checked });
});

const resetBtn = $('resetAppearance');
if (resetBtn) {
  resetBtn.addEventListener('click', () => {
    appearance.theme = 'light';
    appearance.accent = 'blue';
    saveAppearance();
    applyAppearance();
  });
}

