const $ = (id) => document.getElementById(id);

const REFRESH_MS = 2000;
let pointerFrame = 0;
let pointerX = 50;
let pointerY = 35;

function paintPointerGlow() {
  pointerFrame = 0;
  document.documentElement.style.setProperty('--pointer-x', `${pointerX}%`);
  document.documentElement.style.setProperty('--pointer-y', `${pointerY}%`);
}

if (window.matchMedia?.('(pointer: fine)').matches && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
  window.addEventListener('pointermove', (event) => {
    pointerX = (event.clientX / Math.max(window.innerWidth, 1)) * 100;
    pointerY = (event.clientY / Math.max(window.innerHeight, 1)) * 100;
    if (!pointerFrame) pointerFrame = requestAnimationFrame(paintPointerGlow);
  }, { passive: true });
}

const THEME_KEY = 'norouter.theme';
let motionEpoch = 0;

function staggerChildren(host, selector, key) {
  if (!host || host.dataset.motionKey === key) return;
  host.dataset.motionKey = key;
  host.querySelectorAll(selector).forEach((item, index) => {
    item.style.setProperty('--motion-index', Math.min(index, 12));
    item.classList.add('motion-stagger');
  });
}

function moveTabIndicator(host, selector = '[role="tab"].is-active') {
  if (!host) return;
  const active = host.querySelector(selector);
  if (!active) return;
  const paint = () => {
    host.style.setProperty('--tab-left', `${active.offsetLeft}px`);
    host.style.setProperty('--tab-width', `${active.offsetWidth}px`);
  };
  paint();
  if (!active.offsetWidth) requestAnimationFrame(paint);
}

const ACCENT_KEY = 'norouter.accent';

const REPLY_LANGUAGE_CATALOG = [
  ['auto', 'Auto', 'Match user prompt', '🌐'], ['none', 'None', 'No language instruction', '⊘'], ['af', 'Afrikaans', 'Afrikaans', 'za'],
  ['am', 'አማርኛ', 'Amharic', 'et'], ['ar', 'العربية', 'Arabic', 'sa'], ['az', 'azərbaycan dili', 'Azerbaijani', 'az'],
  ['bg', 'български език', 'Bulgarian', 'bg'], ['bn', 'বাংলা', 'Bengali', 'bd'], ['bs', 'bosanski jezik', 'Bosnian', 'ba'],
  ['ca', 'català', 'Catalan', 'es'], ['cs', 'čeština', 'Czech', 'cz'], ['cy', 'Cymraeg', 'Welsh', 'gb-wls'],
  ['da', 'dansk', 'Danish', 'dk'], ['de', 'Deutsch', 'German', 'de'], ['el', 'Ελληνικά', 'Greek', 'gr'],
  ['en', 'English', 'English', 'gb'], ['es', 'Español', 'Spanish', 'es'], ['et', 'eesti', 'Estonian', 'ee'],
  ['eu', 'euskara', 'Basque', 'es'], ['fa', 'فارسی', 'Persian', 'ir'], ['fi', 'suomi', 'Finnish', 'fi'],
  ['fr', 'Français', 'French', 'fr'], ['ga', 'Gaeilge', 'Irish', 'ie'], ['gl', 'galego', 'Galician', 'es'],
  ['gu', 'ગુજરાતી', 'Gujarati', 'in'], ['ha', 'Hausa', 'Hausa', 'ng'], ['he', 'עברית', 'Hebrew', 'il'],
  ['hi', 'हिन्दी', 'Hindi', 'in'], ['hr', 'hrvatski', 'Croatian', 'hr'], ['hu', 'magyar', 'Hungarian', 'hu'],
  ['hy', 'հայերեն', 'Armenian', 'am'], ['id', 'Bahasa Indonesia', 'Indonesian', 'id'], ['is', 'íslenska', 'Icelandic', 'is'],
  ['it', 'Italiano', 'Italian', 'it'], ['ja', '日本語', 'Japanese', 'jp'], ['jv', 'Basa Jawa', 'Javanese', 'id'],
  ['ka', 'ქართული', 'Georgian', 'ge'], ['kk', 'қазақ тілі', 'Kazakh', 'kz'], ['km', 'ខ្មែរ', 'Khmer', 'kh'],
  ['kn', 'ಕನ್ನಡ', 'Kannada', 'in'], ['ko', '한국어', 'Korean', 'kr'], ['ky', 'кыргызча', 'Kyrgyz', 'kg'],
  ['la', 'latine', 'Latin', 'va'], ['lo', 'ລາວ', 'Lao', 'la'], ['lt', 'lietuvių kalba', 'Lithuanian', 'lt'],
  ['lv', 'latviešu valoda', 'Latvian', 'lv'], ['mg', 'Malagasy', 'Malagasy', 'mg'], ['mi', 'Māori', 'Māori', 'nz'],
  ['mk', 'македонски', 'Macedonian', 'mk'], ['ml', 'മലയാളം', 'Malayalam', 'in'], ['mn', 'монгол', 'Mongolian', 'mn'],
  ['mr', 'मराठी', 'Marathi', 'in'], ['ms', 'Bahasa Melayu', 'Malay', 'my'], ['mt', 'Malti', 'Maltese', 'mt'],
  ['my', 'မြန်မာစာ', 'Burmese', 'mm'], ['ne', 'नेपाली', 'Nepali', 'np'], ['nl', 'Nederlands', 'Dutch', 'nl'],
  ['no', 'Norsk', 'Norwegian', 'no'], ['ny', 'Chichewa', 'Chichewa', 'mw'], ['or', 'ଓଡ଼ିଆ', 'Odia', 'in'],
  ['pa', 'ਪੰਜਾਬੀ', 'Punjabi', 'in'], ['pl', 'polski', 'Polish', 'pl'], ['ps', 'پښتو', 'Pashto', 'af'],
  ['pt', 'Português', 'Portuguese', 'pt'], ['ro', 'română', 'Romanian', 'ro'], ['ru', 'Русский', 'Russian', 'ru'],
  ['rw', 'Kinyarwanda', 'Kinyarwanda', 'rw'], ['sa', 'संस्कृतम्', 'Sanskrit', 'in'], ['si', 'සිංහල', 'Sinhala', 'lk'],
  ['sk', 'slovenčina', 'Slovak', 'sk'], ['sl', 'slovenščina', 'Slovenian', 'si'], ['so', 'Soomaaliga', 'Somali', 'so'],
  ['sq', 'shqip', 'Albanian', 'al'], ['sr', 'српски', 'Serbian', 'rs'], ['sv', 'svenska', 'Swedish', 'se'],
  ['sw', 'Kiswahili', 'Swahili', 'tz'], ['ta', 'தமிழ்', 'Tamil', 'in'], ['te', 'తెలుగు', 'Telugu', 'in'],
  ['tg', 'тоҷикӣ', 'Tajik', 'tj'], ['th', 'ไทย', 'Thai', 'th'], ['tk', 'Türkmençe', 'Turkmen', 'tm'],
  ['tl', 'Tagalog', 'Tagalog', 'ph'], ['tn', 'Setswana', 'Tswana', 'bw'], ['tr', 'Türkçe', 'Turkish', 'tr'],
  ['tt', 'татар теле', 'Tatar', 'ru'], ['uk', 'Українська', 'Ukrainian', 'ua'], ['ur', 'اردو', 'Urdu', 'pk'],
  ['uz', 'Oʻzbek', 'Uzbek', 'uz'], ['vi', 'Tiếng Việt', 'Vietnamese', 'vn'], ['xh', 'isiXhosa', 'Xhosa', 'za'],
  ['yi', 'ייִדיש', 'Yiddish', 'il'], ['yo', 'Yorùbá', 'Yoruba', 'ng'], ['zh', '中文', 'Chinese', 'cn'],
  ['zu', 'isiZulu', 'Zulu', 'za'], ['be', 'беларуская мова', 'Belarusian', 'by'], ['bo', 'བོད་ཡིག', 'Tibetan', 'cn'],
  ['br', 'brezhoneg', 'Breton', 'fr'], ['ee', 'Eʋegbe', 'Ewe', 'gh'], ['ff', 'Fulfulde', 'Fulah', 'sn'],
  ['ig', 'Igbo', 'Igbo', 'ng'], ['ku', 'Kurdî', 'Kurdish', 'iq'], ['lb', 'Lëtzebuergesch', 'Luxembourgish', 'lu'],
  ['ln', 'Lingála', 'Lingala', 'cd'], ['lu', 'Tshiluba', 'Luba-Katanga', 'cd'], ['nb', 'Norsk bokmål', 'Norwegian Bokmål', 'no'],
  ['om', 'Afaan Oromoo', 'Oromo', 'et'], ['qu', 'Runa Simi', 'Quechua', 'pe'], ['rm', 'rumantsch', 'Romansh', 'ch'],
  ['se', 'Davvisámegiella', 'Northern Sami', 'no'], ['st', 'Sesotho', 'Southern Sotho', 'ls'], ['ts', 'itsonga', 'Tsonga', 'za'],
  ['wo', 'Wolof', 'Wolof', 'sn'], ['za', 'Saɯ cueŋƅ', 'Zhuang', 'cn'],
].map(([code, native, english, flag]) => ({ code, native, english, flag }));

const ROUTES = {
  '/': { title: 'Dashboard', sub: 'Monitor gateway health, traffic, and recent activity.', copy: true },
  '/providers': { title: 'Providers', sub: 'Every upstream this router can reach.', copy: false },
  '/usage': { title: 'Usage', sub: 'Tokens and requests, broken down per model.', copy: false },
  '/chat': { title: 'Chat', sub: 'Talk to your local model gateway.', copy: false },
  '/combos': { title: 'Combos', sub: 'Virtual model names that fall back through a list.', copy: false },
  '/settings': { title: 'Settings', sub: 'Appearance and connection details.', copy: false },
  '/api-keys': { title: 'API Keys', sub: 'Manage access to your proxy endpoint.', copy: false },
};

/* ---------------- formatting ---------------- */

const fmtFull = (n) => Number(n || 0).toLocaleString('en-US');

function compact(n) {
  const value = Number(n || 0);
  if (value < 1000) return fmtFull(value);
  if (value < 1_000_000) return (value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (value / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

function uptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function relTime(iso) {
  const diff = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// A provider is usable when env credentials exist, when the pool holds at
// least one account, or when the endpoint needs no credential at all.
function isReady(credential) {
  return credential === 'configured' || credential === 'pool' || credential === 'open';
}

function initialOf(name) {
  return name.replace(/[^A-Za-z ]/g, '').split(/\s+/).filter(Boolean)
    .slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'P';
}

// Model rows per column. Width alone is not enough: 1280x720 and 1280x1080 have
// very different vertical room, so the row budget is the smaller of the two
// axes. A 24px deadband around each threshold keeps a window sitting exactly on
// a boundary from flipping the bucket (and re-rendering the list) repeatedly.
const DENSITY_WIDTH_STEPS = [1200, 1500];
const DENSITY_HEIGHT_STEPS = [820, 1000];
const densityState = { width: null, height: null };

function densityStep(value, thresholds, previous) {
  let index = 0;
  for (const threshold of thresholds) if (value >= threshold) index += 1;
  if (previous === null) return index;
  const margin = 24;
  // Only move up once the value clearly clears the threshold above it, and
  // only move down once it clearly drops below the one it is leaving.
  if (index > previous && value >= thresholds[previous] + margin) return index;
  if (index < previous && value < thresholds[previous - 1] - margin) return index;
  return previous;
}

function density() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const widthStep = densityStep(w, DENSITY_WIDTH_STEPS, densityState.width);
  const heightStep = densityStep(h, DENSITY_HEIGHT_STEPS, densityState.height);
  densityState.width = widthStep;
  densityState.height = heightStep;
  // Whichever axis is tighter decides; a tall narrow window still gets 6 rows.
  const step = Math.min(widthStep, heightStep);
  return { models: step === 2 ? 11 : step === 1 ? 9 : 6 };
}

// The log card has a fixed height on wide screens, so rows are trimmed to the
// space it actually has. Trimming re-reads layout on the next frame because the
// card's final height is only known once the rest of the board has settled.
let eventSource = [];

function trimEventsToColumn() {
  const list = $('eventList');
  if (!list) return;

  // Re-read the budget on every iteration: the card can still be settling, and
  // a stale budget leaves rows hanging past the card edge.
  const rows = [...list.children].filter((row) => !row.classList.contains('ghost'));
  const overflow = () => {
    const last = list.lastElementChild;
    if (!last) return 0;
    return last.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom;
  };

  let guard = rows.length + 4;
  while (rows.length > 1 && guard-- > 0) {
    if (!list.clientHeight || list.clientHeight < 60) return;
    if (overflow() <= 1) return;
    rows.pop().remove();
  }
}

function paintEvents() {
  const list = $('eventList');
  if (!list) return;

  list.innerHTML = eventSource.map(rowHtml).join('');

  // Synchronous pass (the loop forces layout), then two more on later frames
  // for the case where the card shrinks once its sibling columns settle.
  trimEventsToColumn();
  padEventsToColumn();
  requestAnimationFrame(() => {
    trimEventsToColumn();
    padEventsToColumn();
    requestAnimationFrame(() => {
      trimEventsToColumn();
      padEventsToColumn();
    });
  });
}

// A quiet router leaves the bottom of the log card blank; placeholder rows keep
// it filled with structure instead of a hollow block.
function padEventsToColumn() {
  const list = $('eventList');
  if (!list) return;

  for (const ghost of [...list.querySelectorAll('.evrow.ghost')]) ghost.remove();

  // The idle-state hints are already placeholders.
  if (list.querySelector('.evbar')) return;

  const available = list.clientHeight;
  if (!available) return;

  // The list is a flex column, so scrollHeight equals clientHeight even when
  // the rows stop short: measure where the last row actually ends.
  const used = () => {
    const last = list.lastElementChild;
    if (!last) return 0;
    return last.getBoundingClientRect().bottom - list.getBoundingClientRect().top;
  };

  const widths = [78, 62, 71, 55, 68];
  const ghosts = [];
  while (ghosts.length < 40 && used() + 24 <= available) {
    const i = ghosts.length;
    const row = document.createElement('div');
    row.className = 'evrow ghost';
    row.innerHTML = `<span class="evdot"></span>
      <div class="evbody">
        <div class="evbar" style="width:${widths[i % widths.length]}%"></div>
        <div class="evtime" style="margin-top:7px">&nbsp;</div>
      </div>`;
    list.appendChild(row);
    ghosts.push(row);
  }

  while (ghosts.length && used() > available + 1) ghosts.pop().remove();
}

function rowHtml(ev) {
  const isErr = ev.type === 'error';
  const msg = ev.message.length > 90 ? ev.message.slice(0, 90) + '…' : ev.message;
  return `<div class="evrow">
      <span class="evdot ${isErr ? 'err' : ''}"></span>
      <div class="evbody">
        <div class="evmsg">${escapeHtml(msg)}</div>
        <div class="evtime">${relTime(ev.at)}</div>
      </div>
    </div>`;
}

/* ---------------- custom select ----------------
   The dashboard avoids native chrome, but a <select> is still the value holder:
   FormData, form.elements[...].value and existing change listeners keep working.
   The native control is hidden only after the custom trigger is built, so a JS
   failure degrades to a normal dropdown instead of an empty box. */

const customSelects = new Map();

// The popup list lives on <body> (see enhanceSelect), so it is tracked beside
// the wrapper instead of being found with querySelector inside it.
function customSelectParts(wrap) {
  return {
    trigger: wrap.querySelector('.cselect-trigger'),
    list: document.querySelector(`.cselect-list[data-owner="${wrap.dataset.id}"]`),
  };
}

function customSelectLabel(select) {
  const option = select.selectedOptions?.[0];
  return option ? option.textContent.trim() : '';
}

function paintCustomSelect(select) {
  const wrap = customSelects.get(select);
  if (!wrap) return;
  const { trigger, list } = customSelectParts(wrap);
  if (!trigger || !list) return;
  const options = [...select.options];

  trigger.querySelector('.cselect-label').textContent = customSelectLabel(select) || 'Select…';
  trigger.disabled = select.disabled;
  wrap.classList.toggle('is-disabled', select.disabled);

  let lastGroup = '';
  const rows = [];
  options.forEach((option, index) => {
    const group = option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement.label : '';
    if (group && group !== lastGroup) {
      rows.push(`<li class="cselect-group" role="presentation">${escapeHtml(group)}</li>`);
      lastGroup = group;
    }
    rows.push(`<li
      class="cselect-option${option.selected ? ' is-selected' : ''}"
      role="option"
      id="${wrap.dataset.id}-opt-${index}"
      aria-selected="${option.selected}"
      data-value="${escapeHtml(option.value)}">${escapeHtml(option.textContent.trim())}</li>`);
  });
  list.innerHTML = rows.join('');
  trigger.setAttribute('aria-expanded', String(wrap.classList.contains('is-open')));
}

function closeCustomSelect(wrap, { focusTrigger = false } = {}) {
  if (!wrap) return;
  wrap.classList.remove('is-open');
  const { trigger, list } = customSelectParts(wrap);
  list?.classList.remove('is-open');
  trigger?.setAttribute('aria-expanded', 'false');
  if (focusTrigger) trigger?.focus();
}

function closeAllCustomSelects(except = null) {
  for (const wrap of customSelects.values()) {
    if (wrap !== except) closeCustomSelect(wrap);
  }
}

// The list is fixed-positioned from the trigger rect: dialogs and tables scroll
// with `overflow:auto`, and an absolutely positioned list would be clipped by
// them. Flip upward when there is not enough room below the trigger.
function positionCustomSelect(wrap) {
  const { trigger, list } = customSelectParts(wrap);
  if (!trigger || !list) return;
  const rect = trigger.getBoundingClientRect();
  const margin = 6;
  const gap = 6;
  const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
  const spaceAbove = rect.top - gap - margin;
  // Measure the real content only after the list is visible; while it is
  // display:none scrollHeight is 0 and the flip decision would be wrong.
  const contentHeight = Math.min(list.scrollHeight || 0, Math.round(window.innerHeight * 0.45), 240);
  const needed = contentHeight || 140;
  const below = spaceBelow >= needed || spaceBelow >= spaceAbove;

  list.style.minWidth = `${Math.round(rect.width)}px`;
  list.style.left = `${Math.round(rect.left)}px`;
  list.style.width = `${Math.round(rect.width)}px`;
  list.style.maxHeight = `${Math.round(Math.max(120, below ? spaceBelow : spaceAbove))}px`;
  list.style.top = below ? `${Math.round(rect.bottom + gap)}px` : 'auto';
  list.style.bottom = below ? 'auto' : `${Math.round(window.innerHeight - rect.top + gap)}px`;
}

function openCustomSelect(wrap) {
  closeAllCustomSelects(wrap);
  wrap.classList.add('is-open');
  const { trigger, list } = customSelectParts(wrap);
  if (!trigger || !list) return;
  list.classList.add('is-open');
  trigger.setAttribute('aria-expanded', 'true');
  // Two passes: the first makes the list visible so scrollHeight is real, the
  // second places it using that measurement.
  positionCustomSelect(wrap);
  positionCustomSelect(wrap);
  const selected = list.querySelector('.cselect-option.is-selected') || list.querySelector('.cselect-option');
  if (selected) {
    selected.scrollIntoView({ block: 'nearest' });
    trigger.setAttribute('aria-activedescendant', selected.id);
  }
}

function moveCustomSelect(wrap, delta) {
  const { trigger, list } = customSelectParts(wrap);
  if (!list || !trigger) return;
  const options = [...list.querySelectorAll('.cselect-option')];
  if (!options.length) return;
  const current = options.findIndex((option) => option.classList.contains('is-hover'));
  const nextIndex = current === -1
    ? (delta > 0 ? 0 : options.length - 1)
    : (current + delta + options.length) % options.length;
  options.forEach((option) => option.classList.remove('is-hover'));
  options[nextIndex].classList.add('is-hover');
  options[nextIndex].scrollIntoView({ block: 'nearest' });
  trigger.setAttribute('aria-activedescendant', options[nextIndex].id);
}

function chooseCustomSelect(wrap, value) {
  const select = wrap.querySelector('select');
  if (select.value !== value) {
    select.value = value;
    // Existing change listeners (pagination, token unit, account kind) rely on
    // this event, so the custom control must emit the same one a native pick would.
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (select.id === 'chatModel') {
    chatSelectionWarning = '';
    const connection = $('chatConnection');
    if (connection && chatCatalog.length) {
      connection.className = 'chip chip-ok';
      connection.textContent = `${chatCatalog.length} models ready`;
    }
  }
  paintCustomSelect(select);
  closeCustomSelect(wrap, { focusTrigger: true });
}

function enhanceSelect(select, index) {
  if (select.dataset.customReady === 'true') return;
  const wrap = document.createElement('div');
  wrap.className = 'cselect';
  wrap.dataset.id = `cselect-${index}`;
  // Carry the old sizing class onto the wrapper so the compact pagination pill
  // keeps its shape now that the real control is the trigger button.
  if (select.classList.contains('aselect')) wrap.classList.add('aselect-wrap');
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);
  select.dataset.customReady = 'true';
  select.classList.add('cselect-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'cselect-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', select.getAttribute('aria-label') || 'Choose an option');
  trigger.innerHTML = '<span class="cselect-label"></span><span class="cselect-caret" aria-hidden="true">▾</span>';
  wrap.appendChild(trigger);

  const list = document.createElement('ul');
  list.className = 'cselect-list';
  list.setAttribute('role', 'listbox');
  if (select.getAttribute('aria-label')) list.setAttribute('aria-label', select.getAttribute('aria-label'));
  // The list lives on <body>, not inside the wrapper: a dialog animates with
  // `animation-fill-mode: both`, which makes it the containing block for
  // position:fixed descendants and would clip the list to the dialog box.
  list.dataset.owner = wrap.dataset.id;
  document.body.appendChild(list);
  customSelects.set(select, wrap);
  paintCustomSelect(select);

  trigger.addEventListener('click', () => {
    if (select.disabled) return;
    if (wrap.classList.contains('is-open')) closeCustomSelect(wrap, { focusTrigger: true });
    else openCustomSelect(wrap);
  });

  trigger.addEventListener('keydown', (event) => {
    if (select.disabled) return;
    const open = wrap.classList.contains('is-open');
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openCustomSelect(wrap);
      moveCustomSelect(wrap, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) {
        openCustomSelect(wrap);
        return;
      }
      const { list } = customSelectParts(wrap);
      const hovered = list?.querySelector('.cselect-option.is-hover') || list?.querySelector('.cselect-option.is-selected');
      if (hovered) chooseCustomSelect(wrap, hovered.dataset.value);
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeCustomSelect(wrap, { focusTrigger: true });
    }
  });

  list.addEventListener('click', (event) => {
    const option = event.target.closest('.cselect-option');
    if (option) chooseCustomSelect(wrap, option.dataset.value);
  });

  // A native change (programmatic .value assignment from another module, or a
  // form reset) must repaint the trigger label and the option list.
  select.addEventListener('change', () => paintCustomSelect(select));
}

function syncCustomSelects() {
  for (const [select, wrap] of customSelects) paintCustomSelect(select, wrap);
}

document.querySelectorAll('select[data-custom-select]').forEach((select, index) => enhanceSelect(select, index));
document.addEventListener('click', (event) => {
  // Options live on <body>, so a click on one must not count as "outside".
  if (!event.target.closest('.cselect') && !event.target.closest('.cselect-list')) closeAllCustomSelects();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeAllCustomSelects();
});
window.addEventListener('resize', () => {
  for (const wrap of customSelects.values()) {
    if (wrap.classList.contains('is-open')) positionCustomSelect(wrap);
  }
});
// form.reset() restores native values without firing `change`, so repaint after
// the reset has been applied.
document.addEventListener('reset', () => {
  queueMicrotask(syncCustomSelects);
}, true);

/* ---------------- appearance ---------------- */

const appearance = {
  theme: document.documentElement.dataset.theme || 'light',
  accent: document.documentElement.dataset.accent || 'violet',
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
  if (accentNote) accentNote.textContent = appearance.accent;
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
});
$('tokenSaverPonytail')?.addEventListener('change', (event) => {
  patchTokenSaver({ ponytail: { enabled: event.currentTarget.checked } });
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
    appearance.accent = 'violet';
    saveAppearance();
    applyAppearance();
  });
}

/* ---------------- router ---------------- */

const DETAIL_PREFIX = '/providers/';

let currentPath = '/';
let currentDetailId = null;
let latest = null;
let detail = null;
let detailState = 'idle';
let detailError = '';
let routeTransitionId = 0;
let dashboardUsageRange = 'day';
let dashboardUsageData = null;
let dashboardUsageRequestId = 0;
let dashboardApiKeySecret = '';
let settingsTab = 'general';
let dashboardAuth = { enabled: false, hasPassword: false, configuredAt: null };
let tokenSaver = { ponytail: { enabled: false } };
let tokenSaverLoading = false;
let replyFilters = { language: 'auto', verbosity: 'balanced', coding: false };
let replyFiltersLoading = false;
let replyLanguageTrigger = null;
let booting = true;
let apiKeys = [];
let apiKeySecret = '';
let editingApiKeyId = '';
let usageRange = 'day';
let usageData = null;
let usageState = 'idle';
let usageError = '';
let usageLastUpdated = 0;
let usageSignature = '';
let usageChartSignature = '';
let usageRequestId = 0;
let usageModelPage = 1;
let usageActivityPage = 1;
let usageRenderPagerKey = '';
const USAGE_CHART_KEY = 'norouter.usageChart';
const USAGE_CHART_TYPES = ['heatmap', 'bars', 'line', 'area'];
function readUsageChartType() {
  try {
    const stored = localStorage.getItem(USAGE_CHART_KEY);
    return USAGE_CHART_TYPES.includes(stored) ? stored : 'heatmap';
  } catch {
    return 'heatmap';
  }
}
let usageChartType = readUsageChartType();
const dashboardRenderSignatures = new Map();
const PROVIDER_QUOTA_REFRESH_MS = 30_000;
let providerQuotaRefreshing = false;
let providerQuotaLastRefresh = 0;

function dashboardSignature(key, value) {
  const signature = JSON.stringify(value);
  if (dashboardRenderSignatures.get(key) === signature) return false;
  dashboardRenderSignatures.set(key, signature);
  return true;
}

function isDetailPath(path) {
  return path.startsWith(DETAIL_PREFIX) && path.length > DETAIL_PREFIX.length;
}

function detailIdFrom(path) {
  return decodeURIComponent(path.slice(DETAIL_PREFIX.length).split('?')[0]);
}

function normalize(path) {
  if (!path || path === '/dashboard') return '/';
  const trimmed = path.replace(/\/+$/, '') || '/';
  return ROUTES[trimmed] ? trimmed : '/';
}

function motionReduced() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches || false;
}

