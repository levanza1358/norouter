import { randomUUID } from 'node:crypto';

import { getDb, transaction } from './db.js';

const TITLE_MAX = 120;
const CONTENT_MAX = 1_500_000;
const SESSION_MESSAGE_MAX = 200;

function cleanText(value, limit) {
  return String(value ?? '').replace(/\0/g, '').trim().slice(0, limit);
}

function parseContent(value) {
  try { return JSON.parse(value); } catch { return value; }
}

function publicSession(row) {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowSession(id) {
  return getDb().prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id);
}

export function listChatSessions() {
  return getDb().prepare(
    'SELECT * FROM chat_sessions WHERE archived = 0 ORDER BY updated_at DESC, created_at DESC',
  ).all().map(publicSession);
}

export function createChatSession(input = {}) {
  const now = Date.now();
  const row = {
    id: randomUUID(),
    title: cleanText(input.title || 'New chat', TITLE_MAX) || 'New chat',
    model: cleanText(input.model, 240),
    created_at: now,
    updated_at: now,
  };
  getDb().prepare(
    'INSERT INTO chat_sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(row.id, row.title, row.model, row.created_at, row.updated_at);
  return publicSession(row);
}

export function getChatSession(id) {
  const session = rowSession(id);
  if (!session) return null;
  const messages = getDb().prepare(
    'SELECT id, seq, role, content, reasoning, status, created_at FROM chat_messages WHERE session_id = ? ORDER BY seq',
  ).all(id).map((row) => ({
    id: row.id,
    seq: row.seq,
    role: row.role,
    content: parseContent(row.content),
    reasoning: row.reasoning || '',
    status: row.status,
    createdAt: row.created_at,
  }));
  return { session: publicSession(session), messages };
}

export function updateChatSession(id, patch = {}) {
  const current = rowSession(id);
  if (!current) return null;
  const title = patch.title === undefined ? current.title : cleanText(patch.title, TITLE_MAX) || 'New chat';
  const model = patch.model === undefined ? current.model : cleanText(patch.model, 240);
  const archived = patch.archived === undefined ? current.archived : patch.archived ? 1 : 0;
  const updated = Date.now();
  getDb().prepare(
    'UPDATE chat_sessions SET title = ?, model = ?, archived = ?, updated_at = ? WHERE id = ?',
  ).run(title, model, archived, updated, id);
  return publicSession(rowSession(id));
}

export function deleteChatSession(id) {
  return transaction((db) => {
    const current = db.prepare('SELECT id FROM chat_sessions WHERE id = ?').get(id);
    if (!current) return false;
    db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
    return true;
  });
}

export function appendChatMessage(id, input = {}) {
  const session = rowSession(id);
  if (!session) return { status: 404, error: 'Chat session not found.' };
  const role = ['user', 'assistant', 'system'].includes(input.role) ? input.role : '';
  if (!role) return { status: 400, error: 'Message role is invalid.' };
  const serialized = JSON.stringify(input.content ?? '');
  if (serialized.length > CONTENT_MAX) return { status: 413, error: 'Chat message is too large.' };
  const count = getDb().prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?').get(id).count;
  if (count >= SESSION_MESSAGE_MAX) return { status: 413, error: 'Chat session has reached its message limit.' };
  const seq = Number(getDb().prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM chat_messages WHERE session_id = ?').get(id).next);
  const now = Date.now();
  const reasoning = cleanText(input.reasoning, CONTENT_MAX);
  const row = { id: randomUUID(), session_id: id, seq, role, content: serialized, reasoning, status: input.status || 'complete', created_at: now };
  transaction((db) => {
    db.prepare('INSERT INTO chat_messages (id, session_id, seq, role, content, reasoning, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      row.id, row.session_id, row.seq, row.role, row.content, row.reasoning, row.status, row.created_at,
    );
    db.prepare('UPDATE chat_sessions SET model = COALESCE(NULLIF(?, \'\'), model), updated_at = ? WHERE id = ?').run(
      cleanText(input.model, 240), now, id,
    );
  });
  return { message: { id: row.id, seq, role, content: input.content ?? '', reasoning, status: row.status, createdAt: now } };
}
