// This runs on Vercel's servers, NOT in the user's browser.
// Provider-agnostic: works with whichever API key(s) are configured in
// Vercel > Settings > Environment Variables. Supports Gemini, Grok (xAI),
// and OpenAI — auto-detects which one to use, or set AI_PROVIDER explicitly
// ('gemini' | 'grok' | 'openai') to force one when multiple keys are present.
// Also logs every question + answer to a Supabase table so the site owner
// can view them (optional — skipped safely if not configured).
export const config = { runtime: 'edge' };

function hasVal(v) { return typeof v === 'string' && v.trim().length > 0; }

// Convert the frontend's message format (role + content, where content is
// either a plain string or an array of {type:'image'|'text', ...} parts for
// photo uploads) into each provider's expected shape.

function toGeminiContents(messages) {
  return messages.map(m => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (Array.isArray(m.content)) {
      const parts = m.content
        .map(part => {
          if (part && part.type === 'image' && part.source && part.source.data) {
            return { inlineData: { mimeType: part.source.media_type || 'image/jpeg', data: part.source.data } };
          }
          if (part && part.type === 'text') return { text: part.text || '' };
          return null;
        })
        .filter(Boolean);
      return { role, parts: parts.length ? parts : [{ text: '' }] };
    }
    return { role, parts: [{ text: typeof m.content === 'string' ? m.content : String(m.content ?? '') }] };
  });
}

function toOpenAIStyleMessages(messages, systemText) {
  const out = [{ role: 'system', content: systemText }];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (Array.isArray(m.content)) {
      const parts = m.content.map(part => {
        if (part && part.type === 'image' && part.source && part.source.data) {
          return { type: 'image_url', image_url: { url: `data:${part.source.media_type || 'image/jpeg'};base64,${part.source.data}` } };
        }
        if (part && part.type === 'text') return { type: 'text', text: part.text || '' };
        return null;
      }).filter(Boolean);
      out.push({ role, content: parts.length ? parts : '' });
    } else {
      out.push({ role, content: typeof m.content === 'string' ? m.content : String(m.content ?? '') });
    }
  }
  return out;
}

function toAnthropicMessages(messages) {
  // The frontend already sends photo-upload content in Anthropic's own block shape
  // ({type:'image', source:{type:'base64', media_type, data}} / {type:'text', text}),
  // so this is close to a straight pass-through — just normalize the role name.
  return messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content
  }));
}