function showPage(targetSection) {
  document.querySelectorAll('.page').forEach((section) => {
    section.classList.remove('route-enter', 'route-leave');
    section.hidden = section !== targetSection;
  });
}

function settlePageTransition(targetSection) {
  showPage(targetSection);
  document.querySelectorAll('.page').forEach((section) => {
    section.style.viewTransitionName = '';
  });
}

function transitionPages(pageKey, update, { animate = !booting } = {}) {
  const sections = [...document.querySelectorAll('.page')];
  const targetSection = sections.find((section) => section.dataset.page === pageKey);
  if (!targetSection) return;

  const apply = () => {
    update?.();
    settlePageTransition(targetSection);
  };
  if (!animate || motionReduced() || typeof document.startViewTransition !== 'function') {
    apply();
    return;
  }

  const currentSection = sections.find((section) => !section.hidden && section !== targetSection);
  if (!currentSection) {
    apply();
    return;
  }
  currentSection.style.viewTransitionName = 'route-page';
  targetSection.style.viewTransitionName = 'route-page';
  const transitionId = ++routeTransitionId;
  const transition = document.startViewTransition(() => {
    if (transitionId === routeTransitionId) {
      showPage(targetSection);
      update?.();
    }
  });
  transition.finished.catch(() => {}).finally(() => {
    if (transitionId === routeTransitionId) settlePageTransition(targetSection);
  });
}

function navigate(path, { push = true, initial = false } = {}) {
  if (!isDetailPath(String(path || '/'))) closeAccountModal();
  const raw = String(path || '/');
  const onDetail = isDetailPath(raw);
  const target = onDetail ? raw.replace(/\/+$/, '') : normalize(raw);

  currentPath = target;
  currentDetailId = onDetail ? detailIdFrom(target) : null;
  if (!onDetail || detail?.provider?.id !== currentDetailId) {
    detail = null;
    detailState = 'idle';
  }
  if (push && location.pathname !== target) history.pushState({}, '', target);

  const route = ROUTES[target] || ROUTES['/'];
  $('pageTitle').textContent = onDetail ? (detail?.provider?.name || 'Provider') : route.title;
  $('tagline').textContent = onDetail
    ? 'Accounts, quota and models for this upstream.'
    : route.sub;
  $('topbarConnect').hidden = onDetail ? true : !route.copy;

  const pageKey = onDetail ? 'detail' : target;
  const updateRoute = () => {
    transitionPages(pageKey, () => {
      document.querySelectorAll('.rail-nav a').forEach((link) => {
        link.classList.toggle('is-active', normalize(link.dataset.route) === (onDetail ? '/providers' : target));
      });
      renderCurrent();
    }, { animate: !initial && !booting });
  };

  // Keep the app shell outside the transition. A document-level View Transition
  // snapshots the rail and topbar too, which makes them flash on every route.
  // transitionPages animates only the main `.page` sections.
  updateRoute();
  if (onDetail) loadDetail();
  if (target === '/api-keys') loadApiKeys();
  if (target === '/settings') loadTokenSaver();
  if (target === '/usage') loadUsage();
  if (target === '/chat') loadChat();
  if (target === '/combos') loadCombos();
  if (target === '/') loadDashboardApiKey();
}

// Every internal link goes through the router, including the provider cards.
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href^="/"]');
  if (!link) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  if (link.target === '_blank' || link.hasAttribute('download')) return;
  event.preventDefault();
  navigate(link.getAttribute('href'));
});

window.addEventListener('popstate', () => navigate(location.pathname, { push: false }));

/* ---------------- dashboard ---------------- */

const DASHBOARD_RANGE_LABELS = { day: 'today', week: 'this week', month: 'this month', all: 'all time' };

function renderDashboardHistorical(report) {
  const totals = report?.totals || {};
  const label = DASHBOARD_RANGE_LABELS[dashboardUsageRange] || dashboardUsageRange;
  const total = Number(totals.requests || 0) + Number(totals.errors || 0);
  const empty = total === 0 && Number(totals.tokensIn || 0) === 0 && Number(totals.tokensOut || 0) === 0;
  const source = $('dashboardHistoryRange');
  if (source) source.textContent = label;
  for (const id of ['dashboardHistoryIn', 'dashboardHistoryOut', 'dashboardHistoryErrors', 'dashboardHistoryRequests']) {
    const value = id.endsWith('In') ? totals.tokensIn : id.endsWith('Out') ? totals.tokensOut : id.endsWith('Errors') ? totals.errors : totals.requests;
    if ($(id)) $(id).textContent = empty ? '—' : compact(value);
  }
  if ($('dashboardHistorySuccess')) $('dashboardHistorySuccess').textContent = empty || totals.successRate == null ? '—' : `${totals.successRate}%`;
  const note = empty ? `No usage yet for ${label}.` : label;
  if ($('dashboardHistoryStatsNote')) $('dashboardHistoryStatsNote').textContent = note;
  if ($('dashboardHistoryRequestsNote')) $('dashboardHistoryRequestsNote').textContent = note;
}

function renderStatistics(data, report = dashboardUsageData) {
  const totals = report?.totals || {};
  const label = DASHBOARD_RANGE_LABELS[dashboardUsageRange] || dashboardUsageRange;
  $('statRangeChip').textContent = label;
  $('statIn').textContent = compact(totals.tokensIn);
  $('statIn').title = `${fmtFull(totals.tokensIn)} tokens ${label}`;
  $('statOut').textContent = compact(totals.tokensOut);
  $('statOut').title = `${fmtFull(totals.tokensOut)} tokens ${label}`;
  $('statLatency').textContent = totals.avgMs == null ? '—' : `${totals.avgMs} ms`;
  $('statErrors').textContent = fmtFull(totals.errors);
}

// Sparkline: bars are decorative, so the chart carries a text summary that is
// readable without hover or a pointer. Bars keep their title for mouse users,
// and aria-hidden stops screen readers announcing 40 meaningless spans.
function sparkSummary(history) {
  if (!history.length) return 'No requests recorded yet.';
  const ok = history.filter((h) => h.ok);
  const failed = history.length - ok.length;
  const waited = ok.filter((h) => typeof h.ms === 'number' && h.ms > 0).map((h) => h.ms);
  const avg = waited.length ? Math.round(waited.reduce((sum, ms) => sum + ms, 0) / waited.length) : null;
  const parts = [
    `${history.length} recent request${history.length === 1 ? '' : 's'}`,
    failed ? `${failed} failed` : 'no failures',
  ];
  if (avg != null) parts.push(`${avg} ms average`);
  return `${parts.join(' · ')}.`;
}

function sparkMarkup(history) {
  if (!history.length) {
    return '<div class="spark-empty">No requests yet — send one to /v1 to see the chart.</div>';
  }
  const weights = history.map((h) => Math.max(h.tokens, h.ms / 10, 1));
  const max = Math.max(...weights);
  const bars = history.map((h, i) => {
    const pct = Math.max(6, Math.round((weights[i] / max) * 100));
    const cls = h.ok ? '' : ' is-err';
    const label = h.ok ? `${h.ms} ms · ${h.tokens} tok` : 'failed';
    return `<span class="${cls}" style="height:${pct}%" title="${label}"></span>`;
  }).join('');
  // The container keeps role="img", which already hides the bars from the
  // accessibility tree; the text summary below the chart is the readable path.
  return bars;
}

function renderRequests(data, report = dashboardUsageData) {
  const totals = report?.totals || {};
  const rangeLabel = DASHBOARD_RANGE_LABELS[dashboardUsageRange] || dashboardUsageRange;
  $('reqRangeChip').textContent = rangeLabel;
  $('statRequests').textContent = compact(totals.requests);
  $('statRequests').title = `${fmtFull(totals.requests)} persisted requests`;
  $('uptimeChip').textContent = `up ${uptime(data.uptimeSeconds)}`;

  $('successChip').textContent = totals.successRate == null ? 'no traffic' : `${totals.successRate}% success`;
  $('successChip').className = totals.successRate == null
    ? 'chip chip-quiet'
    : totals.successRate >= 95 ? 'chip chip-ok' : 'chip chip-bad';

  $('inOutChip').textContent = totals.requests === 0
    ? 'waiting for first call'
    : `${compact(totals.tokensIn)} in / ${compact(totals.tokensOut)} out`;

  const history = (report?.series || []).map((bucket) => ({
    ms: bucket.requests ? 0 : 0,
    tokens: Number(bucket.tokensIn || 0) + Number(bucket.tokensOut || 0),
    ok: Number(bucket.errors || 0) === 0,
  }));
  if (dashboardSignature('dashboard.spark', report?.series || [])) $('spark').innerHTML = sparkMarkup(history);
  const summary = totals.requests ? `${fmtFull(totals.requests)} persisted requests · ${totals.successRate ?? 0}% success.` : 'No requests recorded yet.';
  $('sparkSummary').textContent = summary;
  $('spark').setAttribute('aria-label', summary);
  $('sparkWindow').textContent = report?.series?.length ? `${report.series.length} buckets` : 'no history';
}

function renderModels(data, report = dashboardUsageData) {
  const models = report?.models || [];
  $('modelCount').textContent = `${models.length} used`;
  const list = $('modelList');
  const limit = density().models;

  if (!models.length) {
    if (dashboardSignature('dashboard.models', { limit, models: [] })) list.innerHTML = `<div class="list-empty">
      <strong>No model traffic yet</strong>
      <span>Send a request to /v1; per-model token bars appear here.</span>
    </div>`;
    trimModelsToCard();
    return;
  }

  const modelSignature = { limit, models: models.map((m) => [m.model, m.requests, m.tokensIn, m.tokensOut]) };
  if (!dashboardSignature('dashboard.models', modelSignature)) return trimModelsToCard();
  const peak = Math.max(...models.map((m) => m.tokensIn + m.tokensOut), 1);
  list.innerHTML = models.slice(0, limit).map((m) => {
    const total = m.tokensIn + m.tokensOut;
    const width = Math.max(4, Math.round((total / peak) * 100));
    return `<div class="mrow">
      <div class="mrow-top">
        <span class="mname" title="${escapeHtml(m.model)}">${escapeHtml(m.model)}</span>
        <span class="mval">${m.requests} req · ${compact(total)} tok</span>
      </div>
      <div class="mtrack"><div class="mfill" style="width:${width}%"></div></div>
    </div>`;
  }).join('');
  staggerChildren(list, '.mrow', `models:${models.map((model) => model.model).join('|')}`);

  trimModelsToCard();
}

// The card has a fixed height on wide screens, so rows that do not fit are
// dropped instead of being clipped mid-bar.
function trimModelsToCard() {
  const list = $('modelList');
  if (!list) return;
  const rows = [...list.querySelectorAll('.mrow')];
  let guard = rows.length + 4;
  while (rows.length > 1 && guard-- > 0) {
    const available = list.clientHeight;
    if (!available || available < 60) return;
    if (list.scrollHeight <= available + 1) return;
    rows.pop().remove();
  }
}

function renderEvents(data, report = dashboardUsageData) {
  const persisted = (report?.activity || []).map((item) => ({
    at: item.at,
    type: item.ok ? 'request' : 'error',
    message: item.ok
      ? `${item.model || 'unknown'} · ${item.tokensIn + item.tokensOut} tok · ${item.ms ?? '?'} ms`
      : `${item.model || 'unknown'} · request failed${item.error ? ` · ${item.error}` : ''}`,
  }));
  const active = (data.active || []).map((item) => ({
    at: item.at,
    type: 'request',
    message: `${item.model || 'unknown'} · ${item.tokensIn + item.tokensOut} tok · ${item.ms ?? '?'} ms · streaming`,
  }));
  const rows = [...active, ...persisted];
  $('eventCount').textContent = `${rows.length}`;

  if (!rows.length) {
    eventSource = [];
    if (!dashboardSignature('dashboard.events', [])) return;
    $('eventList').innerHTML = `<div class="list-empty">
      <strong>No activity yet</strong>
      <span>Every request and error is logged here. Point a client at /v1 to begin.</span>
    </div>`;
    return;
  }

  const eventSignature = rows.map((event) => [event.at, event.type, event.message]);
  if (!dashboardSignature('dashboard.events', eventSignature)) return;
  eventSource = rows;
  paintEvents();
}

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
    "        \\\"messages\\\":[{\\\"role\\\":\\\"user\\\",\\\"content\\\":\\\"halo\\\"}]}'",
  ].join('\\n');
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
          <div class="pcard-sub"><code>${escapeHtml(prefix)}</code><span>·</span>${escapeHtml(p.format)} compatible</div>
        </div>
        <span class="status-pill ${ready ? 'ok' : 'bad'}"><span class="dot"></span>${ready ? 'Ready' : 'No account'}</span>
      </div>
      <div class="pcard-summary">
        <span><strong>${p.accounts || 0}</strong> ${p.accounts === 1 ? 'account' : 'accounts'}</span>
        <span><strong>${p.models}</strong> models</span>
      </div>
      <div class="pcard-quota${quotaLoading ? ' is-loading' : ''}" title="${escapeHtml(quotaTitle)}">
        <div class="pcard-quota-label"><span>Quota</span><strong>${quotaLabel}</strong></div>
        <div class="pcard-quota-track" role="progressbar" aria-label="${escapeHtml(p.name)} quota used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${quotaKnown ? quotaPercent : 0}"><span style="width:${quotaKnown ? quotaPercent : 0}%"></span></div>
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
        <p class="pcard-sub">Add an [OI]-compatible endpoint to route requests through it.</p>
      </article>`;

  host.innerHTML = empty + data.providers.map(card).join('') + `<button class="pcard-add" id="openAddProvider" type="button">
    <span class="pcard-add-icon" aria-hidden="true">+</span>
    <strong>Add a provider</strong>
    <span>Any [OI]-compatible endpoint works, including a local server.</span>
  </button>`;
  staggerChildren(host, '.pcard, .pcard-add', `providers:${data.providers.map((p) => p.id).join('|')}`);

  const count = $('pgCount');
  if (count) {
    count.textContent = `${data.providers.length} total`;
    count.title = `${data.providers.length} provider${data.providers.length === 1 ? '' : 's'}`;
  }

  $('openAddProvider')?.addEventListener('click', () => {
    const card = $('addProviderCard');
    card.hidden = false;
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    $('addProviderForm')?.querySelector('input[name="name"]')?.focus();
  });

  renderCurlExample(data.providers);
}

/* ---------------- chat page ---------------- */

let chatCatalog = [];
let chatMessages = [];
let chatSessions = [];
let activeChatSessionId = '';
let chatAttachments = [];
let chatAbortController = null;
let chatBusy = false;
let chatLoadId = 0;
let chatSelectionWarning = '';

function chatModelKey(provider, model) {
  return `${provider.prefix}/${model}`;
}

function buildChatCatalog(status, comboBody) {
  const active = new Map();
  const providersByName = new Map();
  for (const provider of status.providers || []) {
    providersByName.set(provider.id, provider);
    providersByName.set(provider.prefix, provider);
    if (!isReady(provider.credential)) continue;
    const models = Array.isArray(provider.modelIds) ? provider.modelIds : [];
    active.set(provider.id, { ...provider, modelIds: models });
  }

  const combos = [];
  for (const combo of comboBody.combos || []) {
    const activeModels = combo.models.filter((model) => {
      const slash = model.indexOf('/');
      if (slash < 1) return false;
      const provider = providersByName.get(model.slice(0, slash));
      return provider && active.has(provider.id) && active.get(provider.id).modelIds.includes(model.slice(slash + 1));
    });
    if (activeModels.length) combos.push({ value: combo.name, label: combo.name, kind: 'combo', models: activeModels });
  }

  const models = [];
  for (const provider of active.values()) {
    for (const model of provider.modelIds) {
      models.push({
        value: chatModelKey(provider, model),
        label: model,
        group: provider.name || provider.prefix,
        kind: 'model',
      });
    }
  }
  return [...combos, ...models];
}

function paintChatCatalog() {
  const select = $('chatModel');
  const empty = $('chatEmpty');
  const transcript = $('chatTranscript');
  const composer = $('chatComposer');
  if (!select) return;

  const previous = select.value;
  select.replaceChildren();
  const comboGroup = document.createElement('optgroup');
  comboGroup.label = 'Combos';
  for (const item of chatCatalog.filter((entry) => entry.kind === 'combo')) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    comboGroup.append(option);
  }
  if (comboGroup.children.length) select.append(comboGroup);

  const groups = new Map();
  for (const item of chatCatalog.filter((entry) => entry.kind === 'model')) {
    if (!groups.has(item.group)) {
      const group = document.createElement('optgroup');
      group.label = item.group;
      groups.set(item.group, group);
      select.append(group);
    }
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    groups.get(item.group).append(option);
  }

  const stillAvailable = chatCatalog.some((item) => item.value === previous);
  if (stillAvailable) select.value = previous;
  else if (previous) chatSelectionWarning = 'The selected model is no longer active. Choose another model.';
  select.disabled = chatCatalog.length === 0 || chatBusy;
  paintCustomSelect(select);
  if (empty) empty.hidden = chatCatalog.length > 0;
  if (transcript) transcript.hidden = chatCatalog.length === 0;
  if (composer) composer.hidden = chatCatalog.length === 0;
  const connection = $('chatConnection');
  if (connection) {
    connection.className = chatCatalog.length ? 'chip chip-ok' : 'chip chip-bad';
    connection.textContent = chatSelectionWarning || (chatCatalog.length ? `${chatCatalog.length} models ready` : 'No active models');
  }
}

function paintChatKeyPanel() {
  const panel = $('chatKeyPanel');
  if (panel) panel.hidden = false;
}

function chatDisplayText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content.map((part) => part.type === 'text' ? part.text : `[${part.type === 'image_url' ? 'image' : 'attachment'}]`).join('\n');
}

// A user who has scrolled back to read earlier messages keeps their place while
// streaming; only a viewer already at the bottom follows new text down. The
// transcript may report 0 height when hidden (display:none), which is treated
// as "at bottom" so the first visible paint is correct.
function chatNearBottom() {
  const transcript = $('chatTranscript');
  if (!transcript) return true;
  const max = transcript.scrollHeight - transcript.clientHeight;
  if (max <= 0) return true;
  return transcript.scrollTop >= max - 40;
}

function chatScrollToBottom() {
  const transcript = $('chatTranscript');
  if (!transcript) return;
  transcript.scrollTop = transcript.scrollHeight;
}

function chatBubble(role, content = '') {
  const article = document.createElement('article');
  article.className = `chat-message chat-${role}`;
  const label = document.createElement('div');
  label.className = 'chat-role';
  label.textContent = role === 'user' ? 'You' : 'Assistant';
  const body = document.createElement('div');
  body.className = 'chat-message-body';
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'image_url' && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(part.image_url?.url || '')) {
        const image = document.createElement('img');
        image.className = 'chat-image';
        image.alt = 'Attached image';
        image.src = part.image_url.url;
        body.append(image);
      } else if (part.type === 'text') {
        const text = document.createElement('span');
        text.textContent = part.text || '';
        body.append(text);
      }
    }
  } else {
    body.textContent = chatDisplayText(content);
  }
  article.append(label, body);
  return { article, body };
}

let chatSessionQuery = null;
let chatSessionRenderedIds = '';

function renderChatSessions() {
  const host = $('chatSessionList');
  if (!host) return;
  const query = ($('chatSessionSearch')?.value || '').trim().toLowerCase();
  const rows = chatSessions.filter((session) => !query || session.title.toLowerCase().includes(query));
  const idsKey = rows.map((session) => session.id).join('|');

  // Same sessions in the same order (a title rename or an active change): patch
  // in place instead of rebuilding, so the sidebar keeps its scroll position.
  if (rows.length > 0 && chatSessionQuery === query && chatSessionRenderedIds === idsKey && host.children.length === rows.length) {
    rows.forEach((session, index) => {
      const row = host.children[index];
      if (!row) return;
      row.dataset.sessionId = session.id;
      row.classList.toggle('is-active', session.id === activeChatSessionId);
      const title = row.querySelector('.chat-session-title');
      if (title && title.textContent !== session.title) {
        title.textContent = session.title;
        title.title = session.title;
      }
      const rename = row.querySelector('.chat-session-rename');
      if (rename) rename.setAttribute('aria-label', `Rename ${session.title}`);
      const del = row.querySelector('.chat-session-delete');
      if (del) del.setAttribute('aria-label', `Delete ${session.title}`);
    });
    return;
  }

  chatSessionQuery = query;
  chatSessionRenderedIds = idsKey;
  const scrollTop = host.scrollTop;
  host.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-session-empty';
    empty.textContent = query ? 'No matching chats.' : 'No saved chats yet.';
    host.append(empty);
    return;
  }
  for (const session of rows) {
    const row = document.createElement('div');
    row.className = `chat-session${session.id === activeChatSessionId ? ' is-active' : ''}`;
    row.dataset.sessionId = session.id;
    row.setAttribute('role', 'listitem');
    const button = document.createElement('button');
    button.className = 'chat-session-title';
    button.type = 'button';
    button.textContent = session.title;
    button.title = session.title;
    button.addEventListener('click', () => openChatSession(session.id));
    const rename = document.createElement('button');
    rename.className = 'chat-session-rename';
    rename.type = 'button';
    rename.setAttribute('aria-label', `Rename ${session.title}`);
    rename.textContent = '✎';
    rename.addEventListener('click', () => renameChatSessionUi(session));
    const del = document.createElement('button');
    del.className = 'chat-session-delete';
    del.type = 'button';
    del.setAttribute('aria-label', `Delete ${session.title}`);
    del.textContent = '×';
    del.addEventListener('click', () => deleteChatSessionUi(session));
    row.append(button, rename, del);
    host.append(row);
  }
  // A genuine reorder/add/remove still tries to keep the user's place in the list.
  host.scrollTop = scrollTop;
}

async function createChatSessionUi(model = '') {
  const response = await fetch('/api/chat/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || 'Could not create chat.');
  chatSessions.unshift(body.session);
  activeChatSessionId = body.session.id;
  chatMessages = [];
  renderChatSessions();
  renderChatTranscript();
}

async function loadChatSessions() {
  const response = await fetch('/api/chat/sessions', { cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || 'Could not load chat history.');
  chatSessions = body.sessions || [];
  if (!activeChatSessionId || !chatSessions.some((session) => session.id === activeChatSessionId)) {
    if (chatSessions[0]) activeChatSessionId = chatSessions[0].id;
    else await createChatSessionUi($('chatModel')?.value || '');
  }
  renderChatSessions();
  if (activeChatSessionId) await openChatSession(activeChatSessionId, { quiet: true });
}

async function openChatSession(id, { quiet = false } = {}) {
  activeChatSessionId = id;
  renderChatSessions();
  const response = await fetch(`/api/chat/sessions/${encodeURIComponent(id)}`, { cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || 'Could not open chat.');
  chatMessages = (body.messages || []).map((message) => ({ role: message.role, content: message.content, reasoning: message.reasoning || '', status: message.status === 'complete' ? '' : message.status }));
  if (body.session.model && chatCatalog.some((item) => item.value === body.session.model)) {
    $('chatModel').value = body.session.model;
    paintCustomSelect($('chatModel'));
  }
  renderChatTranscript();
  if (!quiet) $('chatInput')?.focus();
}

async function renameChatSessionUi(session) {
  const host = $('chatSessionList');
  const row = [...(host?.children || [])].find((item) => item.querySelector(`[aria-label="Rename ${CSS.escape(session.title)}"]`));
  if (!row) return;
  const input = document.createElement('input');
  input.className = 'chat-session-rename-input';
  input.value = session.title;
  input.maxLength = 120;
  const save = document.createElement('button');
  save.className = 'chat-session-rename-save';
  save.type = 'button';
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.className = 'chat-session-rename-cancel';
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  row.replaceChildren(input, save, cancel);
  input.focus();
  input.select();
  const close = async (commit) => {
    if (!commit) return renderChatSessions();
    const title = input.value.trim();
    if (!title || title === session.title) return renderChatSessions();
    const response = await fetch(`/api/chat/sessions/${encodeURIComponent(session.id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }),
    });
    if (response.ok) session.title = title.slice(0, 120);
    renderChatSessions();
  };
  save.addEventListener('click', () => close(true));
  cancel.addEventListener('click', () => close(false));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') close(true);
    if (event.key === 'Escape') close(false);
  });
}

