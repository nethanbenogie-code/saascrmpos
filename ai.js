// LysiPOS — AI adapters for Anthropic, Ollama, and LM Studio.
// All chat calls stream; caller consumes as `for await (const chunk of chatStream(...))`.

export const AI_DEFAULTS = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-haiku-4-5-20251001',
    apiKey: '',
    maxTokens: 1024,
    temperature: 0.4
  },
  ollama: {
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2',
    apiKey: '',
    maxTokens: 1024,
    temperature: 0.4
  },
  lms: {
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    apiKey: 'lm-studio',
    maxTokens: 1024,
    temperature: 0.4
  }
};

export function defaultConfig(provider) { return { ...AI_DEFAULTS[provider] }; }

/**
 * Runs a minimal round-trip against the configured provider.
 * Returns { ok, info } on success or { ok:false, error } on failure.
 */
export async function testConnection(provider, cfg) {
  try {
    if (provider === 'anthropic') {
      if (!cfg.apiKey) throw new Error('No API key set.');
      const r = await fetch((cfg.baseUrl || AI_DEFAULTS.anthropic.baseUrl) + '/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: cfg.model || AI_DEFAULTS.anthropic.model,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'ping' }]
        })
      });
      if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
      const j = await r.json();
      return { ok: true, info: `Anthropic OK · model ${j.model || cfg.model}` };
    }
    if (provider === 'ollama') {
      const r = await fetch((cfg.baseUrl || AI_DEFAULTS.ollama.baseUrl) + '/api/tags');
      if (!r.ok) throw new Error('HTTP ' + r.status + ' — is Ollama running and CORS-allowed?');
      const j = await r.json();
      const models = j.models || [];
      const has = models.some(m => (m.name === cfg.model) || (m.model === cfg.model));
      const suffix = has ? '' : ` · warning: "${cfg.model}" not installed (run: ollama pull ${cfg.model})`;
      return { ok: true, info: `Ollama OK · ${models.length} model(s) available${suffix}` };
    }
    if (provider === 'lms') {
      const r = await fetch((cfg.baseUrl || AI_DEFAULTS.lms.baseUrl) + '/models', {
        headers: { 'Authorization': 'Bearer ' + (cfg.apiKey || 'lm-studio') }
      });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' — is LM Studio server running with CORS enabled?');
      const j = await r.json();
      const list = j.data || [];
      return { ok: true, info: `LM Studio OK · ${list.length} model(s) loaded${list[0] ? ` (${list[0].id})` : ''}` };
    }
    throw new Error('Unknown provider: ' + provider);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Async generator that yields text chunks from the model.
 * @param {'anthropic'|'ollama'|'lms'} provider
 * @param {object} cfg
 * @param {string} systemPrompt
 * @param {Array<{role:'user'|'assistant',content:string}>} messages
 * @param {AbortSignal} [signal]
 */
export async function* chatStream(provider, cfg, systemPrompt, messages, signal) {
  if (provider === 'anthropic') yield* streamAnthropic(cfg, systemPrompt, messages, signal);
  else if (provider === 'ollama') yield* streamOllama(cfg, systemPrompt, messages, signal);
  else if (provider === 'lms') yield* streamOpenAI(cfg, systemPrompt, messages, signal);
  else throw new Error('Unknown provider: ' + provider);
}

async function* streamAnthropic(cfg, sys, msgs, signal) {
  const resp = await fetch((cfg.baseUrl || AI_DEFAULTS.anthropic.baseUrl) + '/v1/messages', {
    method: 'POST', signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: cfg.model || AI_DEFAULTS.anthropic.model,
      max_tokens: cfg.maxTokens || 1024,
      temperature: cfg.temperature ?? 0.4,
      system: sys,
      messages: msgs.map(m => ({ role: m.role, content: m.content })),
      stream: true
    })
  });
  if (!resp.ok) { const t = await resp.text(); throw new Error('Anthropic ' + resp.status + ': ' + t.slice(0, 300)); }
  yield* readSSE(resp.body, (data) => {
    try {
      const obj = JSON.parse(data);
      if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') return obj.delta.text;
    } catch {}
    return null;
  }, signal);
}

async function* streamOllama(cfg, sys, msgs, signal) {
  const messages = [{ role: 'system', content: sys }, ...msgs.map(m => ({ role: m.role, content: m.content }))];
  const resp = await fetch((cfg.baseUrl || AI_DEFAULTS.ollama.baseUrl) + '/api/chat', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model || AI_DEFAULTS.ollama.model,
      messages, stream: true,
      options: { temperature: cfg.temperature ?? 0.4, num_predict: cfg.maxTokens || 1024 }
    })
  });
  if (!resp.ok) { const t = await resp.text(); throw new Error('Ollama ' + resp.status + ': ' + t.slice(0, 300)); }
  yield* readNDJSON(resp.body, (obj) => obj.message?.content || null, signal);
}

async function* streamOpenAI(cfg, sys, msgs, signal) {
  const messages = [{ role: 'system', content: sys }, ...msgs.map(m => ({ role: m.role, content: m.content }))];
  const resp = await fetch((cfg.baseUrl || AI_DEFAULTS.lms.baseUrl) + '/chat/completions', {
    method: 'POST', signal,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (cfg.apiKey || 'lm-studio')
    },
    body: JSON.stringify({
      model: cfg.model || 'local-model',
      messages, stream: true,
      max_tokens: cfg.maxTokens || 1024,
      temperature: cfg.temperature ?? 0.4
    })
  });
  if (!resp.ok) { const t = await resp.text(); throw new Error('LM Studio ' + resp.status + ': ' + t.slice(0, 300)); }
  yield* readSSE(resp.body, (data) => {
    if (data === '[DONE]') return null;
    try {
      const obj = JSON.parse(data);
      return obj.choices?.[0]?.delta?.content || null;
    } catch {}
    return null;
  }, signal);
}

async function* readSSE(body, parseData, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw new Error('aborted');
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of event.split('\n')) {
          if (line.startsWith('data:')) {
            const chunk = parseData(line.slice(5).trim());
            if (chunk) yield chunk;
          }
        }
      }
    }
  } finally { try { reader.cancel(); } catch {} }
}

async function* readNDJSON(body, extract, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw new Error('aborted');
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          const chunk = extract(obj);
          if (chunk) yield chunk;
        } catch {}
      }
    }
  } finally { try { reader.cancel(); } catch {} }
}
