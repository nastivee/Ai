// =====================================================
// EXPANDED (IN DEVELOPMENT, ADMINS ONLY)
//
// Everything for the Expanded section lives here, so it
// can be switched off, or removed, in one place.
//
// While it is being built:
//   - only the two admin emails can reach any of it. There is
//     no setting that opens it to anyone else. Opening it to
//     the public means changing this file, after age
//     verification and legal sign-off are in place.
//   - an admin switch on the Expanded page turns making
//     pictures on and off for the admins. It starts off.
//   - EXPANDED_ENABLED=false on the server turns it off entirely,
//     switch and all.
//
// Every request passes three gates in order:
//   1. who: an admin, not rate limited, not cooling down
//   2. the words: house blocklist, then OpenAI moderation
//   3. the picture: an age and content classifier
// A gate that cannot run counts as a fail. Nothing is shown
// unless all three pass.
// =====================================================

import { createHash, randomUUID } from 'crypto';

const EXPANDED_ENABLED = process.env.EXPANDED_ENABLED !== 'false';

/* the picture service: a self-hosted open model behind a small API */
const GEN_URL = (process.env.EXPANDED_GEN_URL || '').trim();
const GEN_KEY = (process.env.EXPANDED_GEN_KEY || '').replace(/\s+/g, '');

/* the picture checker: returns how likely the picture shows a minor */
const CHECK_URL = (process.env.EXPANDED_CHECK_URL || '').trim();
const CHECK_KEY = (process.env.EXPANDED_CHECK_KEY || '').replace(/\s+/g, '');

/* at or above this, the picture is destroyed. Lower is stricter. */
const MINOR_THRESHOLD = clampNumber(process.env.EXPANDED_MINOR_THRESHOLD, 0.2, 0.01, 0.9);

const LIMIT_PER_HOUR = clampNumber(process.env.EXPANDED_LIMIT_PER_HOUR, 20, 1, 500);

/* this many blocked prompts in an hour starts a cooldown */
const BLOCKS_BEFORE_COOLDOWN = 3;
const COOLDOWN_MS = 60 * 60 * 1000;

const BUCKET = 'expanded-private';

const SHAPES = {
  square: [1024, 1024],
  portrait: [832, 1216],
  landscape: [1216, 832]
};

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}


// =====================================================
// GATE 2: THE WORDS
//
// Hard blocks. Admins cannot switch these off or edit them
// from the panel. Text is flattened first (case, accents,
// look-alike numbers and symbols, spacing tricks) so the
// obvious disguises land on the same words.
// =====================================================

const LOOKALIKES = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i' };