async function deleteChatSessionUi(session) {
  openConfirmation({
    title: 'Delete chat?',
    message: `${session.title} and its messages will be removed from this dashboard.`,
    confirmLabel: 'Delete chat',
    danger: true,
    run: async () => {
      const response = await fetch(`/api/chat/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not delete chat.');
      chatSessions = chatSessions.filter((item) => item.id !== session.id);
      if (activeChatSessionId === session.id) {
        activeChatSessionId = '';
        if (chatSessions[0]) await openChatSession(chatSessions[0].id);
        else await createChatSessionUi($('chatModel')?.value || '');
      }
      renderChatSessions();
    },
  });
}

async function persistChatMessage(message) {
  if (!activeChatSessionId) return;
  const response = await fetch(`/api/chat/sessions/${encodeURIComponent(activeChatSessionId)}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: message.role, content: message.content, reasoning: message.reasoning || '', status: message.status || 'complete', model: $('chatModel')?.value || '' }),
  });
  if (!response.ok) throw new Error('Could not save chat message.');
}

function chatMessageState(status) {
  if (!status) return null;
  const state = document.createElement('span');
  state.className = `chat-message-state ${status}`;
  state.textContent = status;
  return state;
}

function chatThinkingNode(reasoning, live = false) {
  const thinking = document.createElement('details');
  thinking.className = live ? 'chat-thinking chat-thinking-live' : 'chat-thinking';
  const summary = document.createElement('summary');
  summary.textContent = 'Thinking';
  const body = document.createElement('div');
  body.className = 'chat-thinking-body';
  body.textContent = reasoning || '';
  thinking.append(summary, body);
  return thinking;
}

// Full rebuild is only for a different session, opening chat, or reload. It
// must never run during streaming, or the focus and text selection jump and the
// scroll position resets while the user reads.
function renderChatTranscript() {
  const transcript = $('chatTranscript');
  if (!transcript) return;
  transcript.replaceChildren();
  if (!chatMessages.length) {
    const welcome = document.createElement('div');
    welcome.className = 'chat-welcome';
    const mark = document.createElement('span');
    mark.className = 'chat-welcome-mark';
    mark.textContent = 'N';
    const title = document.createElement('strong');
    title.textContent = 'Start a conversation';
    const hint = document.createElement('span');
    hint.textContent = 'Send a message to the selected model through your local router.';
    welcome.append(mark, title, hint);
    transcript.append(welcome);
    return;
  }
  for (const message of chatMessages) {
    const bubble = chatBubble(message.role, message.content);
    if (message.reasoning) {
      bubble.article.insertBefore(chatThinkingNode(message.reasoning), bubble.article.querySelector('.chat-message-body'));
    }
    const state = chatMessageState(message.status);
    if (state) bubble.article.append(state);
    transcript.append(bubble.article);
  }
  chatScrollToBottom();
}

function resizeChatInput() {
  const input = $('chatInput');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
}

async function prepareChatImage(file) {
  const source = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  // Keep stored history and request bodies bounded. Downscale only images; text
  // attachments stay exact and are capped by their character limit below.
  if (file.size <= 220 * 1024) return source;
  const image = await new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = reject;
    element.src = source;
  });
  const scale = Math.min(1, 1280 / image.width, 1280 / image.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', .78);
}

function chatErrorMessage(status, body = {}) {
  const retryAt = body.error?.retry_at;
  if (status === 400) return 'The selected model does not accept this request. Choose another model or simplify the message.';
  if (status === 401) return 'This request needs a valid API key. Save one above, then try again.';
  if (status === 429) return retryAt ? `The model is cooling down or rate-limited until ${new Date(retryAt).toLocaleString()}.` : 'The model is cooling down or rate-limited. Try again shortly or choose another model.';
  if (status === 503) return 'Every model in this combo failed. Choose another model or check the provider accounts.';
  if (status >= 500) return 'The upstream provider could not complete the request. Try again or choose another model.';
  return 'The router could not complete this request. Try again.';
}

function applyChatFrame(data, assistant) {
  if (data?.error) {
    assistant.status = 'error';
    assistant.error = true;
    return { error: true };
  }
  const delta = data?.choices?.[0]?.delta;
  if (typeof delta?.content === 'string') assistant.content += delta.content;
  if (typeof delta?.reasoning_content === 'string') assistant.reasoning += delta.reasoning_content;
  return { error: false };
}

async function streamChat(response, assistant, bodyNode, thinkingNode, onDelta) {
  if (!response.body) throw new Error('The router returned no stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamError = null;
  const consumeLine = (line) => {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed.startsWith('data:')) return false;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') return true;
    if (!payload) return false;
    try {
      const result = applyChatFrame(JSON.parse(payload), assistant);
      if (result.error) streamError = 'The upstream provider returned an error while streaming.';
      bodyNode.textContent = assistant.content || (streamError ? streamError : '…');
      if (assistant.reasoning) {
        thinkingNode.hidden = false;
        thinkingNode.querySelector('.chat-thinking-body').textContent = assistant.reasoning;
      }
      onDelta?.();
    } catch {
      streamError = 'The router returned an invalid stream frame.';
      assistant.status = 'error';
      bodyNode.textContent = streamError;
      onDelta?.();
    }
    return false;
  };
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      if (consumeLine(buffer.slice(0, index))) return;
      buffer = buffer.slice(index + 1);
    }
    if (done) break;
  }
  buffer += decoder.decode();
  if (buffer) consumeLine(buffer);
  if (streamError) throw new Error(streamError);
}

async function sendChatMessage() {
  if (chatBusy || !chatCatalog.length) return;
  const input = $('chatInput');
  const text = input?.value.trim() || '';
  if (!text) return;
  const model = $('chatModel')?.value;
  if (!model) return;
  let userContent = text;
  if (chatAttachments.length) {
    const parts = [{ type: 'text', text }];
    for (const attachment of chatAttachments) {
      if (attachment.size > 5 * 1024 * 1024) {
        if ($('chatNote')) $('chatNote').textContent = `${attachment.name} is larger than 5 MB.`;
        return;
      }
      if (attachment.type.startsWith('image/')) {
        const data = await prepareChatImage(attachment.file);
        parts.push({ type: 'image_url', image_url: { url: data } });
      } else if (attachment.file.type.startsWith('text/') || /\.(md|json|csv|js|ts|py|java|c|cpp|html|css)$/i.test(attachment.name)) {
        const content = await attachment.file.text();
        if (content.length > 80_000) {
          if ($('chatNote')) $('chatNote').textContent = `${attachment.name} is larger than the 80,000 character limit.`;
          return;
        }
        parts.push({ type: 'text', text: `\n\n[Attachment: ${attachment.name}]\n${content}` });
      } else {
        if ($('chatNote')) $('chatNote').textContent = `${attachment.name} is not a supported image or text file.`;
        return;
      }
    }
    userContent = parts;
  }
  const user = { role: 'user', content: userContent };
  const assistant = { role: 'assistant', content: '', reasoning: '', status: '' };
  try {
    await persistChatMessage(user);
  } catch (err) {
    if ($('chatNote')) $('chatNote').textContent = err.message;
    return;
  }
  chatMessages.push(user, assistant);
  chatAttachments = [];
  $('chatAttachments')?.replaceChildren();
  if ($('chatAttachments')) $('chatAttachments').hidden = true;
  input.value = '';
  resizeChatInput();
  // A new message is the one legitimate forced scroll: the user just sent it.
  renderChatTranscript();
  chatScrollToBottom();
  chatBusy = true;
  chatAbortController = new AbortController();
  const send = $('sendChat');
  const stop = $('stopChat');
  if (send) send.disabled = true;
  if (stop) stop.hidden = false;
  if ($('chatModel')) $('chatModel').disabled = true;
  if ($('chatNote')) $('chatNote').textContent = 'Waiting for the model…';
  input.focus();
  const assistantArticle = $('chatTranscript')?.lastElementChild;
  const bodyNode = assistantArticle?.querySelector('.chat-message-body');
  const thinkingNode = chatThinkingNode('', true);
  thinkingNode.hidden = true;
  assistantArticle?.insertBefore(thinkingNode, assistantArticle.querySelector('.chat-message-body'));
  // Follow the stream down only while the user is already near the bottom; a
  // reader who has scrolled up keeps their place until they return.
  const followStream = () => { if (chatNearBottom()) chatScrollToBottom(); };
  const paintState = (status) => {
    if (!assistantArticle) return;
    let state = assistantArticle.querySelector('.chat-message-state');
    if (status) {
      if (!state) {
        state = document.createElement('span');
        state.className = 'chat-message-state';
        assistantArticle.append(state);
      }
      state.textContent = status;
      state.className = `chat-message-state ${status}`;
    } else if (state) {
      state.remove();
    }
  };
  try {
    const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
    const response = await fetch('/api/chat/completions', {
      method: 'POST', headers, signal: chatAbortController.signal,
      body: JSON.stringify({ model, messages: chatMessages.slice(0, -1), stream: true }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      assistant.status = 'error';
      assistant.content = chatErrorMessage(response.status, body);
      if (bodyNode) bodyNode.textContent = assistant.content;
      paintState('error');
      followStream();
      throw new Error(assistant.content);
    }
    await streamChat(response, assistant, bodyNode, thinkingNode, followStream);
    if (!assistant.content && !assistant.status) assistant.content = 'The model returned an empty response.';
    if (bodyNode) bodyNode.textContent = assistant.content;
    if (thinkingNode && !assistant.reasoning) thinkingNode.remove();
    paintState(assistant.status || '');
    if ($('chatNote')) $('chatNote').textContent = 'Enter to send · Shift+Enter for a new line';
    await persistChatMessage(assistant);
    const session = chatSessions.find((item) => item.id === activeChatSessionId);
    if (session) {
      if (session.title === 'New chat') {
        session.title = text.slice(0, 120);
        fetch(`/api/chat/sessions/${encodeURIComponent(session.id)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: session.title }),
        }).catch(() => {});
      }
      session.updatedAt = Date.now();
      renderChatSessions();
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      assistant.status = 'stopped';
      assistant.content = assistant.content || 'Stopped.';
      if (bodyNode) bodyNode.textContent = assistant.content;
      paintState('stopped');
      if ($('chatNote')) $('chatNote').textContent = 'Response stopped.';
    } else {
      assistant.status = 'error';
      if (bodyNode) bodyNode.textContent = assistant.content || err.message;
      paintState('error');
      if ($('chatNote')) $('chatNote').textContent = assistant.content || err.message;
    }
    try { await persistChatMessage(assistant); } catch {}
  } finally {
    chatBusy = false;
    chatAbortController = null;
    if (send) send.disabled = false;
    if (stop) stop.hidden = true;
    if ($('chatModel')) $('chatModel').disabled = !chatCatalog.length;
    input.focus();
  }
}

function loadChat() {
  const loadId = ++chatLoadId;
  const run = async () => {
    try {
      const [statusResponse, comboResponse] = await Promise.all([
        fetch('/api/status', { cache: 'no-store' }),
        fetch('/api/combos', { cache: 'no-store' }),
      ]);
      const status = await statusResponse.json();
      const combos = await comboResponse.json();
      if (loadId !== chatLoadId || currentPath !== '/chat') return;
      if (!statusResponse.ok || !comboResponse.ok) throw new Error('Could not load chat settings.');
      chatCatalog = buildChatCatalog(status, combos);
      paintChatKeyPanel();
      paintChatCatalog();
      await loadChatSessions();
      renderChatTranscript();
    } catch (err) {
      if (loadId !== chatLoadId || currentPath !== '/chat') return;
      chatCatalog = [];
      paintChatCatalog();
      if ($('chatConnection')) {
        $('chatConnection').className = 'chip chip-bad';
        $('chatConnection').textContent = 'Chat unavailable';
      }
      if ($('chatNote')) $('chatNote').textContent = err.message;
    }
  };
  run();
}

$('chatComposer')?.addEventListener('submit', (event) => {
  event.preventDefault();
  sendChatMessage();
});
$('chatInput')?.addEventListener('input', resizeChatInput);
$('chatInput')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendChatMessage();
  }
});
$('stopChat')?.addEventListener('click', () => chatAbortController?.abort());
$('chatSessionSearch')?.addEventListener('input', renderChatSessions);
$('chatFileInput')?.addEventListener('change', () => {
  const files = [...($('chatFileInput')?.files || [])];
  chatAttachments = files.slice(0, 4).map((file) => ({ file, name: file.name, type: file.type, size: file.size }));
  const host = $('chatAttachments');
  if (!host) return;
  host.replaceChildren();
  host.hidden = chatAttachments.length === 0;
  for (const attachment of chatAttachments) {
    const item = document.createElement('span');
    item.className = 'chat-attachment';
    const label = document.createElement('span');
    label.textContent = attachment.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${attachment.name}`);
    remove.addEventListener('click', () => {
      chatAttachments = chatAttachments.filter((entry) => entry !== attachment);
      item.remove();
      host.hidden = chatAttachments.length === 0;
    });
    item.append(label, remove);
    host.append(item);
  }
});
$('newChat')?.addEventListener('click', async () => {
  const clear = async () => {
    try {
      await createChatSessionUi($('chatModel')?.value || '');
      $('chatInput')?.focus();
    } catch (err) {
      if ($('chatNote')) $('chatNote').textContent = err.message;
    }
  };
  if (!chatMessages.length) return clear();
  openConfirmation({
    title: 'Start a new chat?',
    message: 'The current conversation will be cleared from this browser tab.',
    confirmLabel: 'New chat',
    run: clear,
  });
});

/* ---------------- usage page ---------------- */

const USAGE_RANGE_LABELS = {
  day: { title: 'today', bucket: 'hourly', note: 'today, local time' },
  week: { title: 'this week', bucket: 'daily', note: 'this week, local time' },
  month: { title: 'this month', bucket: 'daily', note: 'this month, local time' },
  all: { title: 'all time', bucket: 'monthly', note: 'all saved history' },
};

// Bucket keys come from the server in local time: YYYY-MM-DDTHH, YYYY-MM-DD, or
// YYYY-MM. Parse them as text so the browser cannot shift them into another day.
function usageBucketLabel(bucket, key) {
  if (bucket === 'hour') return `${key.slice(11, 13)}:00`;
  if (bucket === 'month') {
    const [year, month] = key.split('-');
    return new Date(Number(year), Number(month) - 1, 1)
      .toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }
  const [, month, day] = key.split('-');
  return new Date(Number(key.slice(0, 4)), Number(month) - 1, Number(day))
    .toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function usageBucketTitle(bucket, item) {
  return `${usageBucketLabel(bucket, item.bucket)} · ${fmtFull(item.tokensIn + item.tokensOut)} tok · ${fmtFull(item.requests)} req`;
}

function usageSparkCells(series, bucket) {
  const weights = series.map((item) => Math.max(item.tokensIn + item.tokensOut, item.requests, 1));
  const max = Math.max(...weights, 1);
  return series.map((item, i) => {
    const failed = item.errors > 0 && item.requests === 0;
    const empty = item.requests === 0 && item.tokensIn === 0 && item.tokensOut === 0;
    const label = usageBucketTitle(bucket, item) + (item.errors ? ` · ${fmtFull(item.errors)} err` : '');
    return {
      className: failed ? 'is-err' : empty ? 'is-empty' : '',
      opacity: `${Math.round(Math.max(.2, weights[i] / max) * 100)}%`,
      ratio: weights[i] / max,
      empty,
      failed,
      label,
    };
  });
}

function paintUsageChartTabs() {
  document.querySelectorAll('[data-usage-chart]').forEach((btn) => {
    const active = btn.dataset.usageChart === usageChartType;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
  });
  moveTabIndicator($('uChartTypes'), '[data-usage-chart].is-active');
  const legend = $('uSparkLegend');
  if (legend) {
    legend.textContent = usageChartType === 'heatmap'
      ? 'color intensity = tokens, red = failed'
      : usageChartType === 'bars'
        ? 'bar height = tokens, red = failed'
        : 'line height = tokens, red = failed';
  }
}

function usageChartMarkup(series, bucket, box = {}) {
  if (!series.length) return '<div class="spark-empty">No saved usage for this range yet.</div>';
  const cells = usageSparkCells(series, bucket);
  if (usageChartType === 'heatmap') {
    return `<div class="uchart-heat">${cells
      .map((cell) => `<span class="${cell.className}" style="--cell-opacity:${cell.opacity}" title="${escapeHtml(cell.label)}"></span>`)
      .join('')}</div>`;
  }
  if (usageChartType === 'bars') {
    return `<div class="uchart-bars">${cells
      .map((cell) => `<span class="uchart-bar${cell.failed ? ' is-err' : cell.empty ? ' is-empty' : ''}" style="--bar-height:${Math.max(4, Math.round(cell.ratio * 100))}%" title="${escapeHtml(cell.label)}"></span>`)
      .join('')}</div>`;
  }

  // Line and area share one polyline; the area variant only adds the fill.
  // The viewBox matches the measured pixel box so dots stay round instead of
  // being stretched by preserveAspectRatio="none".
  const width = Math.max(120, Math.round(box.width || 600));
  const height = Math.max(80, Math.round(box.height || 200));
  const padY = 6;
  const usable = height - padY * 2;
  const step = cells.length > 1 ? width / (cells.length - 1) : 0;
  const points = cells.map((cell, index) => {
    const x = cells.length > 1 ? index * step : width / 2;
    const y = padY + usable - Math.max(0.02, cell.ratio) * usable;
    return { x, y, cell };
  });
  const path = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const radius = cells.length > 60 ? 1.6 : cells.length > 24 ? 2.2 : 3;
  const dots = points
    .map((p) => `<circle class="uchart-dot${p.cell.failed ? ' is-err' : ''}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${radius}"><title>${escapeHtml(p.cell.label)}</title></circle>`)
    .join('');
  const area = usageChartType === 'area'
    ? `<polygon class="uchart-area-fill" points="0,${height} ${path} ${width},${height}" />`
    : '';
  return `<div class="uchart-line"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    ${area}
    <polyline class="uchart-line-path" points="${path}" vector-effect="non-scaling-stroke" />
    ${dots}
  </svg></div>`;
}

function usageSparkMarkup(series, bucket, box) {
  return usageChartMarkup(series, bucket, box);
}

function updateUsageSpark(series, bucket) {
  const host = $('uSpark');
  if (!host) return;
  paintUsageChartTabs();
  host.classList.toggle('is-heat', usageChartType === 'heatmap');
  host.dataset.chartType = usageChartType;
  if (!series.length) {
    if (!host.querySelector('.spark-empty')) host.innerHTML = usageSparkMarkup(series, bucket);
    return;
  }

  // The heatmap keeps its spans across polls so colour transitions stay smooth.
  // Bars/line/area are rebuilt on data changes, which is rare (2s polls only
  // redraw when the report signature actually changed).
  if (usageChartType !== 'heatmap') {
    const rect = host.getBoundingClientRect();
    host.innerHTML = usageSparkMarkup(series, bucket, { width: rect.width, height: rect.height });
    return;
  }

  const cells = usageSparkCells(series, bucket);
  const wrapper = host.querySelector('.uchart-heat');
  const spans = wrapper ? [...wrapper.children] : [];
  if (!wrapper || spans.length !== cells.length || spans.some((span) => span.tagName !== 'SPAN')) {
    host.innerHTML = usageSparkMarkup(series, bucket);
    return;
  }

  cells.forEach((cell, index) => {
    const span = spans[index];
    if (span.className !== cell.className) span.className = cell.className;
    if (span.style.getPropertyValue('--cell-opacity') !== cell.opacity) {
      span.style.setProperty('--cell-opacity', cell.opacity);
    }
    if (span.title !== cell.label) span.title = cell.label;
  });
}

function paintUsageRangeTabs() {
  const tabs = $('usageRangeTabs');
  document.querySelectorAll('[data-usage-range]').forEach((btn) => {
    const active = btn.dataset.usageRange === usageRange;
    btn.classList.toggle('is-active', active);
    // These are real tabs, so they expose aria-selected + roving tabindex
    // rather than aria-pressed.
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
  });
  moveTabIndicator(tabs, '[data-usage-range].is-active');
}

// Polling every two seconds must not look like the page is reloading.
// The chip only reports the connection state. An earlier version printed
// "live · 3s ago", which changed its text every second and read as flicker;
// the label is now stable until the state itself changes.
function paintUsageLive() {
  const chip = $('usageLive');
  if (!chip) return;
  const state = usageState === 'error' ? 'error' : usageLastUpdated ? 'live' : 'connecting';
  if (chip.dataset.state === state) return;
  chip.dataset.state = state;
  if (state === 'error') {
    chip.className = 'chip chip-bad';
    chip.textContent = 'offline — retrying';
  } else if (state === 'live') {
    chip.className = 'chip chip-ok is-live';
    chip.innerHTML = '<span class="usage-live-dot" aria-hidden="true"></span>live';
  } else {
    chip.className = 'chip chip-quiet';
    chip.textContent = 'connecting';
  }
}

// Cheap identity for the rendered report. Re-writing identical markup every two
// seconds restarts the bar transitions and makes the chart flicker.
function usageReportSignature(data) {
  return JSON.stringify([data.range, data.bucket, data.totals, data.series, data.models, data.activity]);
}

function usageChartReportSignature(data) {
  return JSON.stringify([data.range, data.bucket, data.series]);
}

// KPI numbers move to their new value instead of being swapped in. The text is
// only touched when the value really changed, so an unchanged poll is a no-op;
// when it does change the old number rolls to the new one and the direction is
// shown with a short tint.
const usageNumberFrames = new WeakMap();

function activityTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// Usage tables cap at ten rows per page so the page stays scannable while the
// full report remains reachable through the pager. Pagination is client-side:
// /api/usage keeps returning the complete range report.
const USAGE_PAGE_SIZE = 10;

function usagePageSlice(items, page) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / USAGE_PAGE_SIZE));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (current - 1) * USAGE_PAGE_SIZE;
  return { items: items.slice(start, start + USAGE_PAGE_SIZE), current, pages, total, start };
}

// Render "1 2 3" buttons plus prev/next. Long ranges collapse the middle so the
// control never wraps into a wall of numbers.
function paintUsagePager({ pager, info, btns, items, page, onSelect, noun }) {
  if (!pager || !info || !btns) return 1;
  const slice = usagePageSlice(items, page);
  info.textContent = slice.total === 0
    ? `0 ${noun}`
    : `${fmtFull(slice.start + 1)}–${fmtFull(slice.start + slice.items.length)} of ${fmtFull(slice.total)}`;
  pager.hidden = slice.total <= USAGE_PAGE_SIZE && slice.pages === 1;

  const make = (label, target, { disabled = false, current = false, aria } = {}) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `usage-page-btn${current ? ' is-current' : ''}`;
    button.textContent = label;
    if (aria) button.setAttribute('aria-label', aria);
    if (current) button.setAttribute('aria-current', 'page');
    button.disabled = disabled;
    if (!disabled && !current) {
      button.addEventListener('click', () => onSelect(target));
    }
    return button;
  };

  const nodes = [];
  nodes.push(make('←', slice.current - 1, { disabled: slice.current <= 1, aria: 'Previous page' }));
  for (let number = 1; number <= slice.pages; number += 1) {
    if (slice.pages > 7 && number !== 1 && number !== slice.pages
      && Math.abs(number - slice.current) > 1) {
      if (nodes.at(-1)?.dataset.gap !== 'true') {
        const gap = document.createElement('span');
        gap.className = 'usage-page-gap';
        gap.dataset.gap = 'true';
        gap.textContent = '…';
        nodes.push(gap);
      }
      continue;
    }
    nodes.push(make(String(number), number, { current: number === slice.current }));
  }
  nodes.push(make('→', slice.current + 1, { disabled: slice.current >= slice.pages, aria: 'Next page' }));
  btns.replaceChildren(...nodes);
  return slice.current;
}