function buildProviderRequest(provider, model, env, messages, systemText) {
  if (provider === 'gemini') {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: {
        contents: toGeminiContents(messages),
        systemInstruction: { parts: [{ text: systemText }] },
        tools: [{ google_search: {} }]
      }
    };
  }
  if (provider === 'grok') {
    return {
      url: 'https://api.x.ai/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.GROK_API_KEY}` },
      body: { model, messages: toOpenAIStyleMessages(messages, systemText), stream: true }
    };
  }
  if (provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
      body: { model, messages: toOpenAIStyleMessages(messages, systemText), stream: true }
    };
  }
  if (provider === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: { model, system: systemText, messages: toAnthropicMessages(messages), max_tokens: 4096, stream: true }
    };
  }
  if (provider === 'custom') {
    // Works with any AI provider that exposes an OpenAI-compatible /chat/completions
    // endpoint. Set CUSTOM_API_URL (the full completions URL), CUSTOM_API_KEY, and
    // optionally CUSTOM_MODEL in Vercel's environment variables.
    return {
      url: env.CUSTOM_API_URL,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.CUSTOM_API_KEY}` },
      body: { model, messages: toOpenAIStyleMessages(messages, systemText), stream: true }
    };
  }
  return null;
}

// Every provider that's configured (has a key) gets tried, in this priority
// order — Gemini first (native search + vision + image gen), then Grok, then
// OpenAI, then Anthropic, then any custom OpenAI-compatible endpoint. If
// AI_PROVIDER is set explicitly, that one is moved to the front of the line.
function getProviderChain(env) {
  const explicit = (env.AI_PROVIDER || '').toLowerCase().trim();
  const all = ['gemini', 'grok', 'openai', 'anthropic', 'custom'];
  const available = all.filter(p => {
    if (p === 'gemini') return hasVal(env.GEMINI_API_KEY);
    if (p === 'grok') return hasVal(env.GROK_API_KEY);
    if (p === 'openai') return hasVal(env.OPENAI_API_KEY);
    if (p === 'anthropic') return hasVal(env.ANTHROPIC_API_KEY);
    if (p === 'custom') return hasVal(env.CUSTOM_API_KEY) && hasVal(env.CUSTOM_API_URL);
    return false;
  });
  if (explicit && available.includes(explicit)) {
    return [explicit, ...available.filter(p => p !== explicit)];
  }
  return available;
}

// For each provider, which models to try, in order. If the person set an
// explicit *_MODEL env var, that model is tried first; these fallbacks after
// it exist specifically so that if one particular model is unavailable,
// restricted, or rate-limited for their account (which does happen — some
// models are more limited than others on the free tier), the very next
// request automatically retries with a different, known-good model instead
// of just failing.
function putFirst(chain, explicitModel) {
  if (!hasVal(explicitModel)) return chain;
  const rest = chain.filter(m => m !== explicitModel);
  return [explicitModel, ...rest];
}

function getModelChain(provider, env) {
  if (provider === 'gemini') {
    // gemini-flash-latest is Google's own auto-updating alias — it always points
    // to whatever their current recommended Flash model is, so it keeps working
    // even after Google retires specific dated model names (which happens often).
    // The named models after it are today's (Aug 2026) current, non-deprecated
    // options, kept as a safety net in case the alias itself has an issue.
    return putFirst(['gemini-flash-latest', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'], env.GEMINI_MODEL);
  }
  if (provider === 'grok') {
    return putFirst(['grok-4.5', 'grok-4'], env.GROK_MODEL);
  }
  if (provider === 'openai') {
    return putFirst(['gpt-4o-mini', 'gpt-4o'], env.OPENAI_MODEL);
  }
  if (provider === 'anthropic') {
    return putFirst(['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'], env.ANTHROPIC_MODEL);
  }
  if (provider === 'custom') {
    return [env.CUSTOM_MODEL || 'default'];
  }
  return [];
}

// Extracts the plain-text delta from one provider's raw SSE JSON chunk.
function extractDeltaText(provider, evt) {
  if (provider === 'gemini') {
    return evt?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  if (provider === 'anthropic') {
    if (evt?.type === 'content_block_delta' && evt?.delta?.type === 'text_delta') {
      return evt.delta.text || '';
    }
    return '';
  }
  // Grok, OpenAI, and any custom OpenAI-compatible endpoint all use the same
  // chat.completion.chunk shape.
  return evt?.choices?.[0]?.delta?.content || '';
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const env = {
      AI_PROVIDER: process.env.AI_PROVIDER,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GEMINI_MODEL: process.env.GEMINI_MODEL,
      GROK_API_KEY: process.env.GROK_API_KEY,
      GROK_MODEL: process.env.GROK_MODEL,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENAI_MODEL: process.env.OPENAI_MODEL,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
      CUSTOM_API_KEY: process.env.CUSTOM_API_KEY,
      CUSTOM_API_URL: process.env.CUSTOM_API_URL,
      CUSTOM_MODEL: process.env.CUSTOM_MODEL
    };
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;

    const providerChain = getProviderChain(env);
    if (providerChain.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No AI provider is configured. Add GEMINI_API_KEY, GROK_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or CUSTOM_API_URL/CUSTOM_API_KEY in Vercel > Settings > Environment Variables.' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    let body;
    try {
      body = await req.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400 });
    }

    const messages = body.messages || [];
    const systemText = body.system || 'You are Indus AI, a helpful assistant.';
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');

    // Try every (provider, model) combination in order until one actually
    // responds successfully. This is what makes the assistant automatically
    // switch away from a specific model or provider that's down, restricted,
    // or out of quota for this account — instead of just failing.
    let provider = null, model = null, providerRes = null;
    const attempts = [];
    outer:
    for (const p of providerChain) {
      for (const m of getModelChain(p, env)) {
        const reqSpec = buildProviderRequest(p, m, env, messages, systemText);
        try {
          const res = await fetch(reqSpec.url, {
            method: 'POST',
            headers: reqSpec.headers,
            body: JSON.stringify(reqSpec.body)
          });
          if (res.ok && res.body) {
            provider = p; model = m; providerRes = res;
            break outer;
          }
          const errText = await res.text().catch(() => '');
          attempts.push(`${p}/${m}: HTTP ${res.status} — ${errText.slice(0, 200)}`);
        } catch (fetchErr) {
          attempts.push(`${p}/${m}: network error — ${String(fetchErr).slice(0, 200)}`);
        }
      }
    }

    if (!providerRes) {
      console.error('Indus AI: every provider/model attempt failed —\n' + attempts.join('\n'));
      return new Response(JSON.stringify({
        error: 'All configured AI providers/models failed to respond.',
        attempts
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const reader = providerRes.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let buffer = '';
        let fullAnswer = '';
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
              if (!line.startsWith('data:')) continue;
              const jsonStr = line.slice(5).trim();
              if (!jsonStr || jsonStr === '[DONE]') continue;
              try {
                const evt = JSON.parse(jsonStr);
                const text = extractDeltaText(provider, evt);
                if (text) {
                  fullAnswer += text;
                  const normalized = { type: 'content_block_delta', delta: { text } };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(normalized)}\n\n`));
                }
              } catch (e) { /* skip malformed chunk */ }
            }
          }
        } catch (streamErr) {
          // If reading the provider stream fails partway through, at least close cleanly.
        }
        controller.close();

        // Log this Q&A to Supabase so the site owner can view it later.
        if (supabaseUrl && supabaseKey && lastUserMessage) {
          try {
            const questionText = Array.isArray(lastUserMessage.content)
              ? (lastUserMessage.content.find(p => p && p.type === 'text')?.text || '[photo uploaded]')
              : lastUserMessage.content;
            const logRes = await fetch(`${supabaseUrl}/rest/v1/messages`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Prefer': 'return=minimal'
              },
              body: JSON.stringify({
                user_question: questionText,
                ai_answer: fullAnswer
              })
            });
            if (!logRes.ok) {
              const errBody = await logRes.text().catch(() => '');
              console.error('Indus AI: Supabase logging failed —', logRes.status, errBody);
            }
          } catch (e) {
            console.error('Indus AI: Supabase logging threw an error —', e);
          }
        } else if (!supabaseUrl || !supabaseKey) {
          console.error('Indus AI: Supabase logging skipped — SUPABASE_URL or SUPABASE_KEY is missing in this deployment.');
        }
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      }
    });

  } catch (topLevelErr) {
    // Catch-all: if anything above throws unexpectedly, always return a readable
    // error instead of letting the function crash silently (which showed as 404).
    return new Response(JSON.stringify({ error: 'Unexpected server error', detail: String(topLevelErr) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