export function flatten(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[0134578@$!|]/g, ch => LOOKALIKES[ch] || ch)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* case, accents and punctuation only, so written ages survive */
function plain(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* the same text with every space removed, to catch s c h o o l */
function squashed(flat) {
  return flat.replace(/\s+/g, '');
}

const BLOCKS = [
  {
    reason: 'Suggests a child or someone under 18',
    words: [
      'child', 'children', 'childlike', 'childish', 'kid', 'kids', 'kiddie', 'infant', 'baby', 'babies',
      'toddler', 'minor', 'minors', 'underage', 'under age', 'under aged', 'teen', 'teens', 'teenage',
      'teenager', 'teenie', 'preteen', 'pre teen', 'tween', 'adolescent', 'pubescent', 'prepubescent',
      'juvenile', 'youngster', 'loli', 'lolita', 'shota', 'shotacon', 'jailbait', 'barely legal',
      'schoolgirl', 'schoolboy', 'school girl', 'school boy', 'school uniform', 'pupil', 'student uniform',
      'high school', 'highschool', 'middle school', 'primary school', 'secondary school', 'sixth form',
      'little girl', 'little boy', 'young girl', 'young boy', 'girl child', 'boy child', 'daughter', 'son',
      'stepdaughter', 'step daughter', 'niece', 'nephew', 'babysitter', 'daycare', 'nursery',
      'kindergarten', 'playground', 'pigtails and braces', 'braces', 'training bra', 'first bra',
      'flat chested girl', 'doll like', 'dolllike', 'cub', 'chibi'
    ],
    squash: ['schoolgirl', 'schoolboy', 'underage', 'preteen', 'jailbait', 'lolita', 'loli', 'shota', 'teenage', 'barelylegal']
  },
  {
    reason: 'Sexual content with non-consent, violence or incapacity',
    words: [
      'rape', 'raped', 'raping', 'rapist', 'non consensual', 'nonconsensual', 'non con', 'noncon',
      'without consent', 'against her will', 'against his will', 'forced', 'forcing', 'coerced',
      'drugged', 'roofied', 'unconscious', 'passed out', 'asleep', 'sleeping', 'drunk', 'intoxicated',
      'abducted', 'kidnapped', 'captive', 'hostage', 'trafficked', 'snuff', 'strangled', 'choking',
      'blood', 'gore', 'mutilated', 'dead body', 'corpse', 'necro', 'necrophilia'
    ],
    squash: ['nonconsensual', 'necrophilia']
  },
  {
    reason: 'Incest, animals or other illegal themes',
    words: [
      'incest', 'bestiality', 'zoophilia', 'animal', 'dog', 'horse', 'beast', 'stepsister', 'step sister',
      'stepbrother', 'step brother', 'stepmom', 'step mom', 'stepdad', 'step dad', 'sister', 'brother',
      'mother', 'father', 'mum', 'mom', 'dad', 'cousin', 'family member'
    ],
    squash: ['bestiality', 'zoophilia', 'incest']
  },
  {
    reason: 'A real, named or recognisable person',
    words: [
      'celebrity', 'celeb', 'famous', 'actress', 'actor', 'singer', 'popstar', 'pop star', 'influencer',
      'youtuber', 'tiktoker', 'streamer', 'politician', 'princess', 'prince', 'royal', 'real person',
      'lookalike', 'look alike', 'deepfake', 'deep fake', 'my ex', 'my wife', 'my girlfriend',
      'my boyfriend', 'my husband', 'my neighbour', 'my neighbor', 'my coworker', 'my colleague',
      'my boss', 'my teacher', 'likeness', 'resembling', 'who looks like'
    ],
    squash: ['deepfake']
  }
];

/* ages written out: anything under 18 */
const UNDER_18_AGE =
  /\b(?:[1-9]|1[0-7])\s*(?:yo|y o|yr|yrs|year|years|years old|year old)\b|\b(?:aged?|age of)\s*(?:[1-9]|1[0-7])\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)\s*(?:yo|year|years)\b/;

/* @handles and web addresses point at real people */
const HANDLE = /(^|\s)@[a-z0-9_.]{2,}/i;
const WEB = /\bhttps?:\/\/|\bwww\.|\.(?:com|co\.uk|net|org|tv)\b/i;

function compileBlocks() {
  return BLOCKS.map(group => ({
    reason: group.reason,
    pattern: new RegExp(
      `(?:^|\\s)(?:${group.words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=\\s|$)`
    ),
    squash: group.squash || []
  }));
}

const COMPILED = compileBlocks();

/* returns null when the words pass, or a reason when they do not */
export function wordCheck(text) {

  const raw = String(text || '');
  const flat = flatten(raw);

  if (!flat) return 'Nothing to make';
  if (flat.length > 1500) return 'Too long';

  if (HANDLE.test(raw)) return 'A real, named or recognisable person';
  if (WEB.test(raw)) return 'A real, named or recognisable person';
  if (UNDER_18_AGE.test(plain(raw))) return 'Suggests a child or someone under 18';

  const tight = squashed(flat);

  for (const group of COMPILED) {
    if (group.pattern.test(flat)) return group.reason;
    if (group.squash.some(word => tight.includes(word))) return group.reason;
  }

  return null;

}