function renderUsageActivity(rows) {
  const table = $('uActivityTable');
  if (!table) return;
  const activity = Array.isArray(rows) ? rows : [];
  const active = Array.isArray(usageData?.active) ? usageData.active : [];
  // In-flight requests sit at the top of the feed as live rows, ahead of the
  // persisted history, so "Streaming" is visible before the response closes.
  const live = active.map((row) => ({
    at: new Date(row.at).toISOString(),
    model: row.model || '',
    provider: row.provider || '',
    account: row.account || '',
    tokensIn: row.tokensIn || 0,
    tokensOut: row.tokensOut || 0,
    ms: row.ms ?? null,
    ok: true,
    streaming: true,
  }));
  const merged = [...live, ...activity];
  $('uActivityCount').textContent = `${activity.length}`;
  const slice = usagePageSlice(merged, usageActivityPage);
  usageActivityPage = paintUsagePager({
    pager: $('uActivityPager'),
    info: $('uActivityPageInfo'),
    btns: $('uActivityPageBtns'),
    items: merged,
    page: usageActivityPage,
    noun: 'entries',
    onSelect: (page) => {
      usageActivityPage = page;
      renderUsageActivity(activity);
    },
  });
  const signature = slice.items.map((row) => [
    row.at, row.model, row.provider, row.account, row.tokensIn, row.tokensOut, row.ms, row.status, row.ok, row.error, row.streaming,
  ]);
  if (!dashboardSignature('dashboard.usage.activity', [usageActivityPage, signature])) return;
  table.innerHTML = slice.items.length
    ? slice.items.map((row) => {
      const tokenTotal = Number(row.tokensIn || 0) + Number(row.tokensOut || 0);
      const status = row.streaming
        ? 'streaming'
        : row.ok ? (row.status || 200) : (row.status || 'error');
      const detail = row.error ? ` title="${escapeHtml(row.error)}"` : '';
      const latency = row.ms == null ? '—' : row.streaming ? `${fmtFull(row.ms)} ms` : `${fmtFull(row.ms)} ms`;
      return `<tr${row.streaming ? ' class="is-streaming"' : ''}>
        <td class="activity-time">${row.streaming ? 'now' : escapeHtml(activityTime(row.at))}</td>
        <td class="model">${escapeHtml(row.model || '—')}</td>
        <td class="model-sub">${escapeHtml(row.provider || '—')}</td>
        <td>${escapeHtml(row.account || '—')}</td>
        <td class="r" title="${fmtFull(tokenTotal)} total · ${fmtFull(row.tokensIn)} in · ${fmtFull(row.tokensOut)} out">${fmtFull(tokenTotal)}</td>
        <td class="r">${latency}</td>
        <td${detail}><span class="pill ${row.streaming ? 'stream' : row.ok ? 'ok' : 'bad'}">${row.streaming ? 'Streaming' : escapeHtml(String(status))}</span></td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="7" class="empty" style="border-bottom:0">No activity recorded in this range yet.</td></tr>';
}

function setUsageStat(el, value, format) {
  if (!el) return;
  const next = Number(value || 0);
  const previous = el.dataset.value === undefined ? next : Number(el.dataset.value);
  if (el.dataset.value !== undefined && previous === next) return;
  el.dataset.value = String(next);

  const cancel = usageNumberFrames.get(el);
  if (cancel) cancel();
  if (motionReduced() || el.dataset.value === undefined || previous === next) {
    el.textContent = format(next);
    return;
  }

  const from = previous;
  const started = performance.now();
  const duration = 420;
  // The tween works on whole units: a compact label like "4.2M" must never
  // render intermediate noise such as "836.662".
  const step = Math.max(1, Math.abs(next - from)) > 1;
  let frame = 0;
  const stepFn = (now) => {
    const progress = Math.min(1, (now - started) / duration);
    const eased = 1 - (1 - progress) ** 3;
    const current = from + (next - from) * eased;
    el.textContent = format(step ? Math.round(current) : current);
    if (progress < 1) {
      frame = requestAnimationFrame(stepFn);
    } else {
      el.textContent = format(next);
      usageNumberFrames.delete(el);
    }
  };
  usageNumberFrames.set(el, () => cancelAnimationFrame(frame));
  el.classList.remove('is-up', 'is-down');
  void el.offsetWidth;
  el.classList.add(next >= from ? 'is-up' : 'is-down');
  frame = requestAnimationFrame(stepFn);
}


// Switching range used to clear usageData first, which replaced the chart and
// table with a placeholder for as long as the request took — a visible flash.
// Keep the previous report on screen, dim it, and swap it once the new one
// arrives; the incoming panel fades in over the old values.
function setUsagePending(pending) {
  const section = document.querySelector('[data-page="/usage"]');
  if (!section) return;
  section.classList.toggle('is-refreshing', pending);
  $('usageRangeTabs')?.setAttribute('aria-busy', String(pending));
}

function flashUsagePanel() {
  const section = document.querySelector('[data-page="/usage"]');
  if (!section || motionReduced()) return;
  section.classList.remove('usage-swap');
  void section.offsetWidth;
  section.classList.add('usage-swap');
  window.setTimeout(() => section.classList.remove('usage-swap'), 320);
}

function renderUsage() {
  if (!$('uRequests')) return;
  paintUsageRangeTabs();
  paintUsageLive();

  const meta = USAGE_RANGE_LABELS[usageRange] || USAGE_RANGE_LABELS.day;
  const zone = usageData?.timeZone || 'local time';
  // Same reasoning as the live chip: only touch the node when the text differs,
  // otherwise the poll rewrites an identical label twice a second.
  const noteText = `${meta.note} · ${zone}`;
  if ($('usageRangeNote').textContent !== noteText) $('usageRangeNote').textContent = noteText;

  if (!usageData) {
    const failed = usageState === 'error';
    $('uRequests').textContent = failed ? '—' : '…';
    $('uRange').textContent = failed ? usageError : 'loading saved usage';
    $('uTokIn').textContent = '—';
    $('uTokOut').textContent = '—';
    $('uTokInNote').textContent = '—';
    $('uTokOutNote').textContent = '—';
    $('uSuccess').textContent = '—';
    $('uErrors').textContent = 'no errors';
    $('uBucket').textContent = meta.bucket;
    $('uSpark').innerHTML = failed
      ? `<div class="spark-empty">${escapeHtml(usageError)}</div>`
      : '<div class="spark-empty">Loading saved usage…</div>';
    $('uSparkStart').textContent = 'oldest';
    $('uSparkEnd').textContent = 'newest';
    $('uModelCount').textContent = '0';
    if ($('uModelPager')) $('uModelPager').hidden = true;
    if ($('uActivityPager')) $('uActivityPager').hidden = true;
    if ($('uModelPageInfo')) $('uModelPageInfo').textContent = '0 models';
    if ($('uActivityPageInfo')) $('uActivityPageInfo').textContent = '0 entries';
    $('uTable').innerHTML = failed
      ? `<tr><td colspan="7" class="empty" style="border-bottom:0">${escapeHtml(usageError)}</td></tr>`
      : '<tr><td colspan="7" class="empty" style="border-bottom:0">Loading usage…</td></tr>';
    return;
  }

  const signature = usageReportSignature(usageData);
  const chartSignature = usageChartReportSignature(usageData);
  const pagerKey = `${usageModelPage}:${usageActivityPage}`;
  if (signature === usageSignature && chartSignature === usageChartSignature && pagerKey === usageRenderPagerKey) return;
  const chartChanged = chartSignature !== usageChartSignature;
  usageSignature = signature;
  usageChartSignature = chartSignature;
  usageRenderPagerKey = pagerKey;

  const totals = usageData.totals;
  // Numbers roll to their new value (or stay untouched when unchanged) instead
  // of being swapped in, which read as flashing on every poll.
  setUsageStat($('uRequests'), totals.requests, compact);
  $('uRequests').title = `${fmtFull(totals.requests)} requests`;
  $('uRange').textContent = totals.requests === 0
    ? `no requests ${meta.title}`
    : `${meta.title} · ${fmtFull(totals.errors)} error${totals.errors === 1 ? '' : 's'}`;

  setUsageStat($('uTokIn'), totals.tokensIn, compact);
  $('uTokIn').title = `${fmtFull(totals.tokensIn)} tokens`;
  setUsageStat($('uTokOut'), totals.tokensOut, compact);
  $('uTokOut').title = `${fmtFull(totals.tokensOut)} tokens`;

  const avgIn = totals.requests ? Math.round(totals.tokensIn / totals.requests) : 0;
  const avgOut = totals.requests ? Math.round(totals.tokensOut / totals.requests) : 0;
  $('uTokInNote').textContent = totals.requests ? `${fmtFull(avgIn)} avg / request` : 'no requests yet';
  $('uTokOutNote').textContent = totals.requests ? `${fmtFull(avgOut)} avg / request` : 'no requests yet';

  setUsageStat($('uSuccess'), totals.successRate == null ? 0 : totals.successRate, (n) => `${Math.round(n)}%`);
  if (totals.successRate == null) $('uSuccess').textContent = '—';
  $('uErrors').textContent = totals.errors === 0
    ? 'no errors'
    : `${totals.errors} error${totals.errors === 1 ? '' : 's'}`;

  $('uBucket').textContent = meta.bucket;
  if (chartChanged) updateUsageSpark(usageData.series, usageData.bucket);
  const first = usageData.series[0];
  const last = usageData.series.at(-1);
  $('uSparkStart').textContent = first ? usageBucketLabel(usageData.bucket, first.bucket) : 'oldest';
  $('uSparkEnd').textContent = last ? usageBucketLabel(usageData.bucket, last.bucket) : 'newest';
  $('uSpark').setAttribute('aria-label', usageData.series.length
    ? `${meta.title}: ${seriesSummary(usageData.series)}`
    : `No saved usage for ${meta.title}`);

  $('uModelCount').textContent = `${usageData.models.length} model${usageData.models.length === 1 ? '' : 's'}`;
  const modelSlice = usagePageSlice(usageData.models, usageModelPage);
  usageModelPage = paintUsagePager({
    pager: $('uModelPager'),
    info: $('uModelPageInfo'),
    btns: $('uModelPageBtns'),
    items: usageData.models,
    page: usageModelPage,
    noun: 'models',
    onSelect: (page) => {
      usageModelPage = page;
      renderUsage();
    },
  });
  renderUsageActivity(usageData.activity);

  $('uTable').innerHTML = modelSlice.items.length
    ? modelSlice.items.map((m) => `<tr>
        <td class="model">${escapeHtml(m.model)}</td>
        <td class="model-sub">${escapeHtml(m.provider || '—')}</td>
        <td class="r">${fmtFull(m.requests)}</td>
        <td class="r">${fmtFull(m.tokensIn)}</td>
        <td class="r">${fmtFull(m.tokensOut)}</td>
        <td class="r">${m.avgMs == null ? '—' : m.avgMs + ' ms'}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="empty" style="border-bottom:0">No traffic recorded in this range yet.</td></tr>';
}

function seriesSummary(series) {
  const requests = series.reduce((sum, item) => sum + item.requests, 0);
  const tokens = series.reduce((sum, item) => sum + item.tokensIn + item.tokensOut, 0);
  return `${fmtFull(requests)} requests, ${fmtFull(tokens)} tokens across ${series.length} buckets`;
}

async function loadUsage({ fromPoll = false } = {}) {
  if (!document.querySelector('[data-page="/usage"]')) return;
  const requestId = ++usageRequestId;
  const requestedRange = usageRange;
  const previousChartSignature = usageData ? usageChartReportSignature(usageData) : '';
  let chartChanged = !usageData;
  // Keep the last report visible while the new one loads; only a first visit
  // (no data at all) shows the skeleton.
  if (!usageData) {
    usageState = 'loading';
    renderUsage();
  }
  // The 2s background poll must not dim the panel: only an explicit range
  // switch shows the pending state, otherwise the page breathes every tick.
  if (!fromPoll) setUsagePending(true);
  try {
    const res = await fetch(`/api/usage?range=${encodeURIComponent(usageRange)}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // A 404 here means the HTML/JS on disk is newer than the running process:
      // static assets are read per request, but routes are fixed at startup.
      throw new Error(res.status === 404
        ? 'This server was started before the usage API existed. Restart norouter, then reload this page.'
        : body.error?.message || `usage ${res.status}`);
    }
    if (requestId !== usageRequestId || requestedRange !== usageRange || body.range !== usageRange) return;
    usageData = body;
    chartChanged = usageChartReportSignature(body) !== previousChartSignature;
    usageState = 'ready';
    usageError = '';
    usageLastUpdated = Date.now();
  } catch (err) {
    if (requestId !== usageRequestId || requestedRange !== usageRange) return;
    usageState = 'error';
    usageError = err.message || 'Could not load usage history.';
  } finally {
    if (requestId === usageRequestId && !fromPoll) setUsagePending(false);
  }
  if (requestId !== usageRequestId || requestedRange !== usageRange) return;
  renderUsage();
  if (!fromPoll && chartChanged) flashUsagePanel();
}

$('usageRangeTabs')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-usage-range]');
  if (!button) return;
  const next = button.dataset.usageRange;
  if (!next || next === usageRange) return;
  selectUsageRange(next);
});

// Arrow-key navigation between the range tabs, matching the ARIA tabs pattern
// already used on the provider detail page.
$('usageRangeTabs')?.addEventListener('keydown', (event) => {
  const buttons = [...document.querySelectorAll('[data-usage-range]')];
  const current = buttons.indexOf(document.activeElement);
  if (current === -1) return;
  let next = null;
  if (event.key === 'ArrowRight') next = (current + 1) % buttons.length;
  else if (event.key === 'ArrowLeft') next = (current - 1 + buttons.length) % buttons.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = buttons.length - 1;
  if (next === null) return;
  event.preventDefault();
  buttons[next].focus();
  selectUsageRange(buttons[next].dataset.usageRange);
});

function selectUsageRange(next) {
  if (!next || next === usageRange) return;
  usageRange = next;
  usageSignature = '';
  usageChartSignature = '';
  usageModelPage = 1;
  usageActivityPage = 1;
  paintUsageRangeTabs();
  loadUsage();
}

function selectUsageChartType(next) {
  if (!USAGE_CHART_TYPES.includes(next) || next === usageChartType) return;
  usageChartType = next;
  try {
    localStorage.setItem(USAGE_CHART_KEY, next);
  } catch {
    // Storage blocked: the choice still applies for this session.
  }
  paintUsageChartTabs();
  if (usageData) updateUsageSpark(usageData.series, usageData.bucket);
}

$('uChartTypes')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-usage-chart]');
  if (button) selectUsageChartType(button.dataset.usageChart);
});

$('uChartTypes')?.addEventListener('keydown', (event) => {
  const buttons = [...document.querySelectorAll('[data-usage-chart]')];
  const current = buttons.indexOf(document.activeElement);
  if (current === -1) return;
  let next = null;
  if (event.key === 'ArrowRight') next = (current + 1) % buttons.length;
  else if (event.key === 'ArrowLeft') next = (current - 1 + buttons.length) % buttons.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = buttons.length - 1;
  if (next === null) return;
  event.preventDefault();
  buttons[next].focus();
  selectUsageChartType(buttons[next].dataset.usageChart);
});

// Line/area are drawn in measured pixel coordinates, so a width change needs a
// fresh paint. Only this chart is redrawn; the 2s poll behaviour is untouched.
let usageChartResizeFrame = 0;
window.addEventListener('resize', () => {
  if (!usageData || usageChartType === 'heatmap') return;
  cancelAnimationFrame(usageChartResizeFrame);
  usageChartResizeFrame = requestAnimationFrame(() => {
    if (usageData) updateUsageSpark(usageData.series, usageData.bucket);
  });
});


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

/* ---------------- settings page ---------------- */

function limitBar(label, used, limit) {
  if (limit == null) return '';
  const ratio = Math.min(1, used / Math.max(limit, 1));
  const tone = ratio >= .8 ? 'bad' : ratio >= .5 ? 'warn' : 'ok';
  return `<div class="key-limit"><span>${label} <b>${compact(used)} / ${compact(limit)}</b></span><i class="${tone}"><em style="width:${Math.max(2, Math.round(ratio * 100))}%"></em></i></div>`;
}

function renderApiKeys() {
  renderCurlExample();
  const list = $('keyList');
  if (!list) return;
  const requireKey = latest?.requireApiKey === true;
  $('keyEndpoint').textContent = `${location.origin}/v1`;
  $('keyTotal').textContent = apiKeys.length;
  $('keyActive').textContent = apiKeys.filter((key) => key.enabled).length;
  $('keyProtection').textContent = requireKey ? 'Protected' : 'Not protected';
  $('requireKeyToggle').checked = requireKey;
  list.innerHTML = apiKeys.length ? apiKeys.map((key) => `<div class="key-row">
    <div class="key-icon" aria-hidden="true">⌁</div>
    <div class="key-main">
      <div class="key-identity"><strong>${escapeHtml(key.name)}</strong><span class="status-pill ${key.status === 'enabled' ? 'ok' : 'bad'}"><span class="dot"></span>${escapeHtml(key.status)}</span></div>
      <small>${key.expiresAt ? `expires ${escapeHtml(new Date(key.expiresAt).toLocaleString())}` : 'no expiry'}</small>
      <code class="key-secret ${key.secret ? 'is-hidden' : 'key-secret-missing'}" id="key-secret-${escapeHtml(key.id)}">${escapeHtml(key.secret || 'No secret stored — rotate to issue one')}</code>
    </div>
    <div class="key-limits">${limitBar('Requests', key.requests, key.requestLimit)}${limitBar('Tokens', key.tokens, key.tokenLimit)}</div>
    <div class="key-row-actions">
      ${key.secret ? `<button class="btn btn-ghost btn-xs" type="button" data-key-show="${escapeHtml(key.id)}">Show</button><button class="btn btn-ghost btn-xs" type="button" data-key-copy="${escapeHtml(key.id)}">Copy</button>` : ''}
      <button class="btn btn-primary btn-xs" type="button" data-key-edit="${escapeHtml(key.id)}">Edit</button>
      <details class="key-more"><summary class="btn btn-ghost btn-xs">More</summary><div class="key-more-menu"><button type="button" data-key-rotate="${escapeHtml(key.id)}">Rotate</button><button type="button" data-key-usage="${escapeHtml(key.id)}">History</button><button type="button" data-key-toggle="${escapeHtml(key.id)}">${key.enabled ? 'Disable' : 'Enable'}</button><button class="danger" type="button" data-key-revoke="${escapeHtml(key.id)}">Revoke key</button></div></details>
    </div>
    <div class="key-history" id="usage-${escapeHtml(key.id)}" hidden></div>
  </div>`).join('') : `<div class="empty key-empty"><strong>No API keys yet</strong><span>Create one to authenticate requests to <code>/v1</code>.</span><button class="btn btn-primary btn-xs" type="button" data-create-key-empty>Create API key</button></div>`;
}

async function loadApiKeys() {
  if (!document.querySelector('[data-page="/api-keys"]')) return;
  try {
    const [keysRes, settingsRes] = await Promise.all([
      fetch('/api/keys', { cache: 'no-store' }),
      fetch('/api/auth-settings', { cache: 'no-store' }),
    ]);
    const keysBody = await keysRes.json();
    const settingsBody = await settingsRes.json();
    if (!keysRes.ok) throw new Error(keysBody.error?.message || 'Could not load API keys.');
    if (!settingsRes.ok) throw new Error(settingsBody.error?.message || 'Could not load auth settings.');
    apiKeys = keysBody.keys || [];
    if (latest) latest.requireApiKey = settingsBody.requireApiKey === true;
    renderApiKeys();
  } catch (err) {
    detailNote($('keyNote'), err.message, 'bad');
  }
}

function draftApiKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `nr_live_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function resetCreateKeyForm() {
  const form = $('createKeyForm');
  if (!form) return;
  form.reset();
  form.elements.secret.value = '';
  detailNote($('createKeyNote'), '', '');
}

function closeKeyModal(id) {
  const modal = $(id);
  if (modal) modal.hidden = true;
  if (id === 'createKeyModal') resetCreateKeyForm();
  if (id === 'editKeyModal') {
    editingApiKeyId = '';
    $('rotateCustomSecret').value = '';
  }
  if (id === 'secretModal') {
    apiKeySecret = '';
    $('secretValue').textContent = '—';
    $('secretValue').classList.add('is-hidden');
    $('toggleSecret').textContent = 'Show token';
  }
}

function openSecretModal(secret) {
  apiKeySecret = secret;
  $('secretValue').textContent = secret;
  $('secretValue').classList.add('is-hidden');
  $('toggleSecret').textContent = 'Show token';
  $('secretModal').hidden = false;
}

function setLimitControl(form, prefix, value) {
  const input = form.elements[`${prefix}Limit`];
  const enabled = form.elements[`${prefix}LimitEnabled`];
  const unit = form.elements[`${prefix}LimitUnit`];
  if (unit) unit.value = value == null ? '' : 'tokens';
  if (enabled) enabled.checked = value != null;
  input.disabled = value == null;
  input.value = value ?? '';
  syncCustomSelects();
}

function setKeyFormValues(form, key) {
  form.elements.name.value = key.name;
  form.dataset.hasSecret = String(Boolean(key.secret));
  form.elements.secret.value = key.secret || '';
  form.elements.secret.placeholder = key.secret ? '' : 'Rotate or enter a replacement token';
  form.elements.expiresAt.value = key.expiresAt ? new Date(key.expiresAt - new Date(key.expiresAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  setLimitControl(form, 'request', key.requestLimit);
  setLimitControl(form, 'token', key.tokenLimit);
}

function keyFormValues(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  const unit = values.tokenLimitUnit;
  delete values.tokenLimitUnit;
  delete values.requestLimitEnabled;
  if (values.tokenLimit && unit && unit !== 'tokens') values.tokenLimit += unit;
  return values;
}

let confirmation = null;
let confirmationOpener = null;

function closeConfirmation() {
  $('confirmModal').hidden = true;
  confirmation = null;
  confirmationOpener?.focus();
  confirmationOpener = null;
}

function openConfirmation({ title, message, confirmLabel, danger = false, run }, opener = document.activeElement) {
  confirmation = run;
  confirmationOpener = opener;
  $('confirmTitle').textContent = title;
  $('confirmMessage').textContent = message;
  $('acceptConfirm').textContent = confirmLabel;
  $('acceptConfirm').className = danger ? 'btn danger' : 'btn btn-primary';
  $('confirmModal').hidden = false;
  $('acceptConfirm').focus();
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

$('openCreateKey')?.addEventListener('click', () => {
  const form = $('createKeyForm');
  form?.reset();
  if (form) form.elements.secret.value = draftApiKey();
  $('createKeyModal').hidden = false;
  form?.elements.name.focus();
});
$('generateKeySecret')?.addEventListener('click', () => {
  const input = $('createKeyForm')?.elements.secret;
  if (!input) return;
  input.value = draftApiKey();
  input.focus();
  input.select();
});
for (const form of [$('createKeyForm'), $('editKeyForm')]) {
  form?.elements.requestLimitEnabled?.addEventListener('change', (event) => {
    const input = form.elements.requestLimit;
    input.disabled = !event.currentTarget.checked;
    if (input.disabled) input.value = '';
  });
  form?.elements.tokenLimitUnit?.addEventListener('change', (event) => {
    const input = form.elements.tokenLimit;
    input.disabled = !event.currentTarget.value;
    if (input.disabled) input.value = '';
    if (!input.disabled) input.focus();
  });
}
document.querySelectorAll('[data-confirm-close]').forEach((el) => el.addEventListener('click', closeConfirmation));
$('cancelConfirm')?.addEventListener('click', closeConfirmation);
$('acceptConfirm')?.addEventListener('click', async () => {
  const run = confirmation;
  closeConfirmation();
  await run?.();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('confirmModal').hidden) closeConfirmation(); });
document.querySelectorAll('[data-key-close]').forEach((el) => el.addEventListener('click', () => closeKeyModal('createKeyModal')));
document.querySelectorAll('[data-edit-key-close]').forEach((el) => el.addEventListener('click', () => closeKeyModal('editKeyModal')));
document.querySelectorAll('[data-history-close]').forEach((el) => el.addEventListener('click', () => closeKeyModal('historyModal')));
$('closeSecret')?.addEventListener('click', () => closeKeyModal('secretModal'));
$('toggleSecret')?.addEventListener('click', () => {
  const hidden = $('secretValue').classList.toggle('is-hidden');
  $('toggleSecret').textContent = hidden ? 'Show token' : 'Hide token';
});
$('copySecret')?.addEventListener('click', async () => { if (apiKeySecret) { await copyText(apiKeySecret); $('copySecret').textContent = 'Copied'; } });
$('copyKeyEndpoint')?.addEventListener('click', async () => { await copyText(`${location.origin}/v1`); $('copyKeyEndpoint').textContent = 'Copied'; setTimeout(() => { $('copyKeyEndpoint').textContent = 'Copy'; }, 1200); });
$('createKeyForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const note = $('createKeyNote');
  try {
    const values = keyFormValues(form);
    const res = await fetch('/api/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not create API key.');
    form.reset();
    closeKeyModal('createKeyModal');
    openSecretModal(body.secret);
    await loadApiKeys();
  } catch (err) { detailNote(note, err.message, 'bad'); }
});
$('editKeyForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!editingApiKeyId) return;
  const form = event.currentTarget;
  try {
    const values = keyFormValues(form);
    if (!values.secret && form.dataset.hasSecret === 'true') delete values.secret;
    if (!form.elements.requestLimitEnabled.checked) values.requestLimit = null;
    if (!form.elements.tokenLimitUnit.value) values.tokenLimit = null;
    const res = await fetch(`/api/keys/${encodeURIComponent(editingApiKeyId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not update API key.');
    closeKeyModal('editKeyModal');
    await loadApiKeys();
  } catch (err) { detailNote($('editKeyNote'), err.message, 'bad'); }
});
$('generateEditSecret')?.addEventListener('click', () => {
  const input = $('editKeyForm').elements.secret;
  input.value = draftApiKey();
  input.focus();
  input.select();
});
$('generateRotateSecret')?.addEventListener('click', () => {
  const input = $('rotateCustomSecret');
  input.value = draftApiKey();
  input.focus();
  input.select();
});
$('rotateKeySecret')?.addEventListener('click', (event) => {
  if (!editingApiKeyId) return;
  openConfirmation({
    title: 'Rotate token?',
    message: 'Existing clients will stop working immediately.',
    confirmLabel: 'Rotate token',
    run: async () => {
      try {
        const secret = $('rotateCustomSecret').value.trim();
        const res = await fetch(`/api/keys/${encodeURIComponent(editingApiKeyId)}/rotate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(secret ? { secret } : {}) });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error?.message || 'Could not rotate API key.');
        closeKeyModal('editKeyModal');
        openSecretModal(body.secret);
        await loadApiKeys();
      } catch (err) { detailNote($('editKeyNote'), err.message, 'bad'); }
    },
  }, event.currentTarget);
});
$('requireKeyToggle')?.addEventListener('change', async (event) => {
  const value = event.currentTarget.checked;
  try {
    const res = await fetch('/api/auth-settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requireApiKey: value }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not update API-key protection.');
    if (latest) latest.requireApiKey = body.requireApiKey;
    renderApiKeys();
  } catch (err) { event.currentTarget.checked = !value; detailNote($('keyNote'), err.message, 'bad'); }
});
$('keyList')?.addEventListener('click', async (event) => {
  const createEmpty = event.target.closest('[data-create-key-empty]');
  if (createEmpty) {
    $('openCreateKey')?.click();
    return;
  }
  const history = event.target.closest('[data-key-usage]');
  if (history) {
    const id = history.dataset.keyUsage;
    const key = apiKeys.find((item) => item.id === id);
    const list = $('historyModalList');
    $('historyKeyName').textContent = key?.name || 'API key';
    list.innerHTML = '<span class="toolnote">Loading history…</span>';
    $('historyModal').hidden = false;
    const res = await fetch(`/api/keys/${encodeURIComponent(id)}/usage?days=30`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { list.innerHTML = `<span class="toolnote bad">${escapeHtml(body.error?.message || 'Could not load history.')}</span>`; return; }
    list.innerHTML = body.usage.length ? body.usage.map((item) => `<div><strong>${escapeHtml(item.day)}</strong><span>${fmtFull(item.requests)} requests</span><span>${fmtFull(item.tokensIn + item.tokensOut)} tokens</span></div>`).join('') : '<span class="toolnote">No usage history.</span>';
    return;
  }
  const show = event.target.closest('[data-key-show]');
  const copy = event.target.closest('[data-key-copy]');
  const edit = event.target.closest('[data-key-edit]');
  const rotate = event.target.closest('[data-key-rotate]');
  const toggle = event.target.closest('[data-key-toggle]');
  const revoke = event.target.closest('[data-key-revoke]');
  const id = show?.dataset.keyShow || copy?.dataset.keyCopy || edit?.dataset.keyEdit || rotate?.dataset.keyRotate || toggle?.dataset.keyToggle || revoke?.dataset.keyRevoke;
  if (!id) return;
  const key = apiKeys.find((item) => item.id === id);
  if (!key) return;
  if (show) {
    const secret = $(`key-secret-${id}`);
    const hidden = secret.classList.toggle('is-hidden');
    show.textContent = hidden ? 'Show' : 'Hide';
    return;
  }
  if (copy && key.secret) {
    await copyText(key.secret);
    copy.textContent = 'Copied';
    setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    return;
  }
  if (edit) {
    editingApiKeyId = key.id;
    $('rotateCustomSecret').value = '';
    setKeyFormValues($('editKeyForm'), key);
    detailNote($('editKeyNote'), '', '');
    $('editKeyModal').hidden = false;
    $('editKeyForm').elements.name.focus();
    return;
  }
  if (rotate) {
    editingApiKeyId = key.id;
    $('rotateCustomSecret').value = '';
    $('rotateKeySecret').click();
    return;
  }
  const run = async () => {
    const method = revoke ? 'DELETE' : 'PATCH';
    const options = { method, headers: { 'content-type': 'application/json' } };
    if (!revoke) options.body = JSON.stringify({ enabled: !key.enabled });
    const res = await fetch(`/api/keys/${encodeURIComponent(id)}`, options);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return detailNote($('keyNote'), body.error?.message || 'API-key action failed.', 'bad');
    await loadApiKeys();
  };
  if (revoke) return openConfirmation({ title: 'Revoke API key?', message: `${key.name} will stop working immediately and its usage history will be deleted.`, confirmLabel: 'Revoke key', danger: true, run }, revoke);
  await run();
});

function paintSettingsTabs() {
  const tabs = [...document.querySelectorAll('[data-settings-tab]')];
  const active = tabs.find((tab) => tab.dataset.settingsTab === settingsTab) || tabs[0];
  if (!active) return;
  settingsTab = active.dataset.settingsTab;
  tabs.forEach((tab) => {
    const selected = tab === active;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll('[role="tabpanel"][data-settings-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== settingsTab;
  });
  moveTabIndicator($('settingsTabs'), '[data-settings-tab].is-active');
}

function renderDashboardAuth() {
  const toggle = $('dashboardAuthToggle');
  if (!toggle) return;
  toggle.checked = dashboardAuth.enabled;
  const warning = $('dashboardAuthWarning');
  if (warning) warning.textContent = dashboardAuth.hasPassword ? '' : 'Default password 123456 is active. Change it before enabling protection.';
}

async function loadDashboardAuth() {
  try {
    const res = await fetch('/api/auth/settings', { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not load dashboard password settings.');
    dashboardAuth = body;
    renderDashboardAuth();
  } catch (err) {
    if ($('dashboardAuthNote')) $('dashboardAuthNote').textContent = err.message;
  }
}

$('dashboardAuthToggle')?.addEventListener('change', async (event) => {
  const note = $('dashboardAuthNote');
  try {
    const res = await fetch('/api/auth/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: event.currentTarget.checked }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not update dashboard password protection.');
    dashboardAuth = { ...dashboardAuth, ...body };
    renderDashboardAuth();
    if (note) note.textContent = body.enabled ? 'Dashboard password protection enabled.' : 'Dashboard password protection disabled.';
  } catch (err) {
    event.currentTarget.checked = !event.currentTarget.checked;
    if (note) note.textContent = err.message;
  }
});
$('saveDashboardAuthPassword')?.addEventListener('click', async () => {
  const input = $('dashboardAuthPassword');
  const note = $('dashboardAuthNote');
  try {
    const res = await fetch('/api/auth/password', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: input.value }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not save dashboard password.');
    dashboardAuth = { ...dashboardAuth, ...body };
    input.value = '';
    renderDashboardAuth();
    if (note) note.textContent = 'Dashboard password saved.';
  } catch (err) {
    if (note) note.textContent = err.message;
  }
});

function renderTokenSaver() {
  const ponytail = $('tokenSaverPonytail');
  if (!ponytail) return;
  ponytail.checked = tokenSaver.ponytail.enabled;
  const note = $('tokenSaverNote');
  if (note && tokenSaverLoading) note.textContent = 'Loading…';
}

async function loadTokenSaver() {
  tokenSaverLoading = true;
  try {
    const res = await fetch('/api/token-saver', { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not load Token Saver settings.');
    tokenSaver = body;
    renderTokenSaver();
  } catch (err) {
    const note = $('tokenSaverNote');
    if (note) note.textContent = err.message;
  } finally {
    tokenSaverLoading = false;
  }
}

async function patchTokenSaver(patch) {
  const note = $('tokenSaverNote');
  try {
    const res = await fetch('/api/token-saver', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not save Token Saver settings.');
    tokenSaver = body;
    renderTokenSaver();
    if (note) note.textContent = 'Saved';
  } catch (err) {
    renderTokenSaver();
    if (note) note.textContent = err.message;
  }
}

function renderReplyFilters() {
  const verbosity = $('replyVerbosity');
  const coding = $('replyCoding');
  renderReplyLanguageTrigger();
  renderReplyLanguageGrid();
  if (verbosity) {
    verbosity.value = replyFilters.verbosity;
    syncCustomSelects();
  }
  if (coding) coding.checked = replyFilters.coding;
}

async function loadReplyFilters() {
  const note = $('replyFiltersNote');
  replyFiltersLoading = true;
  if (note) note.textContent = 'Loading…';
  try {
    const res = await fetch('/api/reply-filters', { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not load Reply style settings.');
    replyFilters = body;
    renderReplyFilters();
    if (note) note.textContent = '';
  } catch (err) {
    if (note) note.textContent = err.message;
  } finally {
    replyFiltersLoading = false;
  }
}

async function patchReplyFilters(patch) {
  const note = $('replyFiltersNote');
  try {
    const res = await fetch('/api/reply-filters', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not save Reply style settings.');
    replyFilters = body;
    renderReplyFilters();
    if (note) note.textContent = 'Saved';
  } catch (err) {
    renderReplyFilters();
    if (note) note.textContent = err.message;
  }
}

function renderDashboardConnect() {
  const base = $('baseUrl');
  if (base) base.textContent = `${location.origin}/v1`;
  const output = $('dashboardApiKey');
  const button = $('copyApiKey');
  const key = apiKeys.find((item) => item.enabled && item.secret);
  dashboardApiKeySecret = key?.secret || '';
  if (output) output.textContent = key?.masked || 'Not configured';
  if (button) button.disabled = !dashboardApiKeySecret;
}

async function loadDashboardApiKey() {
  try {
    const res = await fetch('/api/keys', { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || 'Could not load API key.');
    apiKeys = body.keys || [];
    renderDashboardConnect();
  } catch {
    dashboardApiKeySecret = '';
    renderDashboardConnect();
  }
}

function renderSettings(data) {
  if (!$('sBaseUrl')) return;
  const ready = data.providers.filter((p) => isReady(p.credential)).length;
  $('sBaseUrl').textContent = `${location.origin}/v1`;
  $('sProviders').textContent = `${ready} of ${data.providers.length} ready`;
  $('sTokenEnv').textContent = 'SQLite account pool';
  $('sStatus').textContent = ready === data.providers.length ? 'ready' : `${ready} of ${data.providers.length} providers ready`;
  $('sUptime').textContent = uptime(data.uptimeSeconds);
  $('sPort').textContent = location.host;
  const portInput = $('serverPort');
  if (portInput && document.activeElement !== portInput) portInput.value = data.port || Number(location.port) || 5555;
  $('sRequireKey').textContent = data.requireApiKey ? 'enabled' : 'disabled';
  paintSettingsTabs();
  renderDashboardAuth();
  renderTokenSaver();
  loadDashboardAuth();
}

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

/* ---------------- provider detail ---------------- */

async function loadDetail({ quiet = false } = {}) {
  const id = currentDetailId;
  if (!id) return;

  if (!detail && !quiet) detailState = 'loading';
  try {
    const res = await fetch(`/api/providers/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      detailError = body.error?.message || `Provider "${id}" is not registered.`;
      detail = null;
      detailState = 'error';
    } else {
      const body = await res.json();
      // Switching providers must not keep the previous pool page, filters or
      // selection around.
      if (!quiet && detail?.provider?.id !== body.provider.id) resetAccountsState();
      detail = body;
      detailError = '';
      detailState = 'ready';
    }
  } catch {
    detailError = 'Could not reach the router. Is the server still running?';
    detailState = 'error';
  }

  if (currentDetailId !== id) return;
  renderDetailPage();

  if (detail) {
    $('pageTitle').textContent = detail.provider.name;
    paintDetailMeta();

    // Polling must not refetch a 1,000-row page every two seconds; reload only
    // when the pool size actually changed.
    const poolChanged = !accounts.data || accounts.data.total !== detail.pool.total;
    if (detailTab === 'accounts' && !accounts.loading && (!quiet || poolChanged)) {
      loadAccounts();
    }
  }
}

// Detail identity lives beside the tabs, not only in the shared #tagline: the
// subtitle then reads prefix → format → models → accounts on its own line and
// never collides with the tab row.
function paintDetailMeta() {
  const host = $('detailMeta');
  if (!host) return;
  if (!detail) {
    host.innerHTML = '';
    $('tagline').textContent = 'Accounts, quota and models for this upstream.';
    return;
  }
  const provider = detail.provider || {};
  const meta = [
    provider.prefix || provider.id,
    provider.format ? `${provider.format} compatible` : '',
    `${provider.models || 0} models`,
    `${detail.pool?.total || 0} accounts`,
  ].filter(Boolean);
  host.innerHTML = meta.map((value, index) => (
    `${index ? '<span class="dmeta-item">' : '<span class="dmeta-chip">'}${escapeHtml(value)}</span>`
  )).join('');
  $('tagline').textContent = '';
}

function renderDetailPage() {
  if (!detail) {
    for (const id of ['dAccounts', 'dModels', 'dUpstreamQuota']) {
      const el = $(id);
      if (el) el.innerHTML = '';
    }
    if ($('dModelCount')) $('dModelCount').textContent = '—';
    if ($('tabAccountCount')) $('tabAccountCount').textContent = '0';
    if ($('tabModelCount')) $('tabModelCount').textContent = '0';
    const save = $('saveStrategy');
    if (save) save.disabled = true;
    detailNote($('strategyNote'), '');
    paintDetailMeta();
    return;
  }

  paintDetailMeta();

  const editProvider = $('editProvider');
  if (editProvider) editProvider.onclick = () => openEditProvider(editProvider);

  const removeProvider = $('removeProvider');
  if (removeProvider) {
    removeProvider.hidden = !detail.provider.customProvider;
    removeProvider.onclick = detail.provider.customProvider
      ? () => removeCurrentProvider(removeProvider)
      : null;
  }

  renderDetailAccounts();
  renderDetailModels();
  setDetailTab(detailTab, { silent: true });
}

async function removeCurrentProvider(opener = document.activeElement) {
  if (!currentDetailId || !detail?.provider.customProvider) return;
  const name = detail.provider.name;
  openConfirmation({
    title: 'Remove provider?',
    message: `${name} and its routed models will be removed immediately.`,
    confirmLabel: 'Remove provider',
    danger: true,
    run: async () => {
      try {
        const res = await fetch(`/api/providers/${encodeURIComponent(currentDetailId)}`, { method: 'DELETE' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error?.message || `Request failed (${res.status})`);
        }
        await refresh();
        navigate('/providers');
      } catch (err) { detailNote($('dNote'), err.message, 'bad'); }
    },
  }, opener);
}

/* ---------------- account pool ---------------- */

const ACCOUNT_STATUS = {
  active: ['ok', 'Active'],
  cooldown: ['warn', 'Cooling'],
  error: ['bad', 'Error'],
  disabled: ['quiet', 'Paused'],
};

// All pool state lives here. Rows are paginated server-side, so the DOM never
// holds more than one page even when the pool has thousands of accounts.
const accounts = {
  page: 1,
  pageSize: 20,
  q: '',
  status: 'all',
  data: null,
  loading: false,
  requestId: 0,
  selected: new Set(),
  quota: new Map(),
  quotaLoading: new Set(),
  quotaUnavailable: new Set(),
  busy: new Set(),
};

let detailTab = 'accounts';
const quotaPage = { page: 1, data: null, loading: false, requestId: 0, packagePages: new Map() };
let quotaColumns = Number(localStorage.getItem('norouter.quotaColumns')) || 3;
let searchTimer = null;
let accountModalMode = null;
let accountModalOpener = null;
let accountPreviewPayload = null;
let accountPreviewEntries = null;
const modelTests = new Map();
let modelTestBusy = false;
let codexOAuthTimer = null;

function detailApi(path, options) {
  return fetch(`/api/providers/${encodeURIComponent(currentDetailId)}${path}`, options);
}

function setAccountModal(open, mode = accountModalMode) {
  const modal = $('accountModal');
  if (!modal) return;
  if (!open) {
    clearInterval(codexOAuthTimer);
    codexOAuthTimer = null;
    modal.hidden = true;
    document.body.classList.remove('modal-open');
    accountModalMode = null;
    const opener = accountModalOpener;
    accountModalOpener = null;
    requestAnimationFrame(() => opener?.focus?.());
    accountPreviewPayload = null;
    accountPreviewEntries = null;
    $('accountPreview')?.setAttribute('hidden', '');
    $('bulkEditView')?.removeAttribute('hidden');
    return;
  }

  const nextMode = mode === 'bulk' ? 'bulk' : detail?.provider?.oauth ? 'codex-choice' : 'add';
  if (!accountModalMode) accountModalOpener = document.activeElement;
  accountModalMode = nextMode;
  modal.hidden = false;
  document.body.classList.add('modal-open');
  document.querySelectorAll('.account-modal-view').forEach((view) => {
    view.hidden = view.id !== (nextMode === 'bulk' ? 'bulkPanel' : nextMode === 'codex-choice' ? 'codexAccountChoice' : 'addAccountPanel');
  });
  accountPreviewPayload = null;
  accountPreviewEntries = null;
  $('accountPreview')?.setAttribute('hidden', '');
  $('bulkEditView')?.removeAttribute('hidden');
  const title = $('accountModalTitle');
  const subtitle = $('accountModalSubtitle');
  if (title) title.textContent = nextMode === 'bulk' ? 'Bulk add accounts' : 'Add account';
  if (subtitle) subtitle.textContent = nextMode === 'bulk'
    ? 'Paste a JSON array, wrapper object, or one token per line.'
    : nextMode === 'codex-choice'
      ? 'Choose ChatGPT OAuth or the separate OpenAI API key route.'
      : 'Store an operator-supplied provider credential in the local pool.';
  detailNote($(nextMode === 'bulk' ? 'bulkNote' : 'addAccountNote'), '');
  const focusTarget = nextMode === 'bulk'
    ? $('bulkInput')
    : nextMode === 'codex-choice' ? $('startCodexOAuth') : document.querySelector('#addAccountForm input[name="label"]');
  requestAnimationFrame(() => focusTarget?.focus());
}

function closeAccountModal() {
  setAccountModal(false);
}

function relFuture(ms) {
  const diff = Math.round((ms - Date.now()) / 1000);
  if (diff <= 0) return 'expired';
  if (diff < 3600) return `in ${Math.max(1, Math.ceil(diff / 60))}m`;
  if (diff < 86400) return `in ${Math.floor(diff / 3600)}h`;
  return `in ${Math.floor(diff / 86400)}d`;
}

function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function paintPoolCounts(counts) {
  if (!counts) return;
  const map = {
    cAll: counts.total,
    cActive: counts.active,
    cCooldown: counts.cooldown,
    cError: counts.error,
    cDisabled: counts.disabled,
  };
  for (const [id, value] of Object.entries(map)) {
    const el = $(id);
    if (el) el.textContent = fmtFull(value);
  }
  if ($('tabAccountCount')) $('tabAccountCount').textContent = fmtFull(counts.total);
}

function paintFilterChips() {
  document.querySelectorAll('[data-status]').forEach((chip) => {
    chip.classList.toggle('is-active', chip.dataset.status === accounts.status);
  });
}

function resetAccountsState() {
  accounts.page = 1;
  accounts.pageSize = 20;
  accounts.q = '';
  accounts.status = 'all';
  accounts.data = null;
  accounts.selected.clear();
  accounts.quota.clear();
  accounts.quotaLoading.clear();
  accounts.quotaUnavailable.clear();
  accounts.busy.clear();
  quotaPage.page = 1;
  quotaPage.data = null;
  quotaPage.loading = false;
  quotaPage.packagePages.clear();
  quotaPage.requestId += 1;
  modelTests.clear();
  modelTestBusy = false;
  const search = $('accountSearch');
  if (search) search.value = '';
  const size = $('accountPageSize');
  if (size) size.value = '20';
  syncCustomSelects();
  closeAccountModal();
  detailTab = 'accounts';
  strategyDirty = false;
  detailNote($('strategyNote'), '');
  paintStrategy({ force: true });
  paintFilterChips();
  updateBulkBar();
}

function setDetailTab(tab, { silent = false } = {}) {
  detailTab = tab;
  document.querySelectorAll('.dtab[data-tab]').forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.dpanel').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tab;
  });
  moveTabIndicator($('dTabs'));
  if (!silent && tab === 'quota') loadUpstreamQuota();
}

function renderDetailAccounts() {
  paintPoolCounts(detail?.pool);
  if ($('tabAccountCount')) {
    $('tabAccountCount').textContent = fmtFull(detail?.pool?.total || 0);
  }
  paintStrategy();
}

/* ---------------- account strategy ---------------- */

const STRATEGY_INFO = {
  'round-robin': 'Shares requests across active accounts.',
  sequential: 'Uses each active account in order.',
  'highest-quota': 'Uses the account with the most remaining quota.',
};

let strategyDirty = false;

// Polling refreshes the detail payload every few seconds; a pending (unsaved)
// selection must survive that repaint or the control would fight the user.
function paintStrategy({ force = false } = {}) {
  const select = $('accountStrategy');
  if (!select) return;
  const current = detail?.provider?.config?.accountStrategy || 'round-robin';
  if (force || !strategyDirty) {
    if (select.value !== current) select.value = current;
    strategyDirty = false;
  }
  const desc = $('strategyDesc');
  const info = STRATEGY_INFO[select.value] || STRATEGY_INFO['round-robin'];
  if (desc) {
    desc.textContent = info;
    desc.hidden = true;
  }
  const title = document.querySelector('.strategy-title');
  if (title) title.title = info;
  const save = $('saveStrategy');
  if (save) save.disabled = !strategyDirty;
  syncCustomSelects();
}

$('accountStrategy')?.addEventListener('change', () => {
  strategyDirty = true;
  const info = STRATEGY_INFO[$('accountStrategy').value];
  const title = document.querySelector('.strategy-title');
  if (title && info) title.title = info;
  if ($('saveStrategy')) $('saveStrategy').disabled = false;
});

$('saveStrategy')?.addEventListener('click', async () => {
  const select = $('accountStrategy');
  if (!select || !currentDetailId) return;
  const button = $('saveStrategy');
  const note = $('strategyNote');
  button.disabled = true;
  detailNote(note, 'Saving strategy…');
  try {
    const res = await fetch(`/api/providers/${encodeURIComponent(currentDetailId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountStrategy: select.value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    detail = body;
    strategyDirty = false;
    paintStrategy({ force: true });
    paintDetailMeta();
    detailNote(note, `Strategy saved: ${select.selectedOptions[0]?.textContent.trim() || select.value}.`, 'ok');
  } catch (err) {
    detailNote(note, err.message, 'bad');
    button.disabled = false;
  }
});

async function loadAccounts() {
  if (!currentDetailId) return;
  const token = (accounts.requestId += 1);
  accounts.loading = true;

  const params = new URLSearchParams({
    page: String(accounts.page),
    pageSize: String(accounts.pageSize),
    status: accounts.status,
  });
  if (accounts.q) params.set('q', accounts.q);

  try {
    const res = await detailApi(`/accounts?${params}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    if (token !== accounts.requestId) return;
    accounts.data = body;
    renderAccounts();
    loadVisibleQuotas(token, body.items);
  } catch (err) {
    if (token !== accounts.requestId) return;
    detailNote($('accountNote'), err.message, 'bad');
  } finally {
    if (token === accounts.requestId) accounts.loading = false;
  }
}

async function loadVisibleQuotas(requestId, items) {
  const eligible = items.filter((account) => account.status === 'active'
    && !accounts.quota.has(account.id)
    && !accounts.quotaLoading.has(account.id)
    && !accounts.quotaUnavailable.has(account.id));
  const workers = Array.from({ length: Math.min(3, eligible.length) }, async () => {
    while (eligible.length) {
      const account = eligible.shift();
      accounts.quotaLoading.add(account.id);
      renderAccounts();
      try {
        const res = await detailApi(`/accounts/${encodeURIComponent(account.id)}/quota`, { method: 'POST' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
        if (requestId !== accounts.requestId || !accounts.data?.items.some((item) => item.id === account.id)) continue;
        accounts.quota.set(account.id, body.quota);
      } catch {
        if (requestId === accounts.requestId) accounts.quotaUnavailable.add(account.id);
      } finally {
        accounts.quotaLoading.delete(account.id);
        if (requestId === accounts.requestId) renderAccounts();
      }
    }
  });
  await Promise.all(workers);
}

function quotaCell(quota, accountId) {
  if (accounts.quotaLoading.has(accountId)) return '<span class="muted">Loading…</span>';
  if (accounts.quotaUnavailable.has(accountId)) return '<span class="muted">unavailable</span>';
  if (!quota) return '<span class="muted">—</span>';
  if (quota.quotas) {
    const session = quota.quotas.session;
    const used = Number(session?.used);
    return `<span class="aqnum">${Number.isFinite(used) ? `${Math.round(used)}% used` : 'quota read'}<small>${escapeHtml(quota.plan || 'ChatGPT')}</small></span>`;
  }
  if (!quota.total) return '<span class="muted">no package</span>';
  const pct = Math.min(100, Math.round((quota.used / quota.total) * 100));
  return `<span class="aqbar">
    <span class="aqtrack"><span class="aqfill" style="width:${Math.max(2, pct)}%"></span></span>
    <span class="aqnum">${compact(quota.used)}/${compact(quota.total)}</span>
  </span>`;
}

function accountRowMarkup(account) {
  const [tone, label] = ACCOUNT_STATUS[account.status] || ['quiet', account.status];
  const selected = accounts.selected.has(account.id);
  const expiry = account.expiresAt
    ? `token ${relFuture(account.expiresAt)}`
    : account.hasRefreshToken
      ? 'auto-refresh'
      : 'no expiry';
  const kindLabel = account.kind.replace(/_/g, ' ');
  const quota = accounts.quota.get(account.id);
  const busy = accounts.busy.has(account.id);
  // Secondary actions live in a menu so the row keeps one primary button and
  // the destructive one sits apart from the rest.
  return `<tr data-id="${escapeHtml(account.id)}" class="${selected ? 'is-selected' : ''}">
    <td class="acheck"><input type="checkbox" data-select="${escapeHtml(account.id)}" ${selected ? 'checked' : ''} aria-label="Select ${escapeHtml(account.label)}"></td>
    <td class="amain">
      <span class="alabel">${escapeHtml(account.label)}</span>
      <span class="asub">${escapeHtml(account.masked)} · ${escapeHtml(kindLabel)} · ${escapeHtml(account.uid ? `uid ${account.uid}` : expiry)}</span>
      ${account.lastError
        ? `<span class="aerr" title="${escapeHtml(account.lastError)}">Error</span>`
        : ''}
    </td>
    <td>
      <span class="status-pill ${tone}"><span class="dot"></span>${escapeHtml(label)}</span>
    </td>
    <td>${quotaCell(quota, account.id)}</td>
    <td class="r astats">${fmtFull(account.requests)}<span>req · ${account.requests ? compact(account.tokensIn + account.tokensOut) : '—'} tok</span></td>
    <td class="r">${account.lastUsedAt ? relTime(new Date(account.lastUsedAt).toISOString()) : '—'}</td>
    <td class="aactions">
      <button class="btn btn-ghost btn-xs" type="button" data-act="test" data-id="${escapeHtml(account.id)}" ${busy ? 'disabled' : ''}>Check</button>
      <button class="btn btn-ghost btn-xs" type="button" data-act="more" data-id="${escapeHtml(account.id)}" aria-haspopup="dialog" aria-label="More actions for ${escapeHtml(account.label)}">More</button>
    </td>
  </tr>`;
}

function renderAccounts() {
  const data = accounts.data;
  if (!data) return;

  paintPoolCounts(data.counts);
  paintFilterChips();

  const body = $('dAccounts');
  if (!body) return;

  if (!data.items.length) {
    const empty = data.counts.total === 0
      ? 'No accounts yet. Add one here, or bulk-import a JSON list.'
      : 'No account matches this filter.';
    body.innerHTML = `<tr><td colspan="7" class="empty" style="border-bottom:0">${empty}</td></tr>`;
  } else {
    body.innerHTML = data.items.map(accountRowMarkup).join('');
    staggerChildren(body, 'tr', `accounts:${data.page}:${data.items.map((item) => item.id).join('|')}`);
  }

  const start = (data.page - 1) * data.pageSize + 1;
  const end = Math.min(data.total, start + data.items.length - 1);
  if ($('accountPageInfo')) {
    $('accountPageInfo').textContent = data.total
      ? `${fmtFull(start)}–${fmtFull(end)} of ${fmtFull(data.total)}`
      : '0 accounts';
  }
  if ($('accountPrev')) $('accountPrev').disabled = data.page <= 1;
  if ($('accountNext')) $('accountNext').disabled = data.page >= data.pages;

  const selectAll = $('selectAllAccounts');
  if (selectAll) {
    const ids = data.items.map((item) => item.id);
    const picked = ids.filter((id) => accounts.selected.has(id)).length;
    selectAll.checked = ids.length > 0 && picked === ids.length;
    selectAll.indeterminate = picked > 0 && picked < ids.length;
  }

  updateBulkBar();
}

function updateBulkBar() {
  const bar = $('bulkActions');
  if (!bar) return;
  bar.hidden = accounts.selected.size === 0;
  if ($('bulkCount')) $('bulkCount').textContent = `${fmtFull(accounts.selected.size)} selected`;
}

async function testOne(id) {
  if (!id || accounts.busy.has(id)) return;
  accounts.busy.add(id);
  renderAccounts();
  try {
    const res = await detailApi(`/accounts/${encodeURIComponent(id)}/test`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);

    if (body.quota) accounts.quota.set(id, body.quota);
    if (body.account && accounts.data) {
      const item = accounts.data.items.find((row) => row.id === id);
      if (item) Object.assign(item, body.account);
    }
    detailNote($('accountNote'), body.quota
      ? `Quota: ${compact(body.quota.used)} of ${compact(body.quota.total)} used.`
      : 'Credential accepted.', 'ok');
  } catch (err) {
    detailNote($('accountNote'), err.message, 'bad');
    await loadAccounts();
  } finally {
    accounts.busy.delete(id);
    renderAccounts();
  }
}

async function checkinOne(id) {
  if (!id || accounts.busy.has(id)) return;
  accounts.busy.add(id);
  renderAccounts();
  try {
    const res = await detailApi(`/accounts/${encodeURIComponent(id)}/checkin`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    detailNote($('accountNote'), body.checkin?.message || 'Daily check-in completed.',
      body.checkin?.status === 'inactive' ? '' : 'ok');
  } catch (err) {
    detailNote($('accountNote'), err.message, 'bad');
  } finally {
    accounts.busy.delete(id);
    renderAccounts();
  }
}

async function toggleOne(id) {
  const item = accounts.data?.items.find((row) => row.id === id);
  if (!item || accounts.busy.has(id)) return;
  accounts.busy.add(id);
  renderAccounts();
  try {
    const res = await detailApi(`/accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !item.enabled }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
  } catch (err) {
    detailNote($('accountNote'), err.message, 'bad');
  } finally {
    accounts.busy.delete(id);
    await loadAccounts();
  }
}

async function deleteOne(id, { ask = true, opener = document.activeElement } = {}) {
  const item = accounts.data?.items.find((row) => row.id === id);
  if (ask) return openConfirmation({
    title: 'Remove account?',
    message: `${item?.label || 'This account'} will be removed from the pool.`,
    confirmLabel: 'Remove account',
    danger: true,
    run: () => deleteOne(id, { ask: false }),
  }, opener);
  accounts.busy.add(id);
  try {
    const res = await detailApi(`/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error?.message || `Request failed (${res.status})`);
    }
    accounts.selected.delete(id);
    accounts.quota.delete(id);
  } catch (err) {
    detailNote($('accountNote'), err.message, 'bad');
  } finally {
    accounts.busy.delete(id);
  }
}

async function bulkAction(kind) {
  const ids = [...accounts.selected];
  if (!ids.length) return;
  if (kind === 'delete') return openConfirmation({
    title: `Remove ${ids.length} account${ids.length === 1 ? '' : 's'}?`,
    message: 'Selected accounts will be permanently removed from the pool.',
    confirmLabel: 'Remove accounts',
    danger: true,
    run: () => bulkActionConfirmed(kind, ids),
  });
  return bulkActionConfirmed(kind, ids);
}

async function bulkActionConfirmed(kind, ids) {
  const note = $('accountNote');
  detailNote(note, `${kind === 'delete' ? 'Removing' : 'Updating'} ${ids.length} accounts…`);

  if (kind === 'delete') {
    await Promise.all(ids.map((id) => deleteOne(id, { ask: false })));
  } else {
    const enabled = kind === 'enable';
    await Promise.all(ids.map(async (id) => {
      try {
        await detailApi(`/accounts/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        });
      } catch {
        // The reload below shows the accounts that did change.
      }
    }));
  }

  accounts.selected.clear();
  detailNote(note, `${ids.length} account${ids.length === 1 ? '' : 's'} updated.`, 'ok');
  await loadAccounts();
}

function parseBulk(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.accounts)) return parsed.accounts;
    return [parsed];
  }
  return trimmed.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[\s,]+/).filter(Boolean);
      return parts.length > 1
        ? { uid: parts[0], access_token: parts[1] }
        : { access_token: line };
    });
}

function quotaPackagesMarkup(accountId, quota) {
  const packages = quota.packages || [];
  const pageSize = 5;
  const pages = Math.max(1, Math.ceil(packages.length / pageSize));
  const page = Math.min(quotaPage.packagePages.get(accountId) || 1, pages);
  const start = (page - 1) * pageSize;
  const rows = packages.slice(start, start + pageSize).map((pkg) => {
    const share = pkg.total ? Math.min(100, Math.round((pkg.used / pkg.total) * 100)) : 0;
    return `<div class="pkg">
      <div class="pkg-top">
        <span class="pkg-name">${escapeHtml(pkg.name)}</span>
        <span class="pkg-num">${compact(pkg.used)} / ${compact(pkg.total)}</span>
      </div>
      <div class="qtrack is-thin"><div class="qfill" style="width:${Math.max(2, share)}%"></div></div>
      <span class="pkg-foot">${pkg.recurring ? 'resets' : 'expires'} ${fmtDate(pkg.resetAt)}</span>
    </div>`;
  }).join('');
  if (packages.length <= pageSize) return rows;
  return `${rows}<div class="package-pager">
    <span>${start + 1}–${Math.min(start + pageSize, packages.length)} of ${packages.length} packages</span>
    <div>
      <button class="btn btn-ghost btn-xs" type="button" data-package-page="prev" data-account-id="${escapeHtml(accountId)}" ${page <= 1 ? 'disabled' : ''}>←</button>
      <button class="btn btn-ghost btn-xs" type="button" data-package-page="next" data-account-id="${escapeHtml(accountId)}" ${page >= pages ? 'disabled' : ''}>→</button>
    </div>
  </div>`;
}

function codexQuotaWindowsMarkup(quota) {
  const rows = Object.entries(quota.quotas || {}).filter(([, window]) => window && typeof window === 'object');
  if (!rows.length) return '<p class="hint">No Codex quota windows returned.</p>';
  return `<div class="codex-quota-windows">${rows.map(([name, window]) => {
    const label = name.replace(/_/g, ' ');
    const used = Number(window.used);
    const total = Number(window.total) || 100;
    const pct = Number.isFinite(used) ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : 0;
    const reset = window.resetAt ? fmtDate(window.resetAt) : 'no reset time';
    return `<div class="codex-quota-window">
      <div class="pkg-top"><span class="pkg-name">${escapeHtml(label)}</span><span class="pkg-num">${window.unlimited ? 'unlimited' : `${Number.isFinite(used) ? compact(used) : '—'}% used`}</span></div>
      <div class="qtrack is-thin"><div class="qfill" style="width:${Math.max(2, pct)}%"></div></div>
      <span class="pkg-foot">${window.unlimited ? 'no cap' : `resets ${escapeHtml(reset)}`}</span>
    </div>`;
  }).join('')}</div>`;
}

function paintQuotaColumns() {
  quotaColumns = [1, 2, 3, 4, 5].includes(quotaColumns) ? quotaColumns : 3;
  const host = $('dUpstreamQuota');
  host?.style.setProperty('--quota-columns', quotaColumns);
  host?.style.setProperty('--quota-columns-medium', Math.min(2, quotaColumns));
  document.querySelectorAll('[data-quota-columns]').forEach((button) => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.quotaColumns) === quotaColumns));
  });
}

