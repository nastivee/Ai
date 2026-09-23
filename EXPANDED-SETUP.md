# Expanded: setup (in development, admins only)

Expanded is a page in the Admin panel. Only the two admin emails can open
it or call its routes. Anyone else gets "Not found". There is no switch in the
panel that opens it to the public. That needs a code change, and must wait for
age verification and legal sign-off (see the build plan doc).

## What is built

- `expanded.js` holds everything on the server: the admin-only door, rate limits,
  the words check, the picture check, the record, and the review queue.
- `supabase-expanded.sql` creates the record table and a private storage bucket.
- The Admin panel has a new **Expanded** page: a setup checklist, a prompt box,
  and the review queue.

## Three gates, all fail closed

1. **Who.** Admins only, 20 an hour, and a one hour pause after 3 blocked prompts.
2. **The words.** A fixed blocklist (minors, non-consent, incest, animals, real
   people, ages under 18), then OpenAI moderation. If moderation cannot be
   reached, the request is refused.
3. **The picture.** Every picture goes to an age and content checker before
   anyone sees it. With no checker connected, nothing is shown.

Every request is written to `expanded_audit`. Blocked pictures are never stored,
only a fingerprint (hash).

## Turning it on, step by step

1. Run `supabase-expanded.sql` in the Supabase SQL editor.
2. Add the server environment variables on Render:

| Variable | What it is |
| --- | --- |
| `EXPANDED_GEN_URL` | Your picture service's endpoint (the GPU server) |
| `EXPANDED_GEN_KEY` | Its secret key |
| `EXPANDED_CHECK_URL` | The age and content checker's endpoint |
| `EXPANDED_CHECK_KEY` | Its secret key |
| `EXPANDED_MINOR_THRESHOLD` | Optional, default 0.2. Lower is stricter |
| `EXPANDED_LIMIT_PER_HOUR` | Optional, default 20 |
| `EXPANDED_ENABLED` | Set to `false` to switch the whole thing off |

3. Redeploy. The checklist on the Expanded page turns green piece by piece.
4. Tap the **Expanded for admins** switch at the top of the page to turn it
   on. It starts off, and turning it off again stops all picture making at once.
   It only ever opens the studio to the two admins.

## What the two services must accept

**Picture service** (`EXPANDED_GEN_URL`), POST with `Authorization: Bearer <key>`:

```json
{ "prompt": "...", "negative_prompt": "...", "width": 1024, "height": 1024 }
```

It must answer `{ "image": "<base64 png>" }`. The server adds an adults-only
instruction to every prompt and a fixed avoid list, whatever was typed.

**Picture checker** (`EXPANDED_CHECK_URL`), POST with `Authorization: Bearer <key>`:

```json
{ "image": "<base64 png>" }
```

It must answer `{ "minor_risk": 0.0 to 1.0, "labels": ["..."] }`. At or above
the threshold, or any label mentioning minors, violence, gore or a real person,
the picture is destroyed and the entry goes to the review queue.

## Still to do before anyone but admins sees it

- Solicitor sign-off and Ofcom position
- Age verification provider wired into sign-up for this section
- Hash matching against known illegal material
- High-risk payment processor
- Written risk assessment, terms and privacy notice
