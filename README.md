# ghost-terminal

An anonymous CRT terminal that talks back. Gemini behind it, a local fallback
engine underneath that, and a dossier it quietly builds about whoever is typing.

One Cloudflare Worker serves both the page and the API, so there is no CORS
setup and no URL to paste anywhere.

```
public/index.html   the entire site — one file, no build step
src/worker.js       serves the page, proxies Gemini, holds your key
wrangler.jsonc      Cloudflare config
package.json        pins wrangler for the build
```

---

## Deploy from the Cloudflare dashboard

**1. Get a Gemini API key** at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

**2. Push this repo to GitHub.** From the project folder:

```bash
git init -b main
git add .
git commit -m "ghost terminal"
gh repo create ghost-terminal --private --source=. --push
```

No `gh` CLI? Create an empty repo at [github.com/new](https://github.com/new)
(no README, no .gitignore), then:

```bash
git remote add origin https://github.com/YOUR-USERNAME/ghost-terminal.git
git push -u origin main
```

**3. In the Cloudflare dashboard:** Workers & Pages → Create → Workers →
Import a repository. Pick `ghost-terminal`. Then:

| Setting | Value |
|---|---|
| Git branch | `main` |
| Build command | *leave empty* |
| Deploy command | `npx wrangler deploy` |
| Non-production branch deploy command | `npx wrangler versions upload` |
| Root directory | `/` |
| Build variables | *none* |

There is no build step — no bundler, no framework, nothing to compile. Leaving
the build command empty is correct, not an oversight.

**4. Add the key.** Your Worker → Settings → Variables and Secrets → Add:

| Type | Name | Value |
|---|---|---|
| **Secret** | `GEMINI_API_KEY` | your key from step 1 |

Pick **Secret**, not Text. A Text variable is readable from the dashboard and
shows up in logs.

Cloudflare redeploys automatically. Open
`https://ghost-terminal.<your-subdomain>.workers.dev` and start typing.

> Secrets added in the dashboard survive redeploys. If you'd rather set it from
> the terminal: `npx wrangler secret put GEMINI_API_KEY`

**5. Your domain.** Worker → Settings → Domains & Routes → Add custom domain.
Same-origin checks follow the new domain automatically — nothing to update.

---

## Or deploy from your machine

```bash
npm install
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```

To run it locally first:

```bash
cp .dev.vars.example .dev.vars     # paste your key into it — it's gitignored
npx wrangler dev
```

`wrangler dev` serves the page and the `/chat` endpoint together, exactly as
production does.

---

## Configuration

There isn't any. `PROXY_URL` is `/chat`, relative, because the Worker serves the
page. Deploy and it works.

Two things you *can* change:

**The Worker name** in `wrangler.jsonc` becomes your subdomain.

**`EXTRA_ORIGINS`** in `src/worker.js` — only needed if you host `index.html`
somewhere else (GitHub Pages, Netlify) and point it at this Worker. Then set
`PROXY_URL` to the full Worker URL and add your host to that array.

---

## Tuning the personality

Everything interesting lives in one constant in `public/index.html`:

```js
const PERSONA = `...`;
```

The parts doing the real work:

- **The banned-phrase list.** Deleting this is the fastest way to make it sound
  like a chatbot again.
- **"Vary the SHAPE, not just the words."** Six response shapes, with an
  instruction never to repeat one twice running. This is what kills the
  "hey / hey / hey" problem at the root.
- **`DIRECTIVES`.** Twenty one-line instructions, one injected at random into
  roughly 45% of turns — *answer in a single word*, *disagree with them,
  specifically*, *be briefly sincere then undercut it*. Models settle into a
  groove within about four turns no matter how good the prompt is. This shoves
  it back out every time. Add your own; they're one line each.

Temperature is 1.15. Push toward 1.4 for wilder, drop to 0.9 if it starts
free-associating.

Harassment filtering is `BLOCK_ONLY_HIGH` because sarcasm trips the default
threshold. The persona carries its own limits — tease, never wound, and drop the
act entirely if someone is actually struggling. Delete the `safetySettings`
block in both files to return to Google's defaults.

Push a change to `main` and Cloudflare rebuilds on its own.

---

## What it does

**Remembers.** Every reply returns `{reply, learned}`. New facts feed into the
next system prompt, so it can call back to something you said eight messages
ago. The `DOSSIER [n]` counter flashes when it picks something up; click to see
the list.

**Persists.** The dossier survives a refresh via `localStorage`. Come back
tomorrow and it opens with *"Oh. You again."* Type `forget` to wipe it — nothing
leaves the browser except as conversation context.

**Speaks first.** Sit idle about a minute and it says something unprompted.
Local lines, no API call, capped at three per session.

**Degrades quietly.** If Gemini is down, rate-limited, or the secret isn't set,
a local engine takes over and the status bar drops to `LINK ○○○○ local`. No
error, no dead prompt.

**Matches your language.** Write in Hindi or Hinglish and it follows.

Commands that never hit the API: `ls` `help` `clear` `history` `dossier`
`forget`, plus <kbd>↑</kbd><kbd>↓</kbd> history, <kbd>Tab</kbd> completion,
<kbd>Ctrl</kbd>+<kbd>L</kbd>, <kbd>Esc</kbd>. Everything else goes to the model —
including `cat`, so it invents contents for any filename you try.

---

## What the Worker refuses

| Guard | Value |
|---|---|
| Requests per IP per minute | 12 |
| Requests per IP per day | 300 |
| Conversation turns forwarded | 40 |
| Output tokens | 1000 |
| Request body | 24 KB |
| Origins | same-origin, plus `EXTRA_ORIGINS` |

Model name, response schema, and safety settings are set server-side and can't
be overridden by a client, so the endpoint can't be repurposed as a free Gemini
proxy.

The rate limiter uses Cloudflare's edge cache rather than KV, which keeps it on
the free plan. That cache is per-datacenter, so a genuinely distributed attacker
exceeds the stated ceiling. It stops a bored visitor with a for-loop, which is
the realistic threat to a personal site. Swap `bump()` for a Durable Object if
you ever need exact counts.

---

## Cost

Gemini 3.6 Flash is $1.50 per million input tokens, $7.50 per million output.
A message runs roughly 2,000 input and 80 output tokens once persona and dossier
are counted — about **a third of a cent**. A thousand conversations lands near $3.

The free tier covers the Flash family within rate limits and will likely cover a
personal landing page entirely. One thing worth knowing, since strangers will be
typing into this: **free-tier traffic is used to improve Google's products.**
Paid-tier traffic isn't. Enable billing if that matters to you.

The persona sits at the front of the system prompt and the volatile parts
(dossier, time, directive) at the end, so implicit caching can hit the stable
prefix. Cached input costs 90% less.

Cloudflare's free plan covers 100,000 Worker requests a day.

---

## If it isn't working

Run `npx wrangler tail` to watch live logs, or use the Worker's Logs tab.

**Every reply is the local fallback.** Open the browser console and look at the
`/chat` response. `500` means `GEMINI_API_KEY` isn't set, or was added as Text
instead of Secret. `403` is an origin mismatch — only possible if you're hosting
the HTML off-Worker. `429` means you hit your own rate limit.

**404 on the page itself.** `assets.directory` must point at a folder containing
`index.html`. Check that `public/index.html` actually got committed.

**Build fails.** The build command should be empty and the deploy command
`npx wrangler deploy`. If Cloudflare guessed a framework preset, clear it.

**Replies are stiff or over-explained.** The model is drifting toward assistant
mode. Strengthen the banned-phrase list, or raise the directive injection rate
from `0.45`.

**Too slow.** That's model latency, not the page. Try `gemini-3.5-flash-lite` in
`src/worker.js` — noticeably faster, a little less sharp.

**Model not found.** Model names change. Check
[ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models)
and update `MODEL` in `src/worker.js`. Avoid `gemini-2.5-flash` — it shuts down
October 2026.
