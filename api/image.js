// Generates (or edits) an image using whichever AI provider is configured.
// Tries every available provider AND every model within that provider (in
// order) until one actually succeeds — so if one specific model is down,
// restricted, or out of quota for this account, the next one is tried
// automatically instead of just failing.
export const config = { runtime: 'edge' };

function hasVal(v) { return typeof v === 'string' && v.trim().length > 0; }

function getProviderChain(env) {
  const explicit = (env.AI_PROVIDER || '').toLowerCase().trim();
  const all = ['gemini', 'grok'];
  const available = all.filter(p => {
    if (p === 'gemini') return hasVal(env.GEMINI_API_KEY);
    if (p === 'grok') return hasVal(env.GROK_API_KEY);
    return false;
  });
  if (explicit && available.includes(explicit)) {
    return [explicit, ...available.filter(p => p !== explicit)];
  }
  return available;
}

function putFirst(chain, explicitModel) {
  if (!hasVal(explicitModel)) return chain;
  return [explicitModel, ...chain.filter(m => m !== explicitModel)];
}

function getModelChain(provider, env) {
  if (provider === 'gemini') return putFirst(['gemini-2.5-flash-image'], env.GEMINI_MODEL_IMAGE);
  if (provider === 'grok') return putFirst(['grok-2-image'], env.GROK_MODEL_IMAGE);
  return [];
}

async function tryGemini(env, model, prompt, referenceImage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const parts = [];
  if (referenceImage && referenceImage.base64) {
    parts.push({ inlineData: { mimeType: referenceImage.mediaType || 'image/jpeg', data: referenceImage.base64 } });
  }
  parts.push({ text: prompt || 'Create a new image inspired by the attached photo.' });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, detail: data, status: res.status };

  const responseParts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = responseParts.find(p => p.inlineData || p.inline_data);
  const textPart = responseParts.find(p => p.text);
  const inline = imagePart ? (imagePart.inlineData || imagePart.inline_data) : null;
  if (!inline || !inline.data) return { ok: false, detail: data, status: 200, noImage: true };

  const mime = inline.mimeType || inline.mime_type || 'image/png';
  return { ok: true, image: `data:${mime};base64,${inline.data}`, text: textPart ? textPart.text : '' };
}

async function tryGrok(env, model, prompt, referenceImage) {
  if (referenceImage) {
    // xAI's images endpoint is text-to-image only — no reference-image editing.
    // This isn't a failure to retry; it's a real capability gap, so say so clearly
    // rather than silently falling through.
    return { ok: false, unsupported: true, detail: 'Grok does not support editing an uploaded photo — only Gemini does.' };
  }
  const res = await fetch('https://api.x.ai/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.GROK_API_KEY}` },
    body: JSON.stringify({ model, prompt, response_format: 'b64_json' })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, detail: data, status: res.status };

  const item = data?.data?.[0];
  if (!item) return { ok: false, detail: data, noImage: true };
  if (item.b64_json) return { ok: true, image: `data:image/jpeg;base64,${item.b64_json}`, text: item.revised_prompt || '' };
  if (item.url) return { ok: true, imageUrl: item.url, text: item.revised_prompt || '' };
  return { ok: false, detail: data, unrecognized: true };
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const env = {
      AI_PROVIDER: process.env.AI_PROVIDER,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GEMINI_MODEL_IMAGE: process.env.GEMINI_MODEL_IMAGE,
      GROK_API_KEY: process.env.GROK_API_KEY,
      GROK_MODEL_IMAGE: process.env.GROK_MODEL_IMAGE
    };

    const providerChain = getProviderChain(env);
    if (providerChain.length === 0) {
      return new Response(JSON.stringify({ error: 'No AI provider configured for image generation. Add GEMINI_API_KEY or GROK_API_KEY in Vercel > Settings > Environment Variables.' }), {
        status: 500, headers: { 'Content-Type': 'application/json' }
      });
    }

    let body;
    try {
      body = await req.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400 });
    }

    const prompt = (body.prompt || '').trim();
    const referenceImage = body.referenceImage;
    if (!prompt && !referenceImage) {
      return new Response(JSON.stringify({ error: 'A prompt describing the image is required' }), { status: 400 });
    }

    const attempts = [];
    let lastUnsupportedMsg = null;

    for (const provider of providerChain) {
      for (const model of getModelChain(provider, env)) {
        let result;
        try {
          result = provider === 'gemini'
            ? await tryGemini(env, model, prompt, referenceImage)
            : await tryGrok(env, model, prompt, referenceImage);
        } catch (fetchErr) {
          attempts.push(`${provider}/${model}: network error — ${String(fetchErr).slice(0, 200)}`);
          continue;
        }
        if (result.ok) {
          return new Response(JSON.stringify({ image: result.image, imageUrl: result.imageUrl, text: result.text }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
          });
        }
        if (result.unsupported) {
          lastUnsupportedMsg = result.detail;
          continue;
        }
        attempts.push(`${provider}/${model}: ${result.status || ''} ${JSON.stringify(result.detail).slice(0, 200)}`);
      }
    }

    console.error('Indus AI: every image provider/model attempt failed —\n' + attempts.join('\n'));
    return new Response(JSON.stringify({
      error: lastUnsupportedMsg && attempts.length === 0 ? lastUnsupportedMsg : 'Could not generate an image with any configured provider/model.',
      attempts
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (topLevelErr) {
    return new Response(JSON.stringify({ error: 'Unexpected server error', detail: String(topLevelErr) }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