/*
  OpenAI's moderation model catches reworded attempts the
  word list misses. It is free. If it cannot be reached the
  request is refused, not waved through.
*/
async function moderationCheck(openai, text) {

  if (!openai) return 'The words check is not available';

  try {

    const result = await openai.moderations.create({
      model: 'omni-moderation-latest',
      input: text
    });

    const scores = result?.results?.[0]?.category_scores || {};
    const flags = result?.results?.[0]?.categories || {};

    if (flags['sexual/minors'] || (scores['sexual/minors'] || 0) > 0.05) {
      return 'Suggests a child or someone under 18';
    }

    if (flags['violence/graphic'] || flags['self-harm'] || flags['self-harm/intent'] || flags['self-harm/instructions']) {
      return 'Violence or self-harm';
    }

    if (flags['harassment/threatening'] || flags['hate/threatening']) {
      return 'Threats or hate';
    }

    return null;

  } catch (error) {

    console.error('EXPANDED MODERATION ERROR:', error?.message);
    return 'The words check is not available';

  }

}

/*
  Added to every request on the server, whatever was typed,
  so the model is always steered to adults.
*/
const EXPANDED_FRAME =
  'Every person shown is a consenting adult aged 25 or older, with a clearly mature adult face and body. ';

const ALWAYS_AVOID =
  'child, children, minor, teen, teenager, young-looking, youthful face, childlike, baby face, petite childlike body, ' +
  'school uniform, real person, celebrity, text, watermark';


// =====================================================
// GATE 1: WHO, AND HOW OFTEN
// =====================================================

const counts = new Map();
const blocks = new Map();
const cooldowns = new Map();

function underLimit(userId) {

  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const record = counts.get(userId) || { count: 0, since: now };

  if (now - record.since > hour) {
    record.count = 0;
    record.since = now;
  }

  record.count += 1;
  counts.set(userId, record);

  return record.count <= LIMIT_PER_HOUR;

}

function coolingDown(userId) {
  const until = cooldowns.get(userId) || 0;
  return until > Date.now() ? until : 0;
}

function noteBlock(userId) {

  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const recent = (blocks.get(userId) || []).filter(at => now - at < hour);

  recent.push(now);
  blocks.set(userId, recent);

  if (recent.length >= BLOCKS_BEFORE_COOLDOWN) {
    cooldowns.set(userId, now + COOLDOWN_MS);
    blocks.set(userId, []);
    return true;
  }

  return false;

}


// =====================================================
// GATE 3: THE PICTURE
// =====================================================

async function postJson(url, key, body, timeoutMs) {

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data?.error || `The service answered ${response.status}`);
    }

    return data;

  } finally {

    clearTimeout(timer);

  }

}

/* returns null when the picture passes, or a reason when it does not */
async function pictureCheck(base64) {

  if (!CHECK_URL) return 'The picture checker is not set up';

  try {

    const data = await postJson(CHECK_URL, CHECK_KEY, { image: base64 }, 60000);
    const risk = Number(data?.minor_risk);

    if (!Number.isFinite(risk)) return 'The picture checker gave no answer';
    if (risk >= MINOR_THRESHOLD) return 'The picture may show someone under 18';

    const labels = Array.isArray(data?.labels) ? data.labels.map(String) : [];
    if (labels.some(label => /minor|child|violence|gore|real_person/i.test(label))) {
      return `The picture checker flagged: ${labels.join(', ')}`;
    }

    return null;

  } catch (error) {

    console.error('EXPANDED PICTURE CHECK ERROR:', error?.message);
    return 'The picture checker is not available';

  }

}