function quotaStatusLabel(status) {
  return status === 'cooldown' ? 'Cooling' : 'Active';
}

function renderCoolingQuotaAccount(account) {
  const retry = account.cooldownUntil > Date.now() ? `Retry ${relFuture(account.cooldownUntil)}` : 'Quota temporarily unavailable.';
  return `<section class="quota-account quota-account-inactive">
    <div class="quota-account-head"><strong>${escapeHtml(account.label)}</strong><span class="status-pill quiet"><span class="dot"></span>Cooling</span></div>
    <p class="hint">${escapeHtml(retry)}</p>
  </section>`;
}

function renderActiveQuotaAccount(account, result) {
  if (result?.error) return `<section class="quota-account">
    <div class="quota-account-head"><strong>${escapeHtml(account.label)}</strong><span class="status-pill bad"><span class="dot"></span>Unavailable</span></div>
    <p class="hint bad">${escapeHtml(result.error)}</p>
  </section>`;
  if (!result?.quota) return `<section class="quota-account">
    <div class="quota-account-head"><strong>${escapeHtml(account.label)}</strong><span class="muted">Loading…</span></div>
  </section>`;
  const quota = result.quota;
  if (quota.quotas) return `<section class="quota-account">
    <div class="quota-account-head"><strong>${escapeHtml(account.label)}</strong><span class="muted">${escapeHtml(account.masked)}</span></div>
    <div class="qtop"><div><div class="stat-big qvalue">${escapeHtml(quota.plan || 'ChatGPT')}</div><div class="qcap">${quota.limitReached ? 'limit reached' : 'available'}${quota.reviewLimitReached ? ' · review limited' : ''}${quota.sparkLimitReached ? ' · spark limited' : ''}</div></div></div>
    ${codexQuotaWindowsMarkup(quota)}
  </section>`;
  const pct = quota.total ? Math.min(100, Math.round((quota.used / quota.total) * 100)) : 0;
  const packages = quotaPackagesMarkup(account.id, quota);
  return `<section class="quota-account">
    <div class="quota-account-head"><strong>${escapeHtml(account.label)}</strong><span class="muted">${escapeHtml(account.masked)}</span></div>
    <div class="qtop"><div class="stat-big qvalue">${compact(quota.used)}</div><div class="qcap">of ${fmtFull(quota.total)}<br><span>${escapeHtml(quota.plan || 'CodeBuddy')}</span></div></div>
    <div class="qtrack"><div class="qfill" style="width:${Math.max(2, pct)}%"></div></div>
    ${packages ? `<div class="pkgs">${packages}</div>` : '<p class="hint">No credit package returned.</p>'}
  </section>`;
}

