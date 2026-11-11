import { sendJson } from '../lib/http.js';
import { listCombos } from '../lib/combos.js';
import { allModels, providers } from '../providers/index.js';

export function handleModels(req, res) {
  const created = Math.floor(Date.now() / 1000);
  const data = [];

  for (const provider of providers) {
    for (const model of allModels(provider)) {
      data.push({
        id: `${provider.prefix}/${model}`,
        object: 'model',
        created,
        owned_by: provider.id,
      });
    }
    for (const [type, models] of [['image', provider.image?.models], ['embedding', provider.embedding?.models]]) {
      for (const model of models || []) {
        data.push({
          id: `${provider.prefix}/${model}`,
          object: 'model',
          created,
          owned_by: provider.id,
          type,
        });
      }
    }
  }

  // Combos are virtual models owned by the router itself. They are appended, so
  // adding one never hides a provider model.
  for (const combo of listCombos()) {
    data.push({
      id: combo.name,
      object: 'model',
      created: Math.floor((combo.createdAt || Date.now()) / 1000),
      owned_by: 'norouter',
    });
  }

  sendJson(res, 200, { object: 'list', data });
}