async function generate(prompt, shape) {

  const [width, height] = SHAPES[shape] || SHAPES.square;

  const data = await postJson(
    GEN_URL,
    GEN_KEY,
    {
      prompt: EXPANDED_FRAME + prompt,
      negative_prompt: ALWAYS_AVOID,
      width,
      height
    },
    180000
  );

  const image =
    typeof data?.image === 'string'
      ? data.image
      : Array.isArray(data?.images) && typeof data.images[0] === 'string'
        ? data.images[0]
        : '';

  const clean = image.replace(/^data:image\/\w+;base64,/, '');

  if (!clean) throw new Error('The picture service sent no picture');

  return clean;

}


// =====================================================
// THE RECORD
//
// Every request is written down: who, what they typed,
// which gate stopped it and why. Blocked pictures are not
// kept, only a fingerprint (hash) of them.
// =====================================================

async function record(db, row) {

  if (!db) return null;

  try {

    const { data, error } = await db
      .from('expanded_audit')
      .insert(row)
      .select('id')
      .single();

    if (error) throw error;
    return data?.id || null;

  } catch (error) {

    console.error('EXPANDED AUDIT ERROR:', error?.message);
    return null;

  }

}


// =====================================================
// THE ROUTES
// =====================================================

export function registerExpanded(app, { supabaseAdmin, openai, getUser, isAdmin, raiseAlert, getSettings, saveSettings }) {

  const db = supabaseAdmin;

  /* the admin switch: off unless an admin has turned it on */
  async function studioOn() {
    try {
      return (await getSettings())?.expanded_on === true;
    } catch {
      return false;
    }
  }

  /* the one door every route goes through */
  async function adminOnly(req, res) {

    if (!EXPANDED_ENABLED) {
      res.status(404).json({ error: 'Not found.' });
      return null;
    }

    const user = await getUser(req);

    if (!isAdmin(user)) {
      res.status(404).json({ error: 'Not found.' });
      return null;
    }

    return user;

  }

  app.get('/api/expanded/status', async (req, res) => {

    const user = await adminOnly(req, res);
    if (!user) return;

    res.json({
      enabled: true,
      on: await studioOn(),
      audience: 'admins',
      pieces: {
        record: Boolean(db),
        words: Boolean(openai),
        generator: Boolean(GEN_URL),
        checker: Boolean(CHECK_URL)
      },
      limitPerHour: LIMIT_PER_HOUR,
      minorThreshold: MINOR_THRESHOLD,
      coolingUntil: coolingDown(user.id) || null
    });

  });

  app.post('/api/expanded/image', async (req, res) => {

    const user = await adminOnly(req, res);
    if (!user) return;

    if (!(await studioOn())) {
      return res.status(423).json({ error: 'Expanded is switched off. Turn it on at the top of this page.' });
    }

    const typed = String(req.body?.prompt || '').slice(0, 2000);
    const shape = SHAPES[req.body?.shape] ? req.body.shape : 'square';

    const base = { user_id: user.id, email: user.email, prompt: typed };

    const until = coolingDown(user.id);
    if (until) {
      return res.status(429).json({
        error: `Paused after repeated blocked requests. Try again after ${new Date(until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })}.`
      });
    }

    if (!underLimit(user.id)) {
      return res.status(429).json({ error: `The limit is ${LIMIT_PER_HOUR} an hour. Try again later.` });
    }

    if (!db) {
      return res.status(503).json({ error: 'The record is not set up, so nothing can be made yet.' });
    }

    /* gate 2: the words */
    const wordReason = wordCheck(typed) || await moderationCheck(openai, typed);

    if (wordReason) {

      const id = await record(db, { ...base, stage: 'prompt', decision: 'blocked', reason: wordReason, status: 'open' });
      const paused = noteBlock(user.id);

      if (paused) {
        raiseAlert?.('expanded cooldown', 'high', 'Repeated blocked Expanded requests started a one hour pause.', wordReason, user);
      }

      return res.status(422).json({ error: `Blocked: ${wordReason}.`, blocked: true, id, paused });

    }

    if (!GEN_URL) {
      return res.status(503).json({ error: 'The picture service is not connected yet. See EXPANDED-SETUP.md.' });
    }

    if (!CHECK_URL) {
      return res.status(503).json({ error: 'The picture checker is not connected yet, and nothing is shown without it. See EXPANDED-SETUP.md.' });
    }

    let picture;

    try {

      picture = await generate(typed, shape);

    } catch (error) {

      await record(db, { ...base, stage: 'error', decision: 'blocked', reason: error?.message || 'Picture service failed', status: 'cleared' });
      return res.status(502).json({ error: 'The picture service did not return a picture.' });

    }

    const hash = createHash('sha256').update(picture, 'base64').digest('hex');

    /* gate 3: the picture */
    const pictureReason = await pictureCheck(picture);

    if (pictureReason) {

      picture = null;

      const id = await record(db, { ...base, stage: 'output', decision: 'blocked', reason: pictureReason, image_hash: hash, status: 'open' });

      if (/under 18|minor/i.test(pictureReason)) {
        raiseAlert?.('expanded picture blocked', 'high', 'The picture checker stopped a picture. Review it in Expanded.', pictureReason, user);
      }

      return res.status(422).json({ error: `Blocked: ${pictureReason}.`, blocked: true, id });

    }

    /* passed every gate: keep a private copy for the record */
    let path = null;

    try {

      path = `${user.id}/${randomUUID()}.png`;

      const { error } = await db.storage
        .from(BUCKET)
        .upload(path, Buffer.from(picture, 'base64'), { contentType: 'image/png', upsert: false });

      if (error) throw error;

    } catch (error) {

      console.error('EXPANDED STORAGE ERROR:', error?.message);
      path = null;

    }

    await record(db, { ...base, stage: 'generated', decision: 'allowed', image_path: path, image_hash: hash, status: 'cleared' });

    res.json({ image: `data:image/png;base64,${picture}` });

  });

  /* the admin switch. Admins only, and it only ever opens it to admins */
  app.post('/api/admin/expanded/switch', async (req, res) => {

    const user = await adminOnly(req, res);
    if (!user) return;

    if (typeof req.body?.on !== 'boolean') {
      return res.status(400).json({ error: 'Say on or off.' });
    }

    try {

      const { volatile } = await saveSettings({ expanded_on: req.body.on });

      console.log(`EXPANDED SWITCHED ${req.body.on ? 'ON' : 'OFF'} BY ${user.email}`);

      res.json({
        on: req.body.on,
        volatile: Boolean(volatile)
      });

    } catch (error) {

      res.status(500).json({ error: 'Could not save the switch.' });

    }

  });

  /* the review queue: blocked requests waiting for an admin */
  app.get('/api/admin/expanded/queue', async (req, res) => {

    const user = await adminOnly(req, res);
    if (!user) return;

    if (!db) return res.json({ items: [] });

    const { data, error } = await db
      .from('expanded_audit')
      .select('id, created_at, email, prompt, stage, decision, reason, status, reviewed_by, reviewed_at')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) return res.status(500).json({ error: 'Could not load the record. Has supabase-expanded.sql been run?' });

    res.json({ items: data || [] });

  });

  app.post('/api/admin/expanded/review', async (req, res) => {

    const user = await adminOnly(req, res);
    if (!user) return;

    const id = String(req.body?.id || '');
    const action = req.body?.action;

    if (!id || !['cleared', 'escalated'].includes(action)) {
      return res.status(400).json({ error: 'Say which entry, and clear or escalate.' });
    }

    const { error } = await db
      .from('expanded_audit')
      .update({ status: action, reviewed_by: user.email, reviewed_at: new Date().toISOString() })
      .eq('id', id);

    if (error) return res.status(500).json({ error: 'Could not save that.' });

    if (action === 'escalated') {
      raiseAlert?.('expanded escalation', 'high', 'An Expanded entry was escalated for the illegal content process.', id, user);
    }

    res.json({ ok: true });

  });

}
