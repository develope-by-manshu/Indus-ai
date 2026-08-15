// This runs on Vercel's servers, NOT in the user's browser.
// Provider-agnostic: works with whichever API key(s) are configured in
// Vercel > Settings > Environment Variables. Supports Gemini, Grok (xAI),
// and OpenAI — auto-detects which one to use, or set AI_PROVIDER explicitly
// ('gemini' | 'grok' | 'openai') to force one when multiple keys are present.
// Also logs every question + answer to a Supabase table so the site owner
// can view them (optional — skipped safely if not configured).
export const config = { runtime: 'edge' };

function pickProvider(env) {
  const explicit = (env.AI_PROVIDER || '').toLowerCase().trim();
  if (explicit === 'grok' && env.GROK_API_KEY) return 'grok';
  if (explicit === 'openai' && env.OPENAI_API_KEY) return 'openai';
  if (explicit === 'gemini' && env.GEMINI_API_KEY) return 'gemini';
  // Auto-detect: prefer Gemini (native Google Search grounding + vision + image gen
  // already wired for it), then Grok, then OpenAI.
  if (env.GEMINI_API_KEY) return 'gemini';
  if (env.GROK_API_KEY) return 'grok';
  if (env.OPENAI_API_KEY) return 'openai';
  return null;
}

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

function buildProviderRequest(provider, env, messages, systemText) {
  if (provider === 'gemini') {
    const model = env.GEMINI_MODEL || 'gemini-3.5-flash';
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
    const model = env.GROK_MODEL || 'grok-4.5';
    return {
      url: 'https://api.x.ai/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.GROK_API_KEY}` },
      body: { model, messages: toOpenAIStyleMessages(messages, systemText), stream: true }
    };
  }
  if (provider === 'openai') {
    const model = env.OPENAI_MODEL || 'gpt-4o-mini';
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
      body: { model, messages: toOpenAIStyleMessages(messages, systemText), stream: true }
    };
  }
  return null;
}

// Extracts the plain-text delta from one provider's raw SSE JSON chunk.
function extractDeltaText(provider, evt) {
  if (provider === 'gemini') {
    return evt?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  // Grok and OpenAI both use the OpenAI chat.completion.chunk shape.
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
      OPENAI_MODEL: process.env.OPENAI_MODEL
    };
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;

    const provider = pickProvider(env);
    if (!provider) {
      return new Response(
        JSON.stringify({ error: 'No AI provider is configured. Add GEMINI_API_KEY, GROK_API_KEY, or OPENAI_API_KEY in Vercel > Settings > Environment Variables.' }),
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

    const reqSpec = buildProviderRequest(provider, env, messages, systemText);

    let providerRes;
    try {
      providerRes = await fetch(reqSpec.url, {
        method: 'POST',
        headers: reqSpec.headers,
        body: JSON.stringify(reqSpec.body)
      });
    } catch (fetchErr) {
      return new Response(JSON.stringify({ error: `Could not reach ${provider} API`, detail: String(fetchErr) }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!providerRes.ok || !providerRes.body) {
      const errText = await providerRes.text().catch(() => '');
      return new Response(JSON.stringify({ error: `${provider} request failed`, status: providerRes.status, detail: errText }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
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
