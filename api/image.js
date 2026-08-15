// Generates an image using Gemini's image-generation model (free tier).
export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Server is missing GEMINI_API_KEY.' }), {
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
    const referenceImage = body.referenceImage; // { base64, mediaType } — optional

    if (!prompt && !referenceImage) {
      return new Response(JSON.stringify({ error: 'A prompt describing the image is required' }), { status: 400 });
    }

    const model = 'gemini-2.5-flash-image';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const parts = [];
    if (referenceImage && referenceImage.base64) {
      parts.push({
        inlineData: {
          mimeType: referenceImage.mediaType || 'image/jpeg',
          data: referenceImage.base64
        }
      });
    }
    parts.push({ text: prompt || 'Create a new image inspired by the attached photo.' });

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
        })
      });
    } catch (fetchErr) {
      return new Response(JSON.stringify({ error: 'Could not reach Gemini API', detail: String(fetchErr) }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      return new Response(JSON.stringify({ error: 'Image generation failed', detail: data }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    const responseParts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = responseParts.find(p => p.inlineData || p.inline_data);
    const textPart = responseParts.find(p => p.text);
    const inline = imagePart ? (imagePart.inlineData || imagePart.inline_data) : null;

    if (!inline || !inline.data) {
      return new Response(JSON.stringify({ error: 'No image was returned by the model', detail: data }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    const mime = inline.mimeType || inline.mime_type || 'image/png';
    return new Response(JSON.stringify({
      image: `data:${mime};base64,${inline.data}`,
      text: textPart ? textPart.text : ''
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (topLevelErr) {
    return new Response(JSON.stringify({ error: 'Unexpected server error', detail: String(topLevelErr) }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
