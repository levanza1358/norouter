// Input-side token saver: compresses tool output before it reaches the model.
// Pure string transforms — no network, no dependency. Every filter fails open:
// if it cannot shrink the text or throws, the original text is returned so a
// request is never broken by compression.

const MAX_OUTPUT_LINES = 600;
const HEAD_LINES = 120;
const TAIL_LINES = 120;
const SNIFF_BYTES = 2048;

// Keeps the head and tail of a large output, eliding the middle.
function smartTruncate(text) {
  const lines = text.split('\n');
  if (lines.length <= MAX_OUTPUT_LINES) return text;
  const head = lines.slice(0, HEAD_LINES);
  const tail = lines.slice(-TAIL_LINES);
  const removed = lines.length - HEAD_LINES - TAIL_LINES;
  return [...head, `… ${removed} lines omitted …`, ...tail].join('\n');
}

// Collapses consecutive duplicate lines, the most common waste in logs. Runs of
// two are kept verbatim so a short repeated line never grows.
function dedupLog(text) {
  const lines = text.split('\n');
  const out = [];
  let run = null;
  const flush = () => {
    if (!run) return;
    if (run.count === 1) out.push(run.text);
    else if (run.count === 2) out.push(run.text, run.text);
    else out.push(`${run.text}  (×${run.count})`);
    run = null;
  };
  for (const line of lines) {
    if (run && run.text === line) {
      run.count += 1;
      continue;
    }
    flush();
    run = { text: line, count: 1 };
  }
  flush();
  return out.join('\n');
}

// git diff: drop unchanged context lines, keep hunks compact and readable.
function gitDiff(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (line.startsWith(' ')) continue; // context line carries no new info
    out.push(line);
  }
  return out.join('\n');
}

// grep output "file:line: text" or "file: text": dedupe exact lines and cap.
function grepLike(text) {
  const seen = new Set();
  const out = [];
  for (const line of text.split('\n')) {
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= MAX_OUTPUT_LINES) {
      out.push('… output truncated …');
      break;
    }
  }
  return out.join('\n');
}

const SNIFFERS = [
  { test: (head) => /^(diff --git |index [0-9a-f]{7,}|@@ -\d+,\d+)/m.test(head), filter: gitDiff },
  { test: (head) => /^\S+:\d+[:)]?\s/m.test(head), filter: grepLike },
];

function sniff(head) {
  for (const entry of SNIFFERS) if (entry.test(head)) return entry.filter;
  return null;
}

export function compressToolOutput(text) {
  if (typeof text !== 'string' || !text) return text;
  const filter = sniff(text.slice(0, SNIFF_BYTES));
  const filtered = filter ? filter(text) : dedupLog(text);
  const out = smartTruncate(filtered);
  // Fail open: never hand back more than we were given.
  return out.length < text.length ? out : text;
}

// Walks a chat body and compresses every tool output, in both the OpenAI
// `role:"tool"` message shape and the Anthropic `tool_result` content-part shape.
export function applyRtk(body, settings = {}) {
  if (!settings.rtk?.enabled || !Array.isArray(body?.messages)) return body;
  let changed = false;
  const messages = body.messages.map((message) => {
    if (!message) return message;
    if (Array.isArray(message.content)) {
      let here = false;
      const parts = message.content.map((part) => {
        if (part?.type !== 'tool_result' || typeof part.content !== 'string') return part;
        const out = compressToolOutput(part.content);
        if (out !== part.content) here = true;
        return out === part.content ? part : { ...part, content: out };
      });
      if (here) changed = true;
      return here ? { ...message, content: parts } : message;
    }
    if (message.role === 'tool' && typeof message.content === 'string') {
      const out = compressToolOutput(message.content);
      if (out !== message.content) {
        changed = true;
        return { ...message, content: out };
      }
    }
    return message;
  });
  return changed ? { ...body, messages } : body;
}
