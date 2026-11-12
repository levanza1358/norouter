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

