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

