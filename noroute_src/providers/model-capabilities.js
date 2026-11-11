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

export function modelCapability(providerId, modelId) {
  const row = providerId === 'codebuddy-cn' ? codebuddy[modelId] : null;
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
  const [text, vision, canDisable, contextWindow, maxOutputTokens] = row;
  return {
    input: {
      text: { value: text, confidence: 'inferred' },
      vision: { value: vision, confidence: 'verified-local' },
      pdf: { value: true, confidence: 'inferred' },
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
    provenance: 'Mirai local CodeBuddy capability mirror',
    confidence: 'verified-local',
  };
}
