const codebuddy = {
  'glm-5.3': [true, true, true, 1_000_000, 48_000],
  'glm-5.3-flash': [true, true, true, 1_000_000, 32_000],
  'glm-5.2': [true, true, true, 1_000_000, 48_000],
  'glm-5.1': [true, true, false, 200_000, 48_000],
  'minimax-m3': [true, true, false, 512_000, 128_000],
  hy3: [true, true, false, 192_000, 64_000],
  'hy4-preview': [true, true, false, 1_000_000, 64_000],
  'kimi-k3-1': [true, true, false, 1_000_000, 32_000],
  'deepseek-v4-pro': [true, true, true, 1_000_000, 50_000],
  'deepseek-v4.1-flash': [true, true, true, 1_000_000, 128_000],
};

// Antigravity exposes no capability document, so these follow how the gateway
// groups its catalog: Gemini and Claude accept images, gpt-oss is text-only,
// and the reasoning tier is baked into the model id (it cannot be turned off
// per request). Output is clamped to the adapter's 64K ceiling.
function antigravityRow(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (!id) return null;
  if (id.startsWith('claude-')) return [true, true, false, 200_000, 64_000, true];
  if (id.startsWith('gpt-oss')) return [true, false, false, 131_072, 32_768, false];
  if (id.startsWith('gemini-')) return [true, true, false, 1_000_000, 64_000, true];
  return null;
}

export function modelCapability(providerId, modelId) {
  const row = providerId === 'codebuddy-cn'
    ? codebuddy[modelId]
    : providerId === 'antigravity' ? antigravityRow(modelId) : null;
  if (!row) {
    return {
      input: { text: null, vision: null, pdf: { value: null, confidence: 'unknown' } },
      output: { text: null, json: { value: null, confidence: 'unknown' } },
      reasoning: { supported: null, canDisable: null, format: null },
      limits: { contextWindow: null, maxOutputTokens: null },
      provenance: 'No capability declaration for this model',
      confidence: 'unknown',
    };
  }
  const [text, vision, canDisable, contextWindow, maxOutputTokens, pdf] = row;
  return {
    input: {
      text: { value: text, confidence: 'inferred' },
      vision: { value: vision, confidence: 'verified-local' },
      pdf: { value: pdf ?? true, confidence: 'inferred' },
    },
    output: {
      text: { value: true, confidence: 'inferred' },
      json: { value: null, confidence: 'unknown' },
    },
    reasoning: {
      supported: true,
      canDisable,
      format: 'openai',
    },
    limits: { contextWindow, maxOutputTokens },
    provenance: providerId === 'antigravity'
      ? 'Antigravity model family (inferred)'
      : 'Mirai local CodeBuddy capability mirror',
    confidence: providerId === 'antigravity' ? 'inferred' : 'verified-local',
  };
}
