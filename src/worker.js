/**
 * ghost-terminal
 *
 * One Worker does both jobs: it serves public/index.html as a static asset,
 * and it answers POST /chat by forwarding to Gemini with your API key attached.
 *
 * The key exists here and nowhere else. A static page cannot hold one — anyone
 * can open view-source and spend your quota.
 *
 * Because the page and the API share an origin, there is no CORS setup and no
 * URL to paste anywhere. Deploy and it works.
 */

const MODEL = 'gemini-3.6-flash';

/**
 * Extra origins allowed to call /chat.
 *
 * You almost certainly do not need to touch this. The Worker serves the page
 * itself, so requests are same-origin and allowed automatically — including
 * from any custom domain you attach later.
 *
 * Only add entries here if you host index.html somewhere else (GitHub Pages,
 * Netlify) and point it at this Worker:
 *   const EXTRA_ORIGINS = ['https://you.github.io'];
 */
const EXTRA_ORIGINS = [];

/* Ceilings. A visitor having a good conversation stays well under these. */
const LIMITS = {
  perMinute: 12,      // requests per IP per minute
  perDay: 300,        // requests per IP per day
  maxBodyChars: 24000,
  maxTurns: 40,
  maxOutputTokens: 1000
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    /* Static assets are served before this runs, so anything reaching the
       Worker is an API call. Anything that isn't /chat is a wrong turn. */
    if (url.pathname !== '/chat') {
      return new Response('Not found', { status: 404 });
    }

    const origin = request.headers.get('Origin') || '';
    const allowed = isAllowed(origin, url.origin);
    const cors = corsHeaders(origin, allowed);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405, cors);
    }
    if (!allowed) {
      return json({ error: 'origin not allowed' }, 403, cors);
    }
    if (!env.GEMINI_API_KEY) {
      return json({ error: 'GEMINI_API_KEY secret is not set' }, 500, cors);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    const minute = await bump(`m:${ip}:${Math.floor(Date.now() / 60000)}`, 70, ctx);
    if (minute > LIMITS.perMinute) {
      return json({ error: 'slow down' }, 429, cors);
    }
    const day = await bump(`d:${ip}:${new Date().toISOString().slice(0, 10)}`, 86400, ctx);
    if (day > LIMITS.perDay) {
      return json({ error: 'daily limit' }, 429, cors);
    }

    let body;
    try {
      const text = await request.text();
      if (text.length > LIMITS.maxBodyChars) {
        return json({ error: 'payload too large' }, 413, cors);
      }
      body = JSON.parse(text);
    } catch {
      return json({ error: 'bad json' }, 400, cors);
    }

    if (!Array.isArray(body.contents) || !body.contents.length) {
      return json({ error: 'no contents' }, 400, cors);
    }
    if (body.contents.length > LIMITS.maxTurns) {
      body.contents = body.contents.slice(-LIMITS.maxTurns);
    }

    /* Rebuild the upstream request from scratch rather than trusting the
       client's. Only these fields survive. */
    const upstream = {
      contents: body.contents,
      systemInstruction: body.systemInstruction,
      generationConfig: {
        temperature: clamp(body.generationConfig?.temperature, 0, 2, 1.15),
        topP: clamp(body.generationConfig?.topP, 0, 1, 0.96),
        maxOutputTokens: Math.min(
          body.generationConfig?.maxOutputTokens || 900, LIMITS.maxOutputTokens
        ),
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            reply: { type: 'STRING' },
            learned: { type: 'ARRAY', items: { type: 'STRING' } }
          },
          required: ['reply']
        }
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' }
      ]
    };

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY
        },
        body: JSON.stringify(upstream),
        signal: AbortSignal.timeout(18000)
      });
    } catch {
      return json({ error: 'upstream unreachable' }, 502, cors);
    }

    const data = await res.text();
    return new Response(data, {
      status: res.status,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
};

/* ── helpers ─────────────────────────────────────────────────── */

/**
 * Same origin as the Worker is always fine. Anything in EXTRA_ORIGINS is fine.
 * A missing Origin header is allowed too — some browsers and privacy extensions
 * strip it, and any attacker can forge it anyway, so rejecting on absence costs
 * real users without buying security. The rate limiter below is the actual
 * protection; this check just keeps other websites from embedding your endpoint.
 */
function isAllowed(origin, selfOrigin) {
  if (!origin) return true;
  if (origin === selfOrigin) return true;
  return EXTRA_ORIGINS.includes(origin);
}

function corsHeaders(origin, allowed) {
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (allowed && origin) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' }
  });
}

function clamp(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

/**
 * Counter built on the edge cache. No KV binding needed, so this runs on the
 * free plan. The cache is per-datacenter, so a distributed attacker gets more
 * than the stated limit — good enough to stop a bored visitor with a for-loop,
 * which is the actual threat to a personal site. Move to Durable Objects if
 * you ever need exact numbers.
 */
async function bump(key, ttlSeconds, ctx) {
  const cache = caches.default;
  const req = new Request(`https://ratelimit.internal/${encodeURIComponent(key)}`);
  let count = 0;
  try {
    const hit = await cache.match(req);
    if (hit) count = parseInt(await hit.text(), 10) || 0;
  } catch { /* treat a cache miss as zero */ }

  count++;
  const res = new Response(String(count), {
    headers: { 'Cache-Control': `max-age=${ttlSeconds}` }
  });
  ctx.waitUntil(cache.put(req, res));
  return count;
}
