// Generates (or edits) an image using whichever AI provider is configured —
// same auto-detect logic as chat.js. Gemini supports both text-to-image and
// photo+instruction editing; Grok (xAI) currently supports text-to-image only.
export const config = { runtime: 'edge' };

function hasVal(v) { return typeof v === 'string' && v.trim().length > 0; }

function pickProvider(env) {
  const explicit = (env.AI_PROVIDER || '').toLowerCase().trim();
  if (explicit === 'grok' && hasVal(env.GROK_API_KEY)) return 'grok';
  if (explicit === 'gemini' && hasVal(env.GEMINI_API_KEY)) return 'gemini';
  if (hasVal(env.GEMINI_API_KEY)) return 'gemini';
  if (hasVal(env.GROK_API_KEY)) return 'grok';
  return null;
}

async function generateWithGemini(env, prompt, referenceImage) {
  const model = env.GEMINI_MODEL_IMAGE || 'gemini-2.5-flash-image';
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
  if (!res.ok) return { error: 'Gemini image generation failed', detail: data };

  const responseParts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = responseParts.find(p => p.inlineData || p.inline_data);
  const textPart = responseParts.find(p => p.text);
  const inline = imagePart ? (imagePart.inlineData || imagePart.inline_data) : null;
  if (!inline || !inline.data) return { error: 'No image was returned by Gemini', detail: data };

  const mime = inline.mimeType || inline.mime_type || 'image/png';
  return { image: `data:${mime};base64,${inline.data}`, text: textPart ? textPart.text : '' };
}

async function generateWithGrok(env, prompt, referenceImage) {
  if (referenceImage) {
    // xAI's basic /images/generations endpoint is text-to-image only; it does not
    // accept a reference image the way Gemini does. Rather than silently ignore
    // the photo, say so clearly.
    return { error: 'Editing an uploaded photo is not yet supported with Grok. Switch AI_PROVIDER to gemini (or add GEMINI_API_KEY) to use photo-based image editing, or describe the image in words instead.' };
  }
  const model = env.GROK_MODEL_IMAGE || 'grok-2-image';
  const res = await fetch('https://api.x.ai/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.GROK_API_KEY}` },
    body: JSON.stringify({ model, prompt, response_format: 'b64_json' })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: 'Grok image generation failed', detail: data };

  const item = data?.data?.[0];
  if (!item) return { error: 'No image was returned by Grok', detail: data };
  if (item.b64_json) return { image: `data:image/jpeg;base64,${item.b64_json}`, text: item.revised_prompt || '' };
  if (item.url) return { imageUrl: item.url, text: item.revised_prompt || '' };
  return { error: 'Unrecognized response shape from Grok', detail: data };
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

    const provider = pickProvider(env);
    if (!provider) {
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

    let result;
    try {
      result = provider === 'gemini'
        ? await generateWithGemini(env, prompt, referenceImage)
        : await generateWithGrok(env, prompt, referenceImage);
    } catch (fetchErr) {
      return new Response(JSON.stringify({ error: `Could not reach ${provider} API`, detail: String(fetchErr) }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (topLevelErr) {
    return new Response(JSON.stringify({ error: 'Unexpected server error', detail: String(topLevelErr) }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
