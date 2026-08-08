// This runs on Vercel's servers, NOT in the user's browser.
// Uses Google Gemini's free tier (Flash model) for AI replies, and logs every
// question + answer to a Supabase table so the site owner can view them.
export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'Server is missing GEMINI_API_KEY. Add it in Vercel > Settings > Environment Variables.' }),
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

    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const model = 'gemini-3.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;

    let geminiRes;
    try {
      geminiRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: systemText }] }
        })
      });
    } catch (fetchErr) {
      return new Response(JSON.stringify({ error: 'Could not reach Gemini API', detail: String(fetchErr) }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!geminiRes.ok || !geminiRes.body) {
      const errText = await geminiRes.text().catch(() => '');
      return new Response(JSON.stringify({ error: 'Gemini request failed', status: geminiRes.status, detail: errText }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const reader = geminiRes.body.getReader();
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
              if (!jsonStr) continue;
              try {
                const evt = JSON.parse(jsonStr);
                const text = evt?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) {
                  fullAnswer += text;
                  const normalized = { type: 'content_block_delta', delta: { text } };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(normalized)}\n\n`));
                }
              } catch (e) { /* skip malformed chunk */ }
            }
          }
        } catch (streamErr) {
          // If reading the Gemini stream fails partway through, at least close cleanly.
        }
        controller.close();

        // Log this Q&A to Supabase so the site owner can view it later.
        if (supabaseUrl && supabaseKey && lastUserMessage) {
          try {
            await fetch(`${supabaseUrl}/rest/v1/messages`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Prefer': 'return=minimal'
              },
              body: JSON.stringify({
                user_question: lastUserMessage.content,
                ai_answer: fullAnswer
              })
            });
          } catch (e) { /* logging failure should never break the chat */ }
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