function renderUpstreamQuota() {
  const host = $('dUpstreamQuota');
  const note = $('upstreamQuotaNote');
  const data = quotaPage.data;
  if (!host || !note) return;
  paintQuotaColumns();

  if (!detail?.provider.quotaSupported) {
    note.textContent = 'This provider publishes no quota endpoint.';
    host.innerHTML = '';
    return;
  }
  if (!data) {
    note.textContent = quotaPage.loading ? 'Reading account quotas…' : 'No quota data yet.';
    host.innerHTML = '';
    $('quotaPageInfo').textContent = 'Loading…';
    $('quotaPrev').disabled = true;
    $('quotaNext').disabled = true;
    return;
  }

  const active = data.items.filter((account) => account.status === 'active');
  const cooling = data.items.filter((account) => account.status === 'cooldown');
  const hidden = data.items.filter((account) => account.status !== 'active' && account.status !== 'cooldown');
  note.textContent = data.error || `${active.length} active · ${cooling.length} non-active${hidden.length ? ` · ${hidden.length} hidden` : ''}.`;
  const activeMarkup = active.length
    ? active.map((account) => renderActiveQuotaAccount(account, data.quotas.get(account.id))).join('')
    : '<p class="quota-group-empty">No active accounts.</p>';
  const coolingMarkup = cooling.length
    ? cooling.map(renderCoolingQuotaAccount).join('')
    : '<p class="quota-group-empty">No non-active accounts.</p>';
  host.innerHTML = `<section class="quota-group"><h3 class="quota-group-title">Active accounts <span>${active.length}</span></h3><div class="quota-group-grid">${activeMarkup}</div></section>
    <section class="quota-group quota-group-muted"><h3 class="quota-group-title">Non-active accounts <span>${cooling.length}</span></h3><div class="quota-group-grid">${coolingMarkup}</div></section>`;

  const start = data.total ? (data.page - 1) * data.pageSize + 1 : 0;
  const end = Math.min(data.total, start + data.items.length - 1);
  $('quotaPageInfo').textContent = data.total ? `${start}–${end} of ${data.total}` : '0 accounts';
  $('quotaPrev').disabled = data.page <= 1 || quotaPage.loading;
  $('quotaNext').disabled = data.page >= data.pages || quotaPage.loading;
}

