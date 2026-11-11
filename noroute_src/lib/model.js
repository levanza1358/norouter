import { allModels, providers } from '../providers/index.js';
import { codexCatalog } from './codex-account.js';

// Accepts "cbcn/deepseek-v4.1-flash" and the bare "deepseek-v4.1-flash".
// Returns { provider, model } or { error }.
export function resolveModel(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: 'Field "model" must be a non-empty string' };
  }
  const name = raw.trim();
  const slash = name.indexOf('/');

  if (slash > 0) {
    const prefix = name.slice(0, slash);
    const rest = name.slice(slash + 1);
    const provider = providers.find((p) => p.id === prefix || p.prefix === prefix);
    if (provider) {
      const available = provider.id === 'codex' ? codexCatalog() : allModels(provider);
      if (!available.includes(rest)) {
        return { error: `Unknown model "${rest}" for provider "${provider.id}"` };
      }
      return { provider, model: rest };
    }
  }

  const owners = providers.filter((p) => (p.id === 'codex' ? codexCatalog() : allModels(p)).includes(name));
  if (owners.length === 1) return { provider: owners[0], model: name };
  if (owners.length > 1) {
    const options = owners.map((p) => `${p.id}/${name}`).join(', ');
    return { error: `Model "${name}" exists in several providers; use one of: ${options}` };
  }

  return { error: `Unknown model "${name}". Try GET /v1/models for the catalog.` };
}
