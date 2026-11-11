export function updateNeedsStash(status) {
  return String(status || '').trim().length > 0;
}