async function loadUpstreamQuota({ reset = false } = {}) {
  if (!detail?.provider.quotaSupported || quotaPage.loading) return;
  if (reset) quotaPage.page = 1;
  const requestId = ++quotaPage.requestId;
  quotaPage.loading = true;
  quotaPage.data = null;
  quotaPage.packagePages.clear();
  renderUpstreamQuota();
  try {
    const res = await detailApi(`/accounts/quota-list?page=${quotaPage.page}&pageSize=5`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `Request failed (${res.status})`);
    if (requestId !== quotaPage.requestId) return;
    const quotas = new Map();
    quotaPage.data = { ...data, quotas };
    renderUpstreamQuota();
    const queue = data.items.filter((account) => account.status === 'active');
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) {
        const account = queue.shift();
        try {
          const quotaRes = await detailApi(`/accounts/${encodeURIComponent(account.id)}/quota`, { method: 'POST' });
          const body = await quotaRes.json().catch(() => ({}));
          if (!quotaRes.ok) throw new Error(body.error?.message || `Request failed (${quotaRes.status})`);
          quotas.set(account.id, { quota: body.quota });
        } catch (err) {
          quotas.set(account.id, { error: err.message });
        }
        if (requestId === quotaPage.requestId) renderUpstreamQuota();
      }
    }));
  } catch (err) {
    if (requestId === quotaPage.requestId) {
      quotaPage.data = { items: [], total: 0, page: quotaPage.page, pageSize: 5, pages: 1, quotas: new Map(), error: err.message };
      renderUpstreamQuota();
    }
  } finally {
    if (requestId === quotaPage.requestId) {
      quotaPage.loading = false;
      renderUpstreamQuota();
    }
  }
}

function capLabel(value, yes = 'yes', no = 'no') {
  if (value === null || value === undefined) return 'unknown';
  return value ? yes : no;
}

function compactLimit(value) {
  if (!Number.isFinite(value)) return '—';
  return compact(value);
}

function modelCapabilityMarkup(capabilities = {}, modelId = '') {
  const input = capabilities.input || {};
  const reasoning = capabilities.reasoning || {};
  const limits = capabilities.limits || {};
  const items = [
    input.text?.value === true ? ['text', 'Text'] : null,
    input.vision?.value === true ? ['vision', 'Vision'] : null,
    reasoning.supported === true ? ['reasoning', 'Reasoning'] : null,
    reasoning.canDisable === true ? ['thinking', 'Thinking'] : null,
  ].filter(Boolean);
  const icons = {
    text: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 6h14M12 6v12M8 18h8"/></svg>',
    vision: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12s3.2-5 8.5-5 8.5 5 8.5 5-3.2 5-8.5 5-8.5-5-8.5-5Z"/><circle cx="12" cy="12" r="2.2"/></svg>',
    reasoning: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 14 9l6 2-6 2-2 6-2-6-6-2 6-2 2-6Z"/></svg>',
    thinking: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M8.5 15.5a6 6 0 1 1 7 0c-.9.6-1.5 1.2-1.5 2.5h-4c0-1.3-.6-1.9-1.5-2.5Z"/></svg>',
  };
  const summary = items.length
    ? items.map(([key, label]) => `<span class="cap-icon" title="${label}">${icons[key]}<span class="sr-only">${label}</span></span>`).join('')
    : '<span class="cap-icon cap-unknown" title="Capability data unavailable">?</span>';
  return `<button class="model-capability" type="button" data-model-info="${escapeHtml(JSON.stringify(capabilities))}" data-model-name="${escapeHtml(modelId)}" aria-label="View capabilities for ${escapeHtml(modelId)}">${summary}</button>
    <small class="model-limits">${compactLimit(limits.contextWindow)} ctx · ${compactLimit(limits.maxOutputTokens)} out</small>`;
}

function renderDetailModels() {
  const body = $('dModels');
  if (!body) return;

  const models = [...detail.models].sort((a, b) => Number(a.enabled === false) - Number(b.enabled === false));
  const custom = models.filter((m) => m.source === 'custom').length;
  $('dModelCount').textContent = `${models.length} total · ${custom} custom`;
  const fetchButton = $('fetchModels');
  if (fetchButton && detail?.provider.modelDiscovery === false) {
    fetchButton.disabled = true;
    fetchButton.title = 'This provider has no upstream /models endpoint.';
    $('fetchLabel').textContent = 'Catalog bundled';
    detailNote($('fetchNote'), 'This provider uses its bundled catalog; upstream model discovery is not available.');
  } else if (fetchButton) {
    $('fetchLabel').textContent = detail.provider.modelsPath ? 'Fetch Codex catalog' : 'Fetch from provider';
    fetchButton.title = detail.provider.modelsPath ? 'Read the provider catalog endpoint.' : '';
  }
  if ($('tabModelCount')) $('tabModelCount').textContent = fmtFull(models.length);
  if (!models.length) {
    body.innerHTML = '<p class="model-grid-empty">No models in this catalog.</p>';
    return;
  }

  body.innerHTML = models.map((m) => {
    const tokens = m.tokensIn + m.tokensOut;
    const test = modelTests.get(m.id);
    const disabled = m.enabled === false;
    const testing = test?.busy === true;
    const result = testing
      ? '<span class="model-test-result testing"><span class="test-spinner" aria-hidden="true"></span>Testing…</span>'
      : test?.ok
      ? `<span class="model-test-result ok">Pass · ${escapeHtml(test.account?.label || 'active account')}</span>`
      : test?.skipped
        ? `<span class="model-test-result" title="${escapeHtml(test.error || 'Not testable upstream')}">Skipped</span>`
        : test?.error
          ? `<span class="model-test-result bad" title="${escapeHtml(test.error)}">Failed${test.disabled ? ' · disabled' : ''}</span>`
          : '<span class="model-test-result muted">Not tested</span>';
    const plans = m.plans?.length
      ? `<span class="model-plans">${m.plans.map((plan) => `<span class="plan-badge plan-${escapeHtml(plan)}">${escapeHtml(plan)}</span>`).join('')}</span>`
      : '';
    return `<article class="model-card ${disabled ? 'model-disabled' : ''}${testing ? ' model-testing' : ''}" role="listitem">
      <div class="model-card-head">
        <div class="model-card-title"><strong class="model">${escapeHtml(m.id)}</strong>${disabled ? '<span class="model-disabled-label">Disabled</span>' : ''}</div>
        <span class="srcbadge ${m.source}">${escapeHtml(m.source)}</span>
      </div>
      ${plans}
      <div class="model-capability-cell">${modelCapabilityMarkup(m.capabilities, m.id)}</div>
      <div class="model-card-stats" aria-label="Model usage statistics">
        <span><b>${fmtFull(m.requests)}</b> req</span>
        <span><b>${m.requests ? fmtFull(tokens) : '—'}</b> tok</span>
        <span><b>${m.lastMs == null ? '—' : `${m.lastMs} ms`}</b> latency</span>
      </div>
      <div class="model-card-foot"><span class="model-result">${result}</span><span class="model-actions">
        <button class="iconbtn model-action model-test-action${testing ? ' is-testing' : ''}" type="button" data-test-model="${escapeHtml(m.id)}" ${modelTestBusy || testing || disabled ? 'disabled' : ''} title="${testing ? 'Testing model' : 'Test model'}" aria-label="${testing ? 'Testing' : 'Test'} ${escapeHtml(m.id)}">${testing ? '<span class="test-spinner" aria-hidden="true"></span>' : '<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6L19 12 8 5.2Z"/></svg>'}</button>
        <button class="iconbtn model-action ${disabled ? 'is-enable' : ''}" type="button" data-toggle-model="${escapeHtml(m.id)}" title="${disabled ? 'Enable model' : 'Disable model'}" aria-label="${disabled ? 'Enable model' : 'Disable model'} ${escapeHtml(m.id)}">${disabled ? '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m5 12 4 4L19 6"/></svg>' : '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>'}</button>
        ${m.source === 'custom' ? `<button class="iconbtn model-action danger" type="button" data-remove-model="${escapeHtml(m.id)}" title="Delete custom model" aria-label="Delete custom model ${escapeHtml(m.id)}"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 7h14M10 11v6M14 11v6M8 7l1-3h6l1 3m-9 0 1 14h8l-1-14"/></svg></button>` : ''}
      </span></div>
    </article>`;
  }).join('');
}

function detailNote(el, text, tone = '') {
  if (!el) return;
  el.textContent = text;
  el.className = tone ? `toolnote ${tone}` : 'toolnote';
}

let modelToastSeq = 0;
const modelToastTimers = new WeakMap();
const MODEL_TOAST_MS = 2000;

function closeModelTestToast(toast) {
  if (!toast || toast.classList.contains('is-closing')) return;
  window.clearTimeout(modelToastTimers.get(toast));
  modelToastTimers.delete(toast);
  toast.classList.add('is-closing');
  window.setTimeout(() => toast.remove(), 180);
}

function scheduleModelTestToast(toast) {
  if (!toast || toast.matches(':hover') || toast.contains(document.activeElement)) return;
  window.clearTimeout(modelToastTimers.get(toast));
  modelToastTimers.set(toast, window.setTimeout(() => closeModelTestToast(toast), MODEL_TOAST_MS));
}

function showModelTestToast(result) {
  const host = $('modelTestToasts');
  if (!host || !result) return;

  const ok = result.ok === true;
  const answer = String(ok ? (result.answer || 'The model returned no text.') : (result.error || 'Model test failed.'))
    .slice(0, 1200);
  const account = result.account?.label || 'active account';
  const latency = Number.isFinite(result.latencyMs) ? ` · ${result.latencyMs} ms` : '';
  const toast = document.createElement('article');
  const skipped = result.skipped === true;
  toast.className = `model-test-toast${ok || skipped ? '' : ' is-error'}`;
  toast.dataset.toastId = String(++modelToastSeq);
  toast.innerHTML = `<button class="model-test-toast-close" type="button" aria-label="Close model test result">×</button>
    <div class="model-test-toast-head">
      <strong class="model-test-toast-title">${ok ? 'Model test passed' : skipped ? 'Model test skipped' : 'Model test failed'}</strong>
      <span class="model-test-toast-model">${escapeHtml(result.model || 'unknown model')}</span>
    </div>
    <div class="model-test-toast-answer">${escapeHtml(answer)}</div>
    ${ok || skipped || result.status === 429 ? '' : result.upstreamBody ? `<pre class="model-test-toast-upstream">${escapeHtml(result.upstreamBody)}</pre>` : ''}
    <div class="model-test-toast-meta">${escapeHtml(account)}${latency}${result.disabled ? ' · account disabled' : ''}</div>`;
  host.appendChild(toast);
  while (host.children.length > 3) closeModelTestToast(host.firstElementChild);
  host.scrollTop = host.scrollHeight;
  scheduleModelTestToast(toast);
}

$('modelTestToasts')?.addEventListener('click', (event) => {
  const close = event.target.closest('.model-test-toast-close');
  if (close) closeModelTestToast(close.closest('.model-test-toast'));
});
$('modelTestToasts')?.addEventListener('pointerenter', (event) => {
  const toast = event.target.closest('.model-test-toast');
  if (toast) window.clearTimeout(modelToastTimers.get(toast));
}, true);
$('modelTestToasts')?.addEventListener('pointerleave', (event) => {
  const toast = event.target.closest('.model-test-toast');
  if (toast) scheduleModelTestToast(toast);
}, true);
$('modelTestToasts')?.addEventListener('focusin', (event) => {
  const toast = event.target.closest('.model-test-toast');
  if (toast) window.clearTimeout(modelToastTimers.get(toast));
});
$('modelTestToasts')?.addEventListener('focusout', (event) => {
  const toast = event.target.closest('.model-test-toast');
  if (toast) requestAnimationFrame(() => scheduleModelTestToast(toast));
});

$('addModelForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('newModelInput');
  const note = $('addNote');
  const value = (input?.value || '').trim();
  if (!value || !currentDetailId) return;

  detailNote(note, `Adding ${value}…`);
  try {
    const res = await fetch(`/api/providers/${encodeURIComponent(currentDetailId)}/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    detail = body;
    input.value = '';
    detailNote(note, `${value} added — it is served by /v1 right away.`, 'ok');
    renderDetailModels();
    if (detail) paintDetailMeta();
  } catch (err) {
    detailNote(note, err.message, 'bad');
  }
});

async function runModelTest(model, disableOnError = false) {
  if (!currentDetailId || modelTestBusy) return;
  modelTests.set(model, { busy: true });
  renderDetailModels();
  try {
    const res = await fetch(`/api/providers/${encodeURIComponent(currentDetailId)}/models/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, disableOnError }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    const result = body.results?.[0] || body;
    modelTests.set(model, result);
    showModelTestToast(result);
    detailNote($('modelTestNote'), result.ok
      ? `${model} passed using ${result.account?.label || 'an active account'}.`
      : `${model} failed${result.disabled ? ' and the account was disabled' : ''}.`, result.ok ? 'ok' : 'bad');
    await loadAccounts();
    await refresh();
  } catch (err) {
    modelTests.set(model, { error: err.message });
    detailNote($('modelTestNote'), err.message, 'bad');
  } finally {
    renderDetailModels();
  }
}

let modelTestModeOpener = null;

function closeModelTestMode() {
  const modal = $('modelTestModeModal');
  if (modal.hidden) return;
  modal.hidden = true;
  requestAnimationFrame(() => modelTestModeOpener?.focus?.());
  modelTestModeOpener = null;
}

function openModelTestMode(opener = document.activeElement) {
  if (modelTestBusy) return;
  modelTestModeOpener = opener;
  $('modelTestModeModal').hidden = false;
  $('testAllOnly').focus();
}

async function runAllModelTests(disableOnError) {
  if (!currentDetailId || modelTestBusy || !detail) return;
  modelTestBusy = true;
  const button = $('testAllModels');
  if (button) button.disabled = true;
  // Test all only means models returned by the provider catalog fetch. Custom
  // dashboard labels are local prefixes and cannot be sent upstream as Codex IDs.
  const models = detail.models.filter((item) => item.source === 'catalog').map((item) => item.id);
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  try {
    if (!models.length) {
      detailNote($('modelTestNote'), 'No fetched provider models available. Fetch the Codex catalog first.', 'bad');
      return;
    }
    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      modelTests.set(model, { busy: true });
      detailNote($('modelTestNote'), `Testing ${index + 1}/${models.length}: ${model}`);
      renderDetailModels();
      try {
        const res = await fetch(`/api/providers/${encodeURIComponent(currentDetailId)}/models/test`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, disableOnError }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
        const result = body.results?.[0] || body;
        modelTests.set(model, result);
        if (result.ok) passed += 1;
        else if (result.skipped) skipped += 1;
        else failed += 1;
        showModelTestToast(result);
        if (!result.ok && disableOnError) await toggleModel(model, false);
      } catch (err) {
        failed += 1;
        modelTests.set(model, { error: err.message });
        showModelTestToast({ model, error: err.message });
        if (disableOnError) await toggleModel(model, false);
      }
      renderDetailModels();
      if (index < models.length - 1) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    detailNote($('modelTestNote'), `${passed} passed · ${failed} failed${skipped ? ` · ${skipped} skipped` : ''}${disableOnError ? ' · failures disabled' : ''}.`, failed ? 'bad' : 'ok');
    await loadAccounts();
    await refresh();
  } finally {
    modelTestBusy = false;
    if (button) button.disabled = false;
    renderDetailModels();
  }
}

$('testAllModels')?.addEventListener('click', (event) => openModelTestMode(event.currentTarget));
$('testAllOnly')?.addEventListener('click', () => { closeModelTestMode(); runAllModelTests(false); });
$('testAllWithDisable')?.addEventListener('click', () => { closeModelTestMode(); runAllModelTests(true); });
$('cancelModelTestMode')?.addEventListener('click', closeModelTestMode);
$('modelTestModeModal')?.addEventListener('click', (event) => {
  if (event.target.closest('[data-model-test-mode-close]')) closeModelTestMode();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('modelTestModeModal').hidden) closeModelTestMode();
});

async function toggleModel(model, enabled) {
  const res = await fetch(`/api/providers/${encodeURIComponent(currentDetailId)}/models/${encodeURIComponent(model)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return detailNote($('modelTestNote'), body.error?.message || `Request failed (${res.status})`, 'bad');
  detail = body;
  renderDetailModels();
  await refresh();
}

function closeModelInfo() {
  $('modelInfoModal').hidden = true;
}
$('closeModelInfo')?.addEventListener('click', closeModelInfo);
$('modelInfoModal')?.addEventListener('click', (event) => { if (event.target.closest('[data-model-info-close]')) closeModelInfo(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('modelInfoModal').hidden) closeModelInfo(); });

$('dModels')?.addEventListener('click', async (event) => {
  const info = event.target.closest('[data-model-info]');
  if (info) {
    let capabilities;
    try { capabilities = JSON.parse(info.dataset.modelInfo); } catch { return; }
    const input = capabilities.input || {};
    const output = capabilities.output || {};
    const reasoning = capabilities.reasoning || {};
    const limits = capabilities.limits || {};
    const modelName = info.dataset.modelName || 'Model capabilities';
    const value = (item) => item?.value === null || item?.value === undefined ? 'Unknown' : item.value ? 'Yes' : 'No';
    const capabilityRows = [
      ['Text input', value(input.text)],
      ['Vision input', value(input.vision)],
      ['PDF input', value(input.pdf)],
      ['Text output', value(output.text)],
      ['JSON output', value(output.json)],
      ['Reasoning', capLabel(reasoning.supported)],
      ['Thinking control', capLabel(reasoning.canDisable)],
      ['Reasoning format', reasoning.format || 'Unknown'],
      ['Context window', compactLimit(limits.contextWindow)],
      ['Max output', compactLimit(limits.maxOutputTokens)],
    ];
    $('modelInfoTitle').textContent = modelName;
    $('modelInfoSubtitle').textContent = capabilities.provenance || 'Capability details';
    $('modelInfoBody').innerHTML = `<div class="model-info-details">${capabilityRows.map(([label, value]) => `<div class="model-info-row"><span>${escapeHtml(label)}</span><b>${escapeHtml(String(value))}</b></div>`).join('')}</div>`;
    $('modelInfoModal').hidden = false;
    $('closeModelInfo').focus();
    return;
  }
  const toggle = event.target.closest('[data-toggle-model]');
  if (toggle) {
    const model = toggle.dataset.toggleModel;
    const row = detail.models.find((item) => item.id === model);
    if (!row) return;
    if (row.enabled !== false) return openConfirmation({
      title: 'Disable model?',
      message: `${model} will stay in the catalog but stop appearing in /v1/models and chat routing.`,
      confirmLabel: 'Disable model',
      danger: true,
      run: () => toggleModel(model, false),
    }, toggle);
    return toggleModel(model, true);
  }
  const testBtn = event.target.closest('[data-test-model]');
  if (testBtn) return runModelTest(testBtn.dataset.testModel);
  const btn = event.target.closest('[data-remove-model]');
  if (!btn || !currentDetailId) return;

  const model = btn.dataset.removeModel;
  openConfirmation({
    title: 'Remove model?',
    message: `${model} will no longer be routed by this provider.`,
    confirmLabel: 'Remove model',
    danger: true,
    run: async () => {
      btn.disabled = true;
      try {
        const res = await fetch(
          `/api/providers/${encodeURIComponent(currentDetailId)}/models/${encodeURIComponent(model)}`,
          { method: 'DELETE' },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
        detail = body;
        detailNote($('addNote'), `${model} removed.`, 'ok');
        renderDetailModels();
      } catch (err) {
        detailNote($('addNote'), err.message, 'bad');
        btn.disabled = false;
      }
    },
  }, btn);
});

$('fetchModels')?.addEventListener('click', async () => {
  if (!currentDetailId) return;
  const btn = $('fetchModels');
  const label = $('fetchLabel');
  const note = $('fetchNote');
  if (detail?.provider.modelDiscovery === false) {
    btn.disabled = true;
    label.textContent = 'Catalog bundled';
    detailNote(note, 'CodeBuddy CN uses its bundled catalog; upstream /models is not available.');
    return;
  }

  btn.disabled = true;
  label.textContent = 'Fetching…';
  detailNote(note, 'Asking the provider for its model list…');
  try {
    const res = await fetch(`/api/providers/${encodeURIComponent(currentDetailId)}/models/fetch`, {
      method: 'POST',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    detail = body;
    const added = body.added || [];
    const accountSummary = Array.isArray(body.accounts)
      ? ` ${body.accounts.filter((account) => !account.error).length}/${body.accounts.length} accounts fetched${body.partial ? '; some accounts failed' : ''}.`
      : '';
    detailNote(note, `Fetched ${body.fetched || 0} model${body.fetched === 1 ? '' : 's'}.${accountSummary}`, body.partial ? 'bad' : 'ok');
    renderDetailModels();
  } catch (err) {
    detailNote(note, err.message, 'bad');
  } finally {
    btn.disabled = false;
    label.textContent = detail?.provider.modelsPath ? 'Fetch Codex catalog' : 'Fetch from provider';
  }
});

/* ---------------- account pool events ---------------- */

document.querySelectorAll('.dtab[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => setDetailTab(btn.dataset.tab));
});

// Roving tabindex: only the selected tab is in the tab order, and the arrow
// keys move between tabs and activate them, per the ARIA tabs pattern.
$('dTabs')?.addEventListener('keydown', (event) => {
  const tabs = [...document.querySelectorAll('#dTabs .dtab')];
  const current = tabs.indexOf(document.activeElement);
  if (current === -1) return;
  let next = null;
  if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  if (next === null) return;
  event.preventDefault();
  tabs[next].focus();
  setDetailTab(tabs[next].dataset.tab);
});

$('openAddAccount')?.addEventListener('click', () => setAccountModal(true, 'add'));
$('openBulk')?.addEventListener('click', () => setAccountModal(true, 'bulk'));
$('chooseCodexApiKey')?.addEventListener('click', () => setAccountModal(true, 'add'));
$('cancelCodexOAuth')?.addEventListener('click', async () => {
  const note = $('codexOAuthNote');
  if (note?.dataset.state) await fetch(`/api/providers/codex/oauth/cancel/${encodeURIComponent(note.dataset.state)}`, { method: 'POST' }).catch(() => {});
  clearInterval(codexOAuthTimer);
  codexOAuthTimer = null;
  if (note) { note.textContent = 'OAuth cancelled.'; delete note.dataset.state; }
});
$('startCodexOAuth')?.addEventListener('click', async () => {
  const note = $('codexOAuthNote');
  if (note) note.textContent = 'Starting secure local OAuth…';
  try {
    const response = await fetch('/api/providers/codex/oauth/start', { method: 'POST' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || 'Could not start OAuth.');
    window.open(body.authorizeUrl, '_blank', 'noopener');
    if (note) { note.textContent = 'Complete login in the new tab. Waiting for the local callback…'; note.dataset.state = body.state; }
    clearInterval(codexOAuthTimer);
    codexOAuthTimer = setInterval(async () => {
      const statusResponse = await fetch(`/api/providers/codex/oauth/status/${encodeURIComponent(body.state)}`).catch(() => null);
      const status = await statusResponse?.json().catch(() => ({}));
      if (status?.status === 'complete') {
        clearInterval(codexOAuthTimer);
        codexOAuthTimer = null;
        if (note) note.textContent = 'Codex login complete. Refreshing accounts…';
        await loadDetail();
        setAccountModal(false);
      } else if (status?.status === 'unknown') {
        clearInterval(codexOAuthTimer);
        codexOAuthTimer = null;
        if (note) note.textContent = 'OAuth expired or was cancelled. Start again if needed.';
      }
    }, 1500);
  } catch (err) {
    if (note) note.textContent = err.message;
  }
});
$('closeAccountModal')?.addEventListener('click', closeAccountModal);
$('cancelAddAccount')?.addEventListener('click', closeAccountModal);
$('cancelBulk')?.addEventListener('click', closeAccountModal);
$('accountModal')?.addEventListener('click', (event) => {
  if (event.target.closest('[data-modal-close]')) closeAccountModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && accountModalMode) closeAccountModal();
});

function previewStatusLabel(status) {
  return {
    new: ['new', 'New'],
    duplicate: ['duplicate', 'Already exists'],
    duplicate_input: ['duplicate', 'Duplicate in paste'],
    invalid: ['invalid', 'Invalid'],
  }[status] || ['invalid', status];
}

function renderAccountPreview(preview) {
  const summary = $('accountPreviewSummary');
  const list = $('accountPreviewList');
  if (!summary || !list) return;
  summary.innerHTML = `<strong>${fmtFull(preview.total)} checked</strong><span>${fmtFull(preview.fresh)} new</span><span>${fmtFull(preview.duplicates)} duplicates</span><span>${fmtFull(preview.invalid)} invalid</span>`;
  list.innerHTML = (preview.items || []).map((item) => {
    const [tone, label] = previewStatusLabel(item.status);
    return `<div class="account-preview-row">
      <span class="account-preview-index">${item.index + 1}</span>
      <span class="account-preview-main"><strong>${escapeHtml(item.label || item.uid || `Account ${item.index + 1}`)}</strong><small>${escapeHtml(item.masked)} · ${escapeHtml(item.kind.replace(/_/g, ' '))}</small></span>
      <span class="preview-pill ${tone}">${escapeHtml(label)}</span>
      ${item.error ? `<span class="account-preview-error">${escapeHtml(item.error)}</span>` : ''}
    </div>`;
  }).join('');
  detailNote($('accountPreviewNote'), preview.truncated ? `${fmtFull(preview.truncated)} more rows omitted from preview.` : 'Review the masked rows, then confirm.', '');
}

async function previewAccountEntries(entries, note) {
  const res = await detailApi('/accounts/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accounts: entries }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
  accountPreviewEntries = entries;
  accountPreviewPayload = body;
  renderAccountPreview(body);
  $('addAccountPanel')?.setAttribute('hidden', '');
  $('bulkEditView')?.setAttribute('hidden', '');
  $('accountPreview')?.removeAttribute('hidden');
  detailNote(note, 'Preview ready.', 'ok');
}

async function confirmAccountImport() {
  if (!accountPreviewEntries?.length || !currentDetailId) return;
  const button = $('confirmAccountImport');
  const note = $('accountPreviewNote');
  button.disabled = true;
  detailNote(note, 'Adding checked rows…');
  try {
    const res = await detailApi('/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accounts: accountPreviewEntries }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    accounts.data = body;
    accounts.page = 1;
    renderAccounts();
    closeAccountModal();
    detailNote($('accountNote'), `${fmtFull(body.added)} added${body.duplicates ? ` · ${fmtFull(body.duplicates)} duplicates skipped` : ''}.`, 'ok');
  } catch (err) {
    detailNote(note, err.message, 'bad');
  } finally {
    button.disabled = false;
  }
}

$('confirmAccountImport')?.addEventListener('click', confirmAccountImport);
$('backAccountEdit')?.addEventListener('click', () => {
  $('accountPreview')?.setAttribute('hidden', '');
  if (accountModalMode === 'bulk') $('bulkEditView')?.removeAttribute('hidden');
  else $('addAccountPanel')?.removeAttribute('hidden');
});

$('addAccountForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentDetailId) return;
  const form = event.currentTarget;
  const note = $('addAccountNote');
  const button = form.querySelector('button[type="submit"]');
  const data = Object.fromEntries(new FormData(form).entries());
  button.disabled = true;
  detailNote(note, 'Checking for duplicates…');
  try {
    await previewAccountEntries([data], note);
  } catch (err) {
    detailNote(note, err.message, 'bad');
  } finally {
    button.disabled = false;
  }
});

function invalidateAccountPreview() {
  if (!$('accountPreview') || $('accountPreview').hidden) return;
  accountPreviewPayload = null;
  accountPreviewEntries = null;
  $('accountPreview').setAttribute('hidden', '');
  if (accountModalMode === 'bulk') $('bulkEditView')?.removeAttribute('hidden');
  else $('addAccountPanel')?.removeAttribute('hidden');
  detailNote($(accountModalMode === 'bulk' ? 'bulkNote' : 'addAccountNote'), 'Input changed. Preview again before importing.');
}

$('bulkFile')?.addEventListener('change', async (event) => {
  invalidateAccountPreview();
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    $('bulkInput').value = await file.text();
    detailNote($('bulkNote'), `${file.name} loaded. Press Check duplicates.`, 'ok');
  } catch (err) {
    detailNote($('bulkNote'), `Could not read the file: ${err.message}`, 'bad');
  }
});

$('bulkInput')?.addEventListener('input', invalidateAccountPreview);
$('addAccountForm')?.addEventListener('input', invalidateAccountPreview);

$('importBulk')?.addEventListener('click', async () => {
  if (!currentDetailId) return;
  const note = $('bulkNote');
  const button = $('importBulk');
  let entries;
  try {
    entries = parseBulk($('bulkInput').value);
  } catch (err) {
    detailNote(note, `That is not valid JSON: ${err.message}`, 'bad');
    return;
  }
  if (!entries.length) {
    detailNote(note, 'Paste a JSON array, or one token per line.', 'bad');
    return;
  }

  button.disabled = true;
  detailNote(note, `Checking ${fmtFull(entries.length)} accounts for duplicates…`);
  try {
    await previewAccountEntries(entries, note);
  } catch (err) {
    detailNote(note, err.message, 'bad');
  } finally {
    button.disabled = false;
  }
});

$('accountFilters')?.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-status]');
  if (!chip) return;
  accounts.status = chip.dataset.status;
  accounts.page = 1;
  accounts.selected.clear();
  paintFilterChips();
  loadAccounts();
});

$('accountSearch')?.addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  const value = event.target.value.trim();
  searchTimer = setTimeout(() => {
    accounts.q = value;
    accounts.page = 1;
    accounts.selected.clear();
    loadAccounts();
  }, 250);
});

$('accountPageSize')?.addEventListener('change', (event) => {
  accounts.pageSize = Number(event.target.value) || 20;
  accounts.page = 1;
  accounts.selected.clear();
  loadAccounts();
});

$('accountPrev')?.addEventListener('click', () => {
  if (accounts.page <= 1) return;
  accounts.page -= 1;
  accounts.selected.clear();
  loadAccounts();
});

$('accountNext')?.addEventListener('click', () => {
  if (accounts.data && accounts.page >= accounts.data.pages) return;
  accounts.page += 1;
  accounts.selected.clear();
  loadAccounts();
});

$('selectAllAccounts')?.addEventListener('change', (event) => {
  const ids = accounts.data?.items.map((item) => item.id) || [];
  if (event.target.checked) ids.forEach((id) => accounts.selected.add(id));
  else ids.forEach((id) => accounts.selected.delete(id));
  renderAccounts();
});

$('dAccounts')?.addEventListener('change', (event) => {
  const box = event.target.closest('[data-select]');
  if (!box) return;
  if (box.checked) accounts.selected.add(box.dataset.select);
  else accounts.selected.delete(box.dataset.select);
  box.closest('tr')?.classList.toggle('is-selected', box.checked);
  updateBulkBar();

  const selectAll = $('selectAllAccounts');
  const ids = accounts.data?.items.map((item) => item.id) || [];
  const picked = ids.filter((id) => accounts.selected.has(id)).length;
  if (selectAll) {
    selectAll.checked = ids.length > 0 && picked === ids.length;
    selectAll.indeterminate = picked > 0 && picked < ids.length;
  }
});

let accountActionsId = null;
let accountActionsOpener = null;

function closeAccountActions() {
  const modal = $('accountActionsModal');
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  accountActionsId = null;
  requestAnimationFrame(() => accountActionsOpener?.focus?.());
  accountActionsOpener = null;
}

function openAccountActions(id, opener) {
  const account = accounts.data?.items.find((item) => item.id === id);
  if (!account) return;
  accountActionsId = id;
  accountActionsOpener = opener;
  $('accountActionsTitle').textContent = account.label || 'Account actions';
  $('accountActionsMessage').textContent = `${account.kind.replace(/_/g, ' ')} · ${account.status}`;
  $('accountActionsList').innerHTML = [
    account.kind === 'api_key'
      ? '<p class="account-action-note">Check-in needs an OAuth token.</p>'
      : '<button class="account-action-button" type="button" data-account-action="checkin">Check in</button>',
    `<button class="account-action-button" type="button" data-account-action="toggle">${account.enabled ? 'Pause account' : 'Resume account'}</button>`,
    '<button class="account-action-button danger" type="button" data-account-action="delete">Remove account</button>',
  ].join('');
  $('accountActionsModal').hidden = false;
  $('accountActionsList').querySelector('button')?.focus();
}

$('dAccounts')?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === 'more') return openAccountActions(id, btn);
  if (act === 'test') testOne(id);
  if (act === 'checkin') checkinOne(id);
  if (act === 'toggle') toggleOne(id);
  if (act === 'delete') deleteOne(id).then(() => loadAccounts());
});

document.querySelectorAll('[data-account-actions-close]').forEach((el) => el.addEventListener('click', closeAccountActions));
$('accountActionsList')?.addEventListener('click', (event) => {
  const action = event.target.closest('[data-account-action]')?.dataset.accountAction;
  const id = accountActionsId;
  if (!action || !id) return;
  closeAccountActions();
  if (action === 'checkin') checkinOne(id);
  if (action === 'toggle') toggleOne(id);
  if (action === 'delete') deleteOne(id).then(() => loadAccounts());
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('accountActionsModal').hidden) closeAccountActions();
});

$('bulkActions')?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-bulk]');
  if (!btn) return;
  bulkAction(btn.dataset.bulk);
});

document.querySelectorAll('[data-quota-columns]').forEach((button) => {
  button.addEventListener('click', () => {
    quotaColumns = Number(button.dataset.quotaColumns);
    localStorage.setItem('norouter.quotaColumns', String(quotaColumns));
    paintQuotaColumns();
  });
});
$('refreshUpstreamQuota')?.addEventListener('click', () => loadUpstreamQuota());
$('refreshQuotaOrder')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (!currentDetailId || button.disabled) return;
  button.disabled = true;
  detailNote($('upstreamQuotaNote'), 'Refreshing quota order for every account…');
  try {
    const res = await detailApi('/accounts/quota-order/refresh', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
    detailNote($('upstreamQuotaNote'), `${fmtFull(body.withQuota)} with quota · ${fmtFull(body.empty)} empty · ${fmtFull(body.unavailable)} unavailable.`, 'ok');
    await loadUpstreamQuota({ reset: true });
  } catch (err) {
    detailNote($('upstreamQuotaNote'), err.message, 'bad');
  } finally {
    button.disabled = false;
  }
});
$('dUpstreamQuota')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-package-page]');
  if (!button || button.disabled) return;
  const id = button.dataset.accountId;
  const current = quotaPage.packagePages.get(id) || 1;
  quotaPage.packagePages.set(id, Math.max(1, current + (button.dataset.packagePage === 'next' ? 1 : -1)));
  renderUpstreamQuota();
});
$('quotaPrev')?.addEventListener('click', () => {
  if (quotaPage.page <= 1 || quotaPage.loading) return;
  quotaPage.page -= 1;
  loadUpstreamQuota();
});
$('quotaNext')?.addEventListener('click', () => {
  if (!quotaPage.data || quotaPage.page >= quotaPage.data.pages || quotaPage.loading) return;
  quotaPage.page += 1;
  loadUpstreamQuota();
});

/* ---------------- data + routing glue ---------------- */

function renderRecent(data, report = dashboardUsageData) {
  const table = $('recentTable');
  if (!table) return;

  const rows = report?.activity || [];
  $('recentCount').textContent = `${rows.length}`;
  if (!rows.length) {
    if (dashboardSignature('dashboard.recent', [])) table.innerHTML = `<tr><td colspan="4" class="empty-cell">
      <div class="list-empty"><strong>No requests yet</strong><span>Recent calls appear here with model, tokens, latency and status.</span></div>
    </td></tr>`;
    return;
  }

  const recentSignature = rows.map((r) => [r.at, r.model, r.tokensIn, r.tokensOut, r.ms, r.ok, r.status]);
  if (!dashboardSignature('dashboard.recent', recentSignature)) return;
  table.innerHTML = rows.map((r) => {
    const tokens = r.tokensIn + r.tokensOut;
    return `<tr>
      <td class="model">${escapeHtml(r.model || 'unknown')}</td>
      <td class="r">${r.ok ? fmtFull(tokens) : '—'}</td>
      <td class="r">${r.ms == null ? '—' : r.ms + ' ms'}</td>
      <td class="r"><span class="pill ${r.ok ? 'ok' : 'bad'}">${r.ok ? (r.status || 'ok') : 'error'}</span></td>
    </tr>`;
  }).join('');

  trimRecentToCard();
  padRecentToCard();
  requestAnimationFrame(() => {
    trimRecentToCard();
    padRecentToCard();
  });
}

// Rows are dropped from the bottom until the table fits its card, so a tall
// screen shows more history and a short one shows less, never a half row.
function trimRecentToCard() {
  const body = $('recentTable');
  const wrap = body?.closest('.table-wrap');
  const table = wrap?.querySelector('table');
  if (!wrap || !table) return;

  const rows = [...body.children].filter((row) => !row.classList.contains('rghost'));
  let guard = rows.length + 4;
  while (rows.length > 1 && guard-- > 0) {
    const available = wrap.clientHeight;
    if (!available || available < 60) return;
    // Measure the whole table: the header row is part of what has to fit.
    if (table.getBoundingClientRect().height <= available + 1) return;
    rows.pop().remove();
  }
}

// A short history leaves the bottom of the card blank; placeholder rows keep it
// filled without pretending to be data. They are added in one batch and the
// overshoot is trimmed off the end, because the card's final height is only
// known once the browser has laid out the rest of the board.
function padRecentToCard() {
  const body = $('recentTable');
  const wrap = body?.closest('.table-wrap');
  const table = wrap?.querySelector('table');
  if (!wrap || !table) return;

  for (const ghost of [...body.querySelectorAll('.rghost')]) ghost.remove();

  const first = body.firstElementChild;
  if (!first || first.querySelector('.empty')) return;

  const available = wrap.clientHeight;
  if (!available) return;

  const widths = [74, 56, 66, 48, 61];
  const ghosts = [];
  // Append optimistically, then drop whatever overshoots: the exact height of a
  // placeholder row depends on the theme's font scale, so guessing it up front
  // would either stop early or clip.
  while (ghosts.length < 40 && table.getBoundingClientRect().height + 24 <= available) {
    const i = ghosts.length;
    const tr = document.createElement('tr');
    tr.className = 'rghost';
    tr.innerHTML = `<td colspan="4"><span class="ghostbar" style="width:${widths[i % widths.length]}%"></span></td>`;
    body.appendChild(tr);
    ghosts.push(tr);
  }

  while (ghosts.length && table.getBoundingClientRect().height > available + 1) {
    ghosts.pop().remove();
  }
}

function paintDashboardRangeTabs() {
  const tabs = [...document.querySelectorAll('[data-dashboard-range]')];
  const active = tabs.find((tab) => tab.dataset.dashboardRange === dashboardUsageRange) || tabs[0];
  if (!active) return;
  dashboardUsageRange = active.dataset.dashboardRange;
  tabs.forEach((tab) => {
    const selected = tab === active;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  $('dashboardHistoryPanel')?.setAttribute('aria-labelledby', active.id);
  moveTabIndicator($('dashboardRangeTabs'), '[data-dashboard-range].is-active');
}

async function loadDashboardUsage() {
  if (currentPath !== '/') return;
  const requestId = ++dashboardUsageRequestId;
  const requestedRange = dashboardUsageRange;
  const statsNote = $('dashboardHistoryStatsNote');
  const requestsNote = $('dashboardHistoryRequestsNote');
  if (statsNote) statsNote.textContent = 'Loading historical usage…';
  if (requestsNote) requestsNote.textContent = 'Loading historical usage…';
  try {
    // Reuse the Usage report contract; dashboard reads only its persisted totals.
    const res = await fetch(`/api/usage?range=${encodeURIComponent(requestedRange)}`, { cache: 'no-store' });
    const report = await res.json();
    if (!res.ok) throw new Error(report.error?.message || 'Could not load historical usage.');
    if (requestId !== dashboardUsageRequestId || requestedRange !== dashboardUsageRange || currentPath !== '/') return;
    dashboardUsageData = report;
    renderStatistics(latest || {}, report);
    renderRequests(latest || {}, report);
    renderModels(latest || {}, report);
    renderRecent(latest || {}, report);
    renderEvents(latest || {}, report);
    renderDashboardHistorical(report);
  } catch (err) {
    if (requestId !== dashboardUsageRequestId || requestedRange !== dashboardUsageRange) return;
    dashboardUsageData = null;
    if (statsNote) statsNote.textContent = err.message;
    if (requestsNote) requestsNote.textContent = err.message;
  }
}

$('dashboardRangeTabs')?.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-dashboard-range]');
  if (!tab || tab.dataset.dashboardRange === dashboardUsageRange) return;
  dashboardUsageRange = tab.dataset.dashboardRange;
  paintDashboardRangeTabs();
  loadDashboardUsage();
});
$('dashboardRangeTabs')?.addEventListener('keydown', (event) => {
  const tabs = [...document.querySelectorAll('[data-dashboard-range]')];
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
  dashboardUsageRange = tabs[next].dataset.dashboardRange;
  paintDashboardRangeTabs();
  loadDashboardUsage();
});

function renderCurrent() {
  if (isDetailPath(currentPath)) {
    renderDetailPage();
    return;
  }
  if (!latest) return;
  if (currentPath === '/') {
    renderStatistics(latest, dashboardUsageData);
    renderRequests(latest, dashboardUsageData);
    renderModels(latest, dashboardUsageData);
    renderRecent(latest, dashboardUsageData);
    // Last: it measures the finished middle column to size itself.
    renderEvents(latest, dashboardUsageData);
    paintDashboardRangeTabs();
    if (!dashboardUsageData || dashboardUsageData.range !== dashboardUsageRange) loadDashboardUsage();
    else renderDashboardHistorical(dashboardUsageData);
  } else if (currentPath === '/providers') {
    renderProviderCards(latest);
  } else if (currentPath === '/usage') {
    renderUsage();
  } else if (currentPath === '/combos') {
    renderCombos();
  } else if (currentPath === '/settings') {
    renderSettings(latest);
  } else if (currentPath === '/api-keys') {
    renderApiKeys();
  }
}

async function refresh() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error(`status ${res.status}`);
    latest = await res.json();

    if (isDetailPath(currentPath)) {
      await loadDetail({ quiet: true });
      return;
    }

    renderCurrent();
    if (currentPath === '/providers') refreshProviderQuota();

    if (currentPath === '/usage') loadUsage({ fromPoll: true });

    if (currentPath === '/') {
      loadDashboardUsage();
      const total = latest.providers.length;
      const ready = latest.providers.filter((p) => isReady(p.credential)).length;
      $('tagline').textContent = ready === total
        ? `${ready} of ${total} providers ready · ${latest.requests} requests served`
        : `${ready} of ${total} providers ready · waiting for credentials`;
    }
  } catch {
    if (currentPath === '/') $('tagline').textContent = 'Dashboard disconnected — is the server still running?';
  }
}

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

/* ---------------- boot ---------------- */

function paintDate() {
  const now = new Date();
  $('todayLabel').textContent = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  $('todayAlt').textContent = now.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric' });
}

const bootStartedAt = performance.now();
let splashDismissScheduled = false;

function dismissSplash() {
  const splash = $('appSplash');
  if (!splash || splashDismissScheduled) return;
  splashDismissScheduled = true;
  const remove = () => {
    splash.remove();
    booting = false;
    document.documentElement.classList.remove('dashboard-booting');
  };
  if (motionReduced()) {
    remove();
    return;
  }
  const finish = () => {
    splash.classList.add('is-done');
    window.setTimeout(remove, 300);
  };
  const remaining = Math.max(0, 260 - (performance.now() - bootStartedAt));
  window.setTimeout(() => requestAnimationFrame(finish), remaining);
}

paintDate();
paintAppearanceControls();
$('baseUrl').textContent = `${location.origin}/v1`;
navigate(location.pathname, { push: false, initial: true });
refresh();
requestAnimationFrame(() => requestAnimationFrame(dismissSplash));

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderCurrent, 180);
});

// The log card's height depends on the tallest sibling column, so it can settle
// after render. Re-trim whenever its own box changes.
const eventCard = $('eventList')?.closest('.card');
const recentCard = $('recentTable')?.closest('.card');
if ('ResizeObserver' in window) {
  const observer = new ResizeObserver(() => {
    if (currentPath !== '/') return;
    requestAnimationFrame(() => {
      trimEventsToColumn();
      trimModelsToCard();
      trimRecentToCard();
      padRecentToCard();
    });
  });
  if (eventCard) observer.observe(eventCard);
  if (recentCard) observer.observe(recentCard);
}

setInterval(() => {
  if (document.visibilityState === 'visible') refresh();
}, REFRESH_MS);
