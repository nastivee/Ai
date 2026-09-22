import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import sharp from 'sharp';
import { toFile } from 'openai/uploads';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { createHash } from 'crypto';

const app = express();

/*
  Render sits in front of this, so the real scheme and the
  real client address arrive in headers. Without this the
  webhook URL comes out as http, which Stripe will not take,
  and every caller looks like the same IP to the rate limit.
*/
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/*
  Only the app itself may call this from a browser. Stripe
  calls the webhook server to server, which CORS does not
  touch, so it is unaffected.
*/
const ALLOWED_ORIGINS =
  (process.env.ALLOWED_ORIGINS ||
   'https://nastivee.github.io,http://localhost:5500,http://127.0.0.1:5500')
    .split(',')
    .map(one => one.trim())
    .filter(Boolean);

app.use(
  cors({
    origin(origin, done) {

      /* no Origin header: curl, health checks, Stripe */
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        return done(null, true);
      }

      return done(null, false);

    }
  })
);


// =====================================================
// WHO IS CALLING
//
// Image routes cost real money, so they are for signed in
// users only. The browser sends its Supabase access token
// and we ask Supabase who it belongs to.
// =====================================================

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  'https://fzwqunpnohgwgwikumkt.supabase.co';

const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'sb_publishable_kNUxEr43Kp5qVC4Evxgz0A_iCTLw7GB';

const supabase =
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY);


// =====================================================
// THE PAYWALL
//
// Images cost real money to make, so each one spends a
// credit. Credits come from Stripe, or from a coupon.
//
// Balances live in Supabase and are only ever written by
// this server, using the service role key. The browser
// can read its own balance and nothing more.
// =====================================================

/*
  Keys copied out of a dashboard pick up stray whitespace,
  and a masked field can even put a space in the middle of
  one. No key of ours contains whitespace, so take it all
  out rather than failing on an invisible character.
*/
function cleanKey(value) {
  return String(value || '').replace(/\s+/g, '');
}

const SUPABASE_SERVICE_KEY =
  cleanKey(process.env.SUPABASE_SERVICE_ROLE_KEY);

const supabaseAdmin =
  SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      })
    : null;

/* What a pack costs, and what it buys */
const PACK_PRICE_PENCE =
  Number(process.env.PACK_PRICE_PENCE || 500);

const PACK_IMAGES =
  Number(process.env.PACK_IMAGES || 100);

/* The code that opens the gate for good */
const COUPON_CODE =
  (process.env.COUPON_CODE || 'Nasti100').trim();

/* Where Stripe sends people back to */
const LIVE_SITE_URL =
  process.env.LIVE_SITE_URL ||
  'https://nastivee.github.io/Ai/';

const STRIPE_SECRET_KEY =
  cleanKey(process.env.STRIPE_SECRET_KEY);

const STRIPE_WEBHOOK_SECRET =
  cleanKey(process.env.STRIPE_WEBHOOK_SECRET);

const stripe =
  STRIPE_SECRET_KEY
    ? new Stripe(STRIPE_SECRET_KEY)
    : null;


function paywallReady() {
  return Boolean(stripe && supabaseAdmin);
}


// =====================================================
// SETTINGS
//
// The env vars are the starting point. Once the settings
// row exists, the admin panel owns these numbers and the
// env vars are only the fallback.
// =====================================================

const ADMIN_EMAILS =
  (process.env.ADMIN_EMAILS ||
   'aaron@mediamafia.co.uk,jamiebutcher1998@hotmail.com')
    .split(',')
    .map(one => one.trim().toLowerCase())
    .filter(Boolean);

/*
  While the site is being prepared, everything that costs
  money or touches the model is for admins only.
*/
async function holdingBlocks(user) {

  const settings =
    await getSettings();

  if (settings.holding_mode === false) {
    return false;
  }

  return !isAdmin(user);

}


function isAdmin(user) {

  return Boolean(
    user?.email &&
    ADMIN_EMAILS.includes(user.email.toLowerCase())
  );

}


const SETTINGS_FALLBACK = {
  holding_mode: process.env.HOLDING_MODE !== 'false',
  paywall_enabled: true,
  pack_price_pence: PACK_PRICE_PENCE,
  pack_images: PACK_IMAGES,
  coupon_code: COUPON_CODE,
  starter_credits: Number(process.env.STARTER_CREDITS || 0),
  /* how often the robot peeks over the message box, 0 is never */
  peek_seconds: 30,
  /* who gets New Video and voice chat: off, admins or everyone */
  video_access: 'admins',
  voice_access: 'admins',
  /* the look of the whole site: standard, halloween or auto */
  site_theme: 'standard',
  /* word swaps applied to what users type, set in the admin panel */
  rules: [],
  /* house lessons: suggestions from feedback, live once an admin approves */
  lessons: { auto: true, items: [] }
};

function readLessons(settings) {
  const value = settings?.lessons;
  const items = Array.isArray(value?.items) ? value.items : [];
  return {
    auto: value?.auto !== false,
    items: items
      .filter(item => item && typeof item.text === 'string' && item.id)
      .slice(0, 200)
  };
}

/* the approved ones, as lines for the system prompt */
async function houseLessonLines() {
  try {
    const { items } = readLessons(await getSettings());
    return items
      .filter(item => item.status === 'approved')
      .slice(0, 30)
      .map(item => `- ${item.text}`)
      .join('\n');
  } catch {
    return '';
  }
}

function lessonId() {
  return `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/*
  RULES

  Each rule swaps listed words or phrases for set wording
  before a request is processed. Whole words only, any
  case. 'images' covers pictures and video, 'chat' covers
  chat messages, 'all' covers both. The user's own message
  is saved as they typed it; only what the models see
  changes.
*/
const RULE_TARGETS = ['images', 'chat', 'all'];

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanRules(input) {

  if (!Array.isArray(input)) return null;

  const rules = [];

  for (const raw of input.slice(0, 50)) {

    const words =
      (Array.isArray(raw?.words) ? raw.words : String(raw?.words || '').split(','))
        .map(word => String(word).trim())
        .filter(word => word.length > 0 && word.length <= 60)
        .slice(0, 30);

    const replace = String(raw?.replace ?? '').slice(0, 400);

    if (!words.length) continue;

    rules.push({
      words,
      replace,
      target: RULE_TARGETS.includes(raw?.target) ? raw.target : 'all',
      enabled: raw?.enabled !== false
    });

  }

  return rules;

}

async function applyRules(text, target) {

  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';

  let rules = [];

  try {
    rules = cleanRules((await getSettings()).rules) || [];
  } catch {
    return text;
  }

  let out = text;

  for (const rule of rules) {

    if (!rule.enabled) continue;
    if (rule.target !== 'all' && rule.target !== target) continue;

    const pattern =
      new RegExp(
        `(?<![\\p{L}\\p{N}])(?:${rule.words.map(escapeRegex).join('|')})(?![\\p{L}\\p{N}])`,
        'giu'
      );

    out = out.replace(pattern, () => rule.replace);

  }

  if (out !== text) {
    console.log(`RULES APPLIED (${target})`);
  }

  return out;

}

const ACCESS_LEVELS = ['off', 'admins', 'everyone'];

/* image credits one video costs someone who is not unlimited */
const VIDEO_CREDIT_COST = Number(process.env.VIDEO_CREDIT_COST || 10);

function featureAccess(settings, name) {
  const value = settings?.[`${name}_access`];
  return ACCESS_LEVELS.includes(value) ? value : 'admins';
}

/* can this person use it, given who it is switched on for */
function featureAllowed(settings, name, user) {
  const access = featureAccess(settings, name);
  if (access === 'everyone') return Boolean(user);
  if (access === 'admins') return isAdmin(user);
  return false;
}

const SITE_THEMES = ['standard', 'halloween', 'auto'];

function siteThemeSetting(settings) {
  const value = settings?.site_theme;
  return SITE_THEMES.includes(value) ? value : 'standard';
}

/*
  The theme people actually see. Automatic means Halloween
  from 15 October to 1 November, UK time, standard otherwise.
*/
function resolvedTheme(settings) {
  const setting = siteThemeSetting(settings);
  if (setting !== 'auto') return setting;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', month: 'numeric', day: 'numeric'
  }).formatToParts(new Date());
  const month = Number(parts.find(p => p.type === 'month').value);
  const day = Number(parts.find(p => p.type === 'day').value);
  if ((month === 10 && day >= 15) || (month === 11 && day <= 1)) {
    return 'halloween';
  }
  return 'standard';
}

function peekSeconds(settings) {
  const value = Number(settings?.peek_seconds);
  return Number.isFinite(value) && value >= 0 ? value : 30;
}

let settingsCache = null;
let settingsReadAt = 0;

/*
  Anything set here beats the database.

  It exists so that a switch always works. If the database
  will not take the write, the change still takes effect on
  this running server, and the panel says plainly that it
  will not survive a restart.
*/
let settingsOverride = {};

async function getSettings(fresh) {

  const now = Date.now();

  if (!fresh && settingsCache && now - settingsReadAt < 30000) {
    return { ...settingsCache, ...settingsOverride };
  }

  if (!supabaseAdmin) {
    return { ...SETTINGS_FALLBACK, ...settingsOverride };
  }

  const { data, error } =
    await supabaseAdmin
      .from('app_settings')
      .select('*')
      .eq('id', 1)
      .maybeSingle();

  if (error || !data) {

    if (error) {
      console.error('SETTINGS READ ERROR:', error.message);
    }

    return { ...SETTINGS_FALLBACK, ...settingsOverride };

  }

  settingsCache = data;
  settingsReadAt = now;

  return { ...data, ...settingsOverride };

}


async function saveSettings(patch) {

  const fallback = () => {

    settingsOverride = {
      ...settingsOverride,
      ...patch
    };

    return {
      settings: {
        ...SETTINGS_FALLBACK,
        ...settingsCache,
        ...settingsOverride
      },
      volatile: true
    };

  };

  if (!supabaseAdmin) {
    return fallback();
  }

  const { data, error } =
    await supabaseAdmin
      .from('app_settings')
      .update({
        ...patch,
        updated_at: new Date().toISOString()
      })
      .eq('id', 1)
      .select()
      .maybeSingle();

  if (error || !data) {

    console.error(
      'SETTINGS SAVE FELL BACK TO MEMORY:',
      error?.message || 'no row came back'
    );

    return fallback();

  }

  settingsCache = data;
  settingsReadAt = Date.now();

  /* a saved setting is no longer an override */
  Object.keys(patch).forEach(key => {
    delete settingsOverride[key];
  });

  return {
    settings: { ...data },
    volatile: false
  };

}


// =====================================================
// ALERTS
//
// When something goes wrong that costs a user money or
// stops them working, it is written down where the admin
// panel can see it, and optionally pushed to a Discord or
// Slack channel via ALERT_WEBHOOK_URL.
//
// The same trouble repeating inside 15 minutes is counted
// on the first alert rather than raised again, so a bad
// hour is one line reading "x 40", not forty pings.
//
// Never anything a user typed. Chats are encrypted and
// alerts stay that way: an error message, a kind, and at
// most an account id to help put things right.
// =====================================================

const ALERT_WEBHOOK_URL =
  (process.env.ALERT_WEBHOOK_URL || '').trim();

const ALERT_WINDOW_MS = 15 * 60 * 1000;

const recentAlerts = new Map();


function alertText(value) {

  return String(value ?? '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[hidden]')
    .replace(/sk_(live|test)_[A-Za-z0-9]+/g, 'sk_[hidden]')
    .replace(/whsec_[A-Za-z0-9]+/g, 'whsec_[hidden]')
    .replace(/sb_secret_[A-Za-z0-9_-]+/g, 'sb_secret_[hidden]')
    .slice(0, 500);

}


async function pushAlert(severity, kind, message) {

  if (!ALERT_WEBHOOK_URL) return;

  const text =
    `[${severity === 'high' ? 'URGENT' : 'Problem'}] Natter AI, ${kind}: ${message}`;

  const controller = new AbortController();

  const timer = setTimeout(() => controller.abort(), 5000);

  try {

    await fetch(ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      /* content for Discord, text for Slack */
      body: JSON.stringify({ content: text, text }),
      signal: controller.signal
    });

  } catch (error) {

    console.error('ALERT PUSH FAILED:', error.message);

  } finally {

    clearTimeout(timer);

  }

}


/*
  Raising an alert must never be the thing that breaks a
  request, so every failure in here is swallowed.
*/
async function raiseAlert(kind, severity, message, detail) {

  try {

    console.error(`ALERT [${severity}] ${kind}: ${message}`);

    const now = Date.now();

    const recent = recentAlerts.get(kind);

    if (recent && now - recent.at < ALERT_WINDOW_MS) {

      recent.at = now;
      recent.count += 1;

      if (supabaseAdmin && recent.id) {

        await supabaseAdmin
          .from('app_alerts')
          .update({
            count: recent.count,
            last_at: new Date().toISOString(),
            detail: alertText(detail)
          })
          .eq('id', recent.id);

      }

      return;

    }

    let id = null;

    if (supabaseAdmin) {

      const { data } =
        await supabaseAdmin
          .from('app_alerts')
          .insert({
            kind,
            severity,
            message: alertText(message),
            detail: alertText(detail)
          })
          .select('id')
          .maybeSingle();

      id = data?.id ?? null;

    }

    recentAlerts.set(kind, { id, at: now, count: 1 });

    await pushAlert(severity, kind, alertText(message));

  } catch (error) {

    console.error('ALERT FAILED:', error?.message);

  }

}


async function openAlertCount() {

  if (!supabaseAdmin) return 0;

  try {

    const { count } =
      await supabaseAdmin
        .from('app_alerts')
        .select('id', { count: 'exact', head: true })
        .is('resolved_at', null);

    return count || 0;

  } catch {

    return 0;

  }

}


/*
  Only the admin gets past here.
*/
async function requireAdmin(req, res) {

  const user = await getUser(req);

  if (!isAdmin(user)) {

    res.status(403).json({
      error: 'Not your door.'
    });

    return null;

  }

  if (!supabaseAdmin) {

    res.status(503).json({
      error:
        'SUPABASE_SERVICE_ROLE_KEY is not set on the server, ' +
        'so there is nothing to administer yet.'
    });

    return null;

  }

  return user;

}


/*
  What this account is allowed to do right now.
*/
async function readAccount(userId) {

  if (!supabaseAdmin) {

    /*
      No service key configured, so there is no balance to
      read. Let the work through rather than locking
      everybody out of a half finished setup.
    */
    return {
      credits: 0,
      unlimited: true,
      unmetered: true
    };

  }

  const settings =
    await getSettings();

  const { data, error } =
    await supabaseAdmin
      .from('profiles')
      .select('image_credits, unlimited')
      .eq('id', userId)
      .maybeSingle();

  if (error) {

    console.error('ACCOUNT READ ERROR:', error.message);

    return {
      credits: 0,
      unlimited: false,
      unmetered: false,
      broken: true
    };

  }

  let credits =
    data?.image_credits || 0;

  /*
    A brand new account gets whatever the starter grant is
    set to, once, and never again.
  */
  if (!data && settings.starter_credits > 0) {

    try {

      credits =
        await addCredits(
          userId,
          settings.starter_credits,
          'starter',
          `starter:${userId}`
        );

    } catch {

      credits = 0;

    }

  }

  return {
    credits,
    unlimited: data?.unlimited === true,
    unmetered: settings.paywall_enabled === false
  };

}


/*
  Takes one credit. Returns the balance left, or -1 when
  there was none to take.
*/
async function spendCredit(userId) {

  if (!supabaseAdmin) {
    return 999999;
  }

  const { data, error } =
    await supabaseAdmin.rpc('spend_credit', {
      p_user: userId
    });

  if (error) {
    console.error('SPEND ERROR:', error.message);
    return -1;
  }

  return Number(data);

}


/*
  Puts credit on. The reference makes it idempotent, so a
  webhook Stripe sends twice only pays once.
*/
async function addCredits(userId, amount, reason, reference) {

  if (!supabaseAdmin) {
    return 0;
  }

  const { data, error } =
    await supabaseAdmin.rpc('add_credits', {
      p_user: userId,
      p_amount: amount,
      p_reason: reason,
      p_reference: reference || null
    });

  if (error) {
    console.error('CREDIT ERROR:', error.message);
    throw new Error(error.message);
  }

  return Number(data);

}


async function getUser(req) {

  const header =
    req.headers.authorization || '';

  const token =
    header.startsWith('Bearer ')
      ? header.slice(7)
      : '';

  if (!token) {
    return null;
  }

  try {

    const { data, error } =
      await supabase.auth.getUser(token);

    if (error) {
      return null;
    }

    return data?.user || null;

  } catch {

    return null;

  }

}


// =====================================================
// HOW OFTEN
//
// A per user count held in memory. Render runs a single
// instance, so this is enough to stop a runaway script.
// =====================================================

const IMAGE_LIMIT_PER_HOUR =
  Number(process.env.IMAGE_LIMIT_PER_HOUR || 30);

const CHAT_LIMIT_PER_HOUR =
  Number(process.env.CHAT_LIMIT_PER_HOUR || 200);

const usage = new Map();

function withinLimit(key, limit) {

  const now = Date.now();
  const hour = 60 * 60 * 1000;

  const record =
    usage.get(key) || { count: 0, since: now };

  if (now - record.since > hour) {
    record.count = 0;
    record.since = now;
  }

  record.count++;

  usage.set(key, record);

  return record.count <= limit;

}

const sweep = setInterval(() => {

  const cutoff = Date.now() - 2 * 60 * 60 * 1000;

  for (const [key, record] of usage) {
    if (record.since < cutoff) {
      usage.delete(key);
    }
  }

}, 30 * 60 * 1000);

sweep.unref();


/*
  gpt-image sizes, by the shape the user picked.
*/
function sizeFor(shape) {

  if (shape === 'portrait') return '1024x1536';

  if (shape === 'landscape') return '1536x1024';

  return '1024x1024';

}


/*
  Guards an image route: signed in, inside the hourly
  allowance, and with a credit to spend.

  The credit is taken before the picture is made. If the
  work then fails, it is handed straight back, so nobody
  pays for an error.
*/
async function requireUser(req, res) {

  const user = await getUser(req);

  if (!user) {

    res.status(401).json({
      error: 'Please create an account to generate images.'
    });

    return null;

  }

  if (!withinLimit(`img:${user.id}`, IMAGE_LIMIT_PER_HOUR)) {

    res.status(429).json({
      error:
        `That is ${IMAGE_LIMIT_PER_HOUR} images this hour, which is the limit. Try again later.`
    });

    return null;

  }

  if (await holdingBlocks(user)) {

    res.status(503).json({
      error:
        'Natter is being prepared and is not open yet.'
    });

    return null;

  }

  /*
    Admins never meet their own paywall.
  */
  if (isAdmin(user)) {

    user.unlimited = true;

    return user;

  }

  /*
    Paywall switched off means off, checked before anything
    that could fail and lock people out by accident.
  */
  const settingsNow =
    await getSettings();

  if (settingsNow.paywall_enabled === false) {

    user.unlimited = true;

    return user;

  }

  const account =
    await readAccount(user.id);

  if (account.broken) {

    res.status(503).json({
      error: 'Could not check your balance. Try again in a moment.'
    });

    return null;

  }

  if (account.unlimited || account.unmetered) {

    user.unlimited = true;

    return user;

  }

  const left =
    await spendCredit(user.id);

  if (left < 0) {

    const settings =
      await getSettings();

    res.status(402).json({

      error:
        'You are out of images. Top up to carry on.',

      needsCredit: true,

      packImages: settings.pack_images,
      packPricePence: settings.pack_price_pence

    });

    return null;

  }

  user.creditsLeft = left;

  return user;

}


/*
  Hands a spent credit back when the picture never arrived.
*/
async function refundCredit(user, why) {

  if (!user || user.unlimited) return;

  try {

    await addCredits(user.id, 1, `refund: ${why}`, null);

    console.log(`REFUNDED ONE CREDIT TO ${user.id} (${why})`);

  } catch (error) {

    console.error('REFUND FAILED:', error.message);

    raiseAlert(
      'refund failed',
      'high',
      `A failed image could not be refunded, account ${user.id}. ` +
      'They are one credit short.',
      error.message
    );

  }

}

// =====================================================
// STRIPE WEBHOOK
//
// This one route needs the body exactly as Stripe sent
// it, byte for byte, or the signature will not check out.
// So it is mounted before the JSON parser.
// =====================================================

/*
  What happened to the last thing Stripe sent. Kept in
  memory, so it resets when the server restarts, but it is
  what makes a failed payment diagnosable from the admin
  panel instead of from the server logs.
*/
let lastWebhook = null;

function noteWebhook(ok, message, extra = {}) {

  lastWebhook = {
    at: new Date().toISOString(),
    ok,
    message,
    ...extra
  };

}


app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {

    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      return res.status(503).send('Stripe is not configured.');
    }

    let event;

    try {

      event =
        stripe.webhooks.constructEvent(
          req.body,
          req.headers['stripe-signature'],
          STRIPE_WEBHOOK_SECRET
        );

    } catch (error) {

      console.error(
        'STRIPE SIGNATURE FAILED:',
        error.message
      );

      raiseAlert(
        'payment not credited',
        'high',
        'Stripe sent a payment the server could not verify, so no ' +
        'images were credited. Check STRIPE_WEBHOOK_SECRET on Render, ' +
        'then resend the event from Stripe.',
        error.message
      );

      noteWebhook(
        false,
        /Timestamp/.test(error.message)
          ? 'Rejected: the event was too old, a replay.'
          : !req.headers['stripe-signature']
            ? 'Rejected: it carried no Stripe signature.'
            : 'Rejected: the signature did not match. The webhook ' +
              'secret on Render is not the signing secret for this ' +
              'endpoint in Stripe.'
      );

      return res.status(400).send('Bad signature.');

    }

    try {

      if (event.type === 'checkout.session.completed') {

        const session = event.data.object;

        const userId =
          session.client_reference_id ||
          session.metadata?.user_id;

        const settings =
          await getSettings();

        const images =
          Number(
            session.metadata?.images ||
            settings.pack_images
          );

        if (session.payment_status === 'paid' && userId) {

          const balance =
            await addCredits(
              userId,
              images,
              'stripe',
              `stripe:${session.id}`
            );

          /* what was actually paid, for the dashboard */
          if (supabaseAdmin && Number.isFinite(session.amount_total)) {

            await supabaseAdmin
              .from('credit_events')
              .update({ pence: session.amount_total })
              .eq('reference', `stripe:${session.id}`);

          }

          console.log(
            `PAID: ${userId} +${images}, balance ${balance}`
          );

          noteWebhook(
            true,
            `Credited ${images} images. Balance now ${balance}.`,
            { type: event.type }
          );

        } else {

          noteWebhook(
            true,
            'Received, but the session was not paid or had no ' +
            'account attached, so nothing was credited.',
            { type: event.type }
          );

        }

      } else {

        noteWebhook(
          true,
          `Received ${event.type}, which we do not act on.`,
          { type: event.type }
        );

      }

    } catch (error) {

      console.error('WEBHOOK HANDLING ERROR:', error);

      noteWebhook(
        false,
        `Signature was fine, but crediting failed: ${error.message}. ` +
        'Stripe will retry.'
      );

      raiseAlert(
        'payment not credited',
        'high',
        'A verified payment could not be credited. Stripe will retry ' +
        'on its own, but check Supabase is reachable.',
        error.message
      );

      /* Tell Stripe to try again */
      return res.status(500).send('Not handled.');

    }

    res.json({ received: true });

  }
);


app.use(
  express.json({
    limit: '25mb'
  })
);


// =====================================================
// HEALTH CHECK
// =====================================================

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'Natter AI',
    status: 'online'
  });
});


// =====================================================
// ACCOUNT, COUPON AND CHECKOUT
// =====================================================

/*
  What the browser needs to draw the paywall.
*/
app.get('/api/account', async (req, res) => {

  const settings =
    await getSettings();

  const user = await getUser(req);

  if (!user) {

    return res.json({
      signedIn: false,
      credits: 0,
      unlimited: false,
      packImages: settings.pack_images,
      packPricePence: settings.pack_price_pence,
      canBuy: paywallReady(),
      admin: false,
      holding: settings.holding_mode !== false,
      peekSeconds: peekSeconds(settings),
      theme: resolvedTheme(settings),
      siteTheme: siteThemeSetting(settings),
      videoAccess: featureAccess(settings, 'video'),
      voiceAccess: featureAccess(settings, 'voice'),
      canVideo: false,
      canVoice: false
    });

  }

  const account =
    await readAccount(user.id);

  const admin = isAdmin(user);

  /*
    Why images are free for this person, if they are. The
    app must never credit a coupon that was not used.
  */
  const unlimitedReason =
    admin
      ? 'admin'
      : account.unlimited
        ? 'coupon'
        : account.unmetered
          ? 'paywall_off'
          : null;

  res.json({
    signedIn: true,
    credits: account.credits,
    unlimited: unlimitedReason !== null,
    unlimitedReason,
    packImages: settings.pack_images,
    packPricePence: settings.pack_price_pence,
    canBuy: paywallReady(),
    admin,
    alerts: admin ? await openAlertCount() : 0,
    holding: settings.holding_mode !== false,
    peekSeconds: peekSeconds(settings),
    theme: resolvedTheme(settings),
    siteTheme: siteThemeSetting(settings),
    videoAccess: featureAccess(settings, 'video'),
    voiceAccess: featureAccess(settings, 'voice'),
    canVideo: featureAllowed(settings, 'video', user),
    canVoice: featureAllowed(settings, 'voice', user),
    videoCost: unlimitedReason ? 0 : VIDEO_CREDIT_COST
  });

});


/*
  Running totals for My profile, worked out from the ledger.

  There is one balance, so which image "was" free and which
  paid is a convention, and the kind one is used here: free
  images are spent first, so what someone paid for is what
  lasts. The split is then pinned to the real balance, so
  the two figures always add up to what they can actually
  spend.
*/
app.get('/api/account/usage', async (req, res) => {

  const user = await getUser(req);

  if (!user) {

    return res.status(401).json({
      error: 'Please sign in first.'
    });

  }

  if (!supabaseAdmin) {

    return res.status(503).json({
      error: 'Totals are not available right now.'
    });

  }

  try {

    const { data: events, error } =
      await supabaseAdmin
        .from('credit_events')
        .select('amount, reason')
        .eq('user_id', user.id);

    if (error) throw new Error(error.message);

    let freeIn = 0;
    let paidIn = 0;
    let made = 0;
    let refunded = 0;
    let packs = 0;

    for (const event of events || []) {

      const reason = String(event.reason || '');
      const amount = Number(event.amount) || 0;

      if (reason === 'stripe') {
        paidIn += amount;
        packs += 1;
      } else if (reason === 'image') {
        made += 1;
      } else if (reason.startsWith('refund')) {
        refunded += amount;
      } else {
        /* starter grants and admin adjustments, either way */
        freeIn += amount;
      }

    }

    const used =
      Math.max(0, made - refunded);

    const paidUsed =
      Math.max(0, used - Math.max(0, freeIn));

    const account =
      await readAccount(user.id);

    const balance =
      Math.max(0, account.credits || 0);

    const paidLeft =
      Math.min(balance, Math.max(0, paidIn - paidUsed));

    const freeLeft =
      balance - paidLeft;

    const admin = isAdmin(user);

    res.json({

      balance,
      freeLeft,
      paidLeft,

      imagesMade: used,
      packsBought: packs,
      paidImagesBought: paidIn,
      freeImagesGiven: Math.max(0, freeIn),

      unlimited:
        admin || account.unlimited || account.unmetered,

      unlimitedReason:
        admin
          ? 'admin'
          : account.unlimited
            ? 'coupon'
            : account.unmetered
              ? 'paywall_off'
              : null

    });

  } catch (error) {

    console.error('USAGE ERROR:', error);

    res.status(500).json({
      error: 'Could not work out your totals.'
    });

  }

});


/*
  A coupon opens the gate for that account from then on.
*/
app.post('/api/coupon', async (req, res) => {

  const user = await getUser(req);

  if (!user) {

    return res.status(401).json({
      error: 'Please sign in first.'
    });

  }

  const code =
    String(req.body?.code || '').trim();

  if (!code) {

    return res.status(400).json({
      error: 'Enter a code.'
    });

  }

  if (!withinLimit(`coupon:${user.id}`, 12)) {

    return res.status(429).json({
      error: 'Too many tries. Give it an hour.'
    });

  }

  const settings =
    await getSettings();

  if (code.toLowerCase() !==
      String(settings.coupon_code || '').toLowerCase()) {

    return res.status(400).json({
      error: 'That code is not recognised.'
    });

  }

  if (!supabaseAdmin) {

    return res.status(503).json({
      error: 'Accounts are not set up yet. Try again shortly.'
    });

  }

  const { error } =
    await supabaseAdmin
      .from('profiles')
      .upsert({
        id: user.id,
        unlimited: true,
        credits_updated_at: new Date().toISOString()
      });

  if (error) {

    console.error('COUPON ERROR:', error.message);

    return res.status(500).json({
      error: 'Could not apply that code. Try again.'
    });

  }

  console.log(`COUPON REDEEMED BY ${user.id}`);

  res.json({
    ok: true,
    unlimited: true,
    message: 'Code accepted. Images are on the house from here.'
  });

});


/*
  Deletes an account and everything in it, for good.

  Order matters: the files and rows go first and the login
  last, so if anything fails part way the user can still
  sign in and try again rather than being left with an
  orphaned half an account they cannot reach.
*/
app.post('/api/account/delete', async (req, res) => {

  const user = await getUser(req);

  if (!user) {

    return res.status(401).json({
      error: 'Please sign in first.'
    });

  }

  if (String(req.body?.confirm || '') !== 'DELETE') {

    return res.status(400).json({
      error: 'Type DELETE to confirm.'
    });

  }

  if (!supabaseAdmin) {

    return res.status(503).json({
      error: 'Deletion is not available right now. Try again shortly.'
    });

  }

  if (!withinLimit(`delete:${user.id}`, 5)) {

    return res.status(429).json({
      error: 'Too many tries. Give it an hour.'
    });

  }

  const uid = user.id;

  const removed = {
    files: 0
  };

  try {

    /* 1. every picture in their folder, a page at a time */

    for (let page = 0; page < 50; page += 1) {

      const { data: files, error: listError } =
        await supabaseAdmin
          .storage
          .from('images')
          .list(uid, { limit: 1000 });

      if (listError) throw new Error(listError.message);

      if (!files?.length) break;

      const paths =
        files.map(file => `${uid}/${file.name}`);

      const { error: removeError } =
        await supabaseAdmin
          .storage
          .from('images')
          .remove(paths);

      if (removeError) throw new Error(removeError.message);

      removed.files += paths.length;

      if (files.length < 1000) break;

    }

    /* 2. the rows, children before parents */

    /* upload records (the files themselves went with the folder above) */
    {
      const { error: uploadsError } =
        await supabaseAdmin.from('uploads').delete().eq('user_id', uid);

      if (uploadsError && !/does not exist|schema cache|not find/i.test(uploadsError.message)) {
        throw new Error(`uploads: ${uploadsError.message}`);
      }
    }

    /* saved comments, if that table has been made yet */
    {
      const { error: savedError } =
        await supabaseAdmin
          .from('saved_comments')
          .delete()
          .eq('user_id', uid);

      if (savedError && !/does not exist|schema cache|not find/i.test(savedError.message)) {
        throw new Error(`saved_comments: ${savedError.message}`);
      }
    }

    for (const [table, column] of [
      ['messages', 'user_id'],
      ['chats', 'user_id'],
      ['credit_events', 'user_id'],
      ['profiles', 'id']
    ]) {

      const { error } =
        await supabaseAdmin
          .from(table)
          .delete()
          .eq(column, uid);

      if (error) {
        throw new Error(`${table}: ${error.message}`);
      }

    }

    /* 3. the login itself, last */

    const { error: authError } =
      await supabaseAdmin.auth.admin.deleteUser(uid);

    if (authError) throw new Error(authError.message);

    console.log(
      `ACCOUNT DELETED: ${uid} (${removed.files} files)`
    );

    res.json({ ok: true });

  } catch (error) {

    console.error('ACCOUNT DELETE FAILED:', uid, error);

    raiseAlert(
      'account deletion failed',
      'high',
      `An account deletion stopped part way, account ${uid}. ` +
      'They can retry, but check it completes.',
      error?.message
    );

    res.status(500).json({
      error:
        'Part of your account could not be deleted. Nothing ' +
        'is half gone that you cannot reach, try again, and ' +
        'if it keeps failing, email privacy@nastiv.ee.'
    });

  }

});


/*
  Sends the user to Stripe to buy a pack.
*/
app.post('/api/checkout', async (req, res) => {

  const user = await getUser(req);

  if (!user) {

    return res.status(401).json({
      error: 'Please sign in first.'
    });

  }

  if (!stripe) {

    return res.status(503).json({
      error: 'Payments are not switched on yet.'
    });

  }

  try {

    const settings =
      await getSettings();

    const session =
      await stripe.checkout.sessions.create({

        mode: 'payment',

        client_reference_id: user.id,

        customer_email: user.email || undefined,

        metadata: {
          user_id: user.id,
          images: String(settings.pack_images)
        },

        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'gbp',
              unit_amount: settings.pack_price_pence,
              product_data: {
                name: `${settings.pack_images} Natter images`,
                description:
                  `${settings.pack_images} image generations on ` +
                  'your Natter AI account. They do not expire.'
              }
            }
          }
        ],

        success_url: `${LIVE_SITE_URL}?paid=1`,
        cancel_url: `${LIVE_SITE_URL}?paid=0`

      });

    res.json({ url: session.url });

  } catch (error) {

    console.error('CHECKOUT ERROR:', error);

    res.status(500).json({
      error: 'Could not start checkout. Try again.'
    });

  }

});


// =====================================================
// ADMIN
//
// Everything here is behind requireAdmin, which checks
// the signed in email against ADMIN_EMAILS. Keys are
// never sent back, only whether they are present.
// =====================================================

app.get('/api/admin/overview', async (req, res) => {

  const user = await requireAdmin(req, res);

  if (!user) return;

  const settings =
    await getSettings(true);

  let accounts = null;

  try {

    const { data } =
      await supabaseAdmin.auth.admin.listUsers({
        page: 1,
        perPage: 1
      });

    accounts = data?.total ?? null;

  } catch {

    accounts = null;

  }


  /*
    Whether a key is SET tells you nothing about whether it
    WORKS, so actually use it and report what came back.
  */
  let serviceKeyWorks = false;
  let serviceKeyError = null;

  try {

    const { error } =
      await supabaseAdmin
        .from('app_settings')
        .select('id')
        .limit(1);

    if (error) {
      serviceKeyError = error.message;
    } else {
      serviceKeyWorks = true;
    }

  } catch (error) {

    serviceKeyError = error.message;

  }


  let stripeKeyWorks = false;
  let stripeKeyError = null;

  if (stripe) {

    try {

      await stripe.balance.retrieve();

      stripeKeyWorks = true;

    } catch (error) {

      stripeKeyError =
        error?.raw?.message || error.message;

    }

  }

  res.json({

    settings,

    accounts,

    testMode:
      STRIPE_SECRET_KEY.startsWith('sk_test_') ||
      STRIPE_SECRET_KEY.startsWith('rk_test_'),

    configured: {
      serviceKey: serviceKeyWorks,
      stripeKey: stripeKeyWorks,
      webhook: Boolean(STRIPE_WEBHOOK_SECRET),
      openai: Boolean(process.env.OPENAI_API_KEY)
    },

    present: {
      serviceKey: Boolean(SUPABASE_SERVICE_KEY),
      stripeKey: Boolean(STRIPE_SECRET_KEY)
    },

    problems: {
      serviceKey: serviceKeyError,
      stripeKey: stripeKeyError
    },

    lastWebhook,

    openAlerts: await openAlertCount(),

    alertPushConfigured: Boolean(ALERT_WEBHOOK_URL),

    webhookSecretShape:
      STRIPE_WEBHOOK_SECRET
        ? `${STRIPE_WEBHOOK_SECRET.slice(0, 10)}... ` +
          `${STRIPE_WEBHOOK_SECRET.length} characters`
        : null,

    serviceKeyShape:
      SUPABASE_SERVICE_KEY
        ? `${SUPABASE_SERVICE_KEY.slice(0, 11)}... ` +
          `${SUPABASE_SERVICE_KEY.length} characters`
        : null,

    webhookUrl:
      `${req.protocol}://${req.get('host')}/api/stripe/webhook`,

    siteUrl: LIVE_SITE_URL,

    adminEmails: ADMIN_EMAILS

  });

});


app.post('/api/admin/settings', async (req, res) => {

  const user = await requireAdmin(req, res);

  if (!user) return;

  const body = req.body || {};

  const patch = {};

  if (typeof body.paywall_enabled === 'boolean') {
    patch.paywall_enabled = body.paywall_enabled;
  }

  if (typeof body.holding_mode === 'boolean') {
    patch.holding_mode = body.holding_mode;
  }

  if (body.pack_price_pence !== undefined) {

    const pence =
      Math.round(Number(body.pack_price_pence));

    if (!Number.isFinite(pence) || pence < 100 || pence > 50000) {

      return res.status(400).json({
        error: 'Price must be between 1 and 500 pounds.'
      });

    }

    patch.pack_price_pence = pence;

  }

  if (body.pack_images !== undefined) {

    const images =
      Math.round(Number(body.pack_images));

    if (!Number.isFinite(images) || images < 1 || images > 10000) {

      return res.status(400).json({
        error: 'A pack must be between 1 and 10000 images.'
      });

    }

    patch.pack_images = images;

  }

  if (body.starter_credits !== undefined) {

    const starter =
      Math.round(Number(body.starter_credits));

    if (!Number.isFinite(starter) || starter < 0 || starter > 1000) {

      return res.status(400).json({
        error: 'The starter grant must be between 0 and 1000.'
      });

    }

    patch.starter_credits = starter;

  }

  if (body.peek_seconds !== undefined) {

    const seconds =
      Math.round(Number(body.peek_seconds));

    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) {

      return res.status(400).json({
        error: 'The robot timer must be between 0 and 3600 seconds.'
      });

    }

    if (seconds > 0 && seconds < 5) {

      return res.status(400).json({
        error: 'Give him at least 5 seconds between peeks, or 0 to switch him off.'
      });

    }

    patch.peek_seconds = seconds;

  }

  if (body.rules !== undefined) {

    const rules = cleanRules(body.rules);

    if (!rules) {
      return res.status(400).json({ error: 'Rules must be a list.' });
    }

    patch.rules = rules;

  }

  for (const name of ['video', 'voice']) {

    const key = `${name}_access`;

    if (body[key] !== undefined) {

      if (!ACCESS_LEVELS.includes(body[key])) {
        return res.status(400).json({ error: 'Choose off, admins or everyone.' });
      }

      patch[key] = body[key];

    }

  }

  if (body.site_theme !== undefined) {

    if (!SITE_THEMES.includes(body.site_theme)) {
      return res.status(400).json({ error: 'Choose standard, halloween or automatic.' });
    }

    patch.site_theme = body.site_theme;

  }

  if (body.coupon_code !== undefined) {

    const code =
      String(body.coupon_code).trim();

    if (code.length < 3 || code.length > 40) {

      return res.status(400).json({
        error: 'A coupon code needs 3 to 40 characters.'
      });

    }

    patch.coupon_code = code;

  }

  if (!Object.keys(patch).length) {

    return res.status(400).json({
      error: 'Nothing to change.'
    });

  }

  try {

    const { settings, volatile } =
      await saveSettings(patch);

    console.log(
      `ADMIN SETTINGS BY ${user.email}:`,
      JSON.stringify(patch),
      volatile ? '(in memory only)' : ''
    );

    res.json({ settings, volatile });

  } catch (error) {

    res.status(500).json({
      error: error.message
    });

  }

});


/*
  Open alerts, newest first.
*/
app.get('/api/admin/alerts', async (req, res) => {

  const user = await requireAdmin(req, res);

  if (!user) return;

  const { data, error } =
    await supabaseAdmin
      .from('app_alerts')
      .select('id, kind, severity, message, detail, count, first_at, last_at')
      .is('resolved_at', null)
      .order('last_at', { ascending: false })
      .limit(50);

  if (error) {

    return res.status(500).json({
      error: error.message
    });

  }

  res.json({ alerts: data || [] });

});


app.post('/api/admin/alerts/resolve', async (req, res) => {

  const user = await requireAdmin(req, res);

  if (!user) return;

  const stamp = { resolved_at: new Date().toISOString() };

  const query =
    req.body?.all === true
      ? supabaseAdmin.from('app_alerts').update(stamp).is('resolved_at', null)
      : supabaseAdmin.from('app_alerts').update(stamp).eq('id', Number(req.body?.id));

  const { error } = await query;

  if (error) {

    return res.status(500).json({
      error: error.message
    });

  }

  /* a resolved kind can alert afresh next time */
  if (req.body?.all === true) {
    recentAlerts.clear();
  }

  res.json({ ok: true, open: await openAlertCount() });

});


/*
  The dashboard: what has happened, day by day.

  Everything is counted from rows that already exist, and
  none of it reads a word of anybody's chats. Messages are
  counted, never opened.
*/
app.get('/api/admin/stats', async (req, res) => {

  const user = await requireAdmin(req, res);

  if (!user) return;

  const days =
    Math.min(90, Math.max(7, Number(req.query.days) || 30));

  const since =
    new Date(Date.now() - (days - 1) * 86400000);

  since.setUTCHours(0, 0, 0, 0);

  const dayKey =
    value => new Date(value).toISOString().slice(0, 10);

  const series = {};

  for (let i = 0; i < days; i += 1) {

    const key =
      dayKey(since.getTime() + i * 86400000);

    series[key] = {
      day: key,
      signups: 0,
      activeUsers: 0,
      messages: 0,
      images: 0,
      packs: 0,
      pence: 0
    };

  }

  try {

    /* signups, from every account */

    let totalAccounts = 0;

    for (let page = 1; page <= 20; page += 1) {

      const { data, error } =
        await supabaseAdmin.auth.admin.listUsers({
          page,
          perPage: 1000
        });

      if (error) throw new Error(error.message);

      const users = data?.users || [];

      totalAccounts += users.length;

      users.forEach(one => {
        const key = dayKey(one.created_at);
        if (series[key]) series[key].signups += 1;
      });

      if (users.length < 1000) break;

    }

    /* messages and who was active, counted not read */

    const active = {};

    for (let from = 0; from < 200000; from += 1000) {

      const { data, error } =
        await supabaseAdmin
          .from('messages')
          .select('user_id, created_at')
          .gte('created_at', since.toISOString())
          .order('created_at', { ascending: true })
          .range(from, from + 999);

      if (error) throw new Error(error.message);

      (data || []).forEach(row => {

        const key = dayKey(row.created_at);

        if (!series[key]) return;

        series[key].messages += 1;

        (active[key] ||= new Set()).add(row.user_id);

      });

      if (!data || data.length < 1000) break;

    }

    Object.entries(active).forEach(([key, people]) => {
      series[key].activeUsers = people.size;
    });

    /* images made, and packs sold */

    const settings = await getSettings();

    for (let from = 0; from < 200000; from += 1000) {

      const { data, error } =
        await supabaseAdmin
          .from('credit_events')
          .select('reason, pence, created_at')
          .gte('created_at', since.toISOString())
          .in('reason', ['image', 'stripe'])
          .order('created_at', { ascending: true })
          .range(from, from + 999);

      if (error) throw new Error(error.message);

      (data || []).forEach(row => {

        const key = dayKey(row.created_at);

        if (!series[key]) return;

        if (row.reason === 'image') {

          series[key].images += 1;

        } else {

          series[key].packs += 1;

          /* older sales predate recording the price paid */
          series[key].pence +=
            Number(row.pence) || settings.pack_price_pence || 0;

        }

      });

      if (!data || data.length < 1000) break;

    }

    const list = Object.values(series);

    const sum =
      field => list.reduce((total, day) => total + day[field], 0);

    res.json({

      days,

      totals: {
        accounts: totalAccounts,
        signups: sum('signups'),
        messages: sum('messages'),
        images: sum('images'),
        packs: sum('packs'),
        pence: sum('pence'),
        peakActive: Math.max(0, ...list.map(day => day.activeUsers))
      },

      series: list

    });

  } catch (error) {

    console.error('STATS ERROR:', error);

    res.status(500).json({
      error: 'Could not build the numbers: ' + error.message
    });

  }

});


/*
  Look somebody up by email, with their balance.
*/
app.get('/api/admin/user', async (req, res) => {

  const user = await requireAdmin(req, res);

  if (!user) return;

  const email =
    String(req.query.email || '').trim().toLowerCase();

  if (!email) {

    return res.status(400).json({
      error: 'Which email?'
    });

  }

  try {

    const found =
      await findUserByEmail(email);

    if (!found) {

      return res.status(404).json({
        error: 'No account with that email.'
      });

    }

    const { data } =
      await supabaseAdmin
        .from('profiles')
        .select('image_credits, unlimited, credits_updated_at')
        .eq('id', found.id)
        .maybeSingle();

    const { data: events } =
      await supabaseAdmin
        .from('credit_events')
        .select('amount, reason, created_at')
        .eq('user_id', found.id)
        .order('created_at', { ascending: false })
        .limit(8);

    res.json({

      id: found.id,
      email: found.email,
      createdAt: found.created_at,

      credits: data?.image_credits || 0,
      unlimited: data?.unlimited === true,

      recent: events || []

    });

  } catch (error) {

    console.error('ADMIN LOOKUP ERROR:', error);

    res.status(500).json({
      error: 'Lookup failed.'
    });

  }

});


/*
  Hand out credits, or open the gate for somebody.
*/
app.post('/api/admin/grant', async (req, res) => {

  const user = await requireAdmin(req, res);

  if (!user) return;

  const email =
    String(req.body?.email || '').trim().toLowerCase();

  const amount =
    req.body?.amount === undefined
      ? 0
      : Math.round(Number(req.body.amount));

  const unlimited = req.body?.unlimited;

  try {

    const found =
      await findUserByEmail(email);

    if (!found) {

      return res.status(404).json({
        error: 'No account with that email.'
      });

    }

    if (typeof unlimited === 'boolean') {

      const { error } =
        await supabaseAdmin
          .from('profiles')
          .upsert({
            id: found.id,
            unlimited,
            credits_updated_at: new Date().toISOString()
          });

      if (error) throw new Error(error.message);

    }

    let balance = null;

    if (amount) {

      if (!Number.isFinite(amount) ||
          amount < -10000 ||
          amount > 10000) {

        return res.status(400).json({
          error: 'That is too big a swing.'
        });

      }

      balance =
        await addCredits(
          found.id,
          amount,
          `admin:${user.email}`,
          null
        );

    }

    console.log(
      `ADMIN GRANT BY ${user.email} TO ${email}: ` +
      `${amount} credits, unlimited ${unlimited}`
    );

    res.json({
      ok: true,
      email: found.email,
      credits: balance,
      unlimited
    });

  } catch (error) {

    console.error('ADMIN GRANT ERROR:', error);

    res.status(500).json({
      error: error.message || 'Could not apply that.'
    });

  }

});


/*
  Supabase has no lookup by email, so page through until
  it turns up. Fine at this size.
*/
async function findUserByEmail(email) {

  const wanted =
    String(email || '').trim().toLowerCase();

  if (!wanted) return null;

  for (let page = 1; page <= 20; page += 1) {

    const { data, error } =
      await supabaseAdmin.auth.admin.listUsers({
        page,
        perPage: 200
      });

    if (error) throw new Error(error.message);

    const hit =
      (data?.users || []).find(one =>
        (one.email || '').toLowerCase() === wanted
      );

    if (hit) return hit;

    if ((data?.users || []).length < 200) break;

  }

  return null;

}


// =====================================================
// CHAT
// =====================================================


/*
  The Responses API wants its own message shape. Text
  stays text; a photo on the newest message becomes an
  input image. Empty turns (image only replies) are left
  out, since the API refuses them.
*/
function toResponsesInput(messages) {

  return messages
    .map(message => {

      const role =
        message.role === 'assistant' ? 'assistant' : 'user';

      if (Array.isArray(message.content)) {

        const parts =
          message.content
            .map(part => {
              if (part.type === 'text' && part.text) {
                return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
              }
              if (part.type === 'image_url' && part.image_url?.url && role === 'user') {
                return { type: 'input_image', image_url: part.image_url.url };
              }
              return null;
            })
            .filter(Boolean);

        return parts.length ? { role, content: parts } : null;

      }

      const text = String(message.content || '').trim();

      return text ? { role, content: text } : null;

    })
    .filter(Boolean);

}


function liveWebNote() {

  const today =
    new Date().toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Europe/London'
    });

  return `

LIVE WEB:

Today is ${today}. You can search the web.
- Search before answering anything that may have changed since your training: news, prices, sport, weather, opening times, releases, laws, who holds a role, and anything the user calls current or latest.
- Do not search for things that do not change, like maths, writing help, or general knowledge.
- When you use the web, cite it with short inline markdown links, e.g. ([BBC](https://...)).
- If results disagree or are thin, say so rather than guessing.
`;

}


/*
  Streams one reply with web search on. Sends text as it
  arrives, a status while it searches, and a short source
  list at the end for anything cited but not linked inline.
  Resolves true once something was sent.
*/
async function streamWithSearch({ model, effort, instructions, messages, send }) {

  const stream =
    await openai.responses.create({
      model,
      reasoning: { effort },
      instructions,
      input: toResponsesInput(messages),
      tools: [
        {
          type: 'web_search',
          user_location: {
            type: 'approximate',
            country: 'GB',
            timezone: 'Europe/London'
          }
        }
      ],
      stream: true
    });

  let text = '';
  let searching = false;
  let finalResponse = null;

  try {

    for await (const event of stream) {

      const type = event?.type || '';

      if (type.startsWith('response.web_search_call') && !searching) {
        searching = true;
        send({ status: 'searching' });
      }

      if (type === 'response.output_text.delta' && event.delta) {
        text += event.delta;
        send({ text: event.delta });
      }

      if (type === 'response.completed') {
        finalResponse = event.response;
      }

      if (type === 'response.failed' || type === 'error') {
        throw new Error(
          event?.response?.error?.message ||
          event?.message ||
          'Reply failed'
        );
      }

    }

  } catch (error) {

    if (text) error.sentSomething = true;
    throw error;

  }

  /* sources cited but not already linked in the text */
  const cited = new Map();

  for (const item of finalResponse?.output || []) {
    for (const part of item?.content || []) {
      for (const note of part?.annotations || []) {
        if (note?.type === 'url_citation' && note.url && !text.includes(note.url)) {
          cited.set(note.url, note.title || new URL(note.url).hostname);
        }
      }
    }
  }

  if (cited.size) {

    const list =
      [...cited]
        .slice(0, 6)
        .map(([url, title]) => `- [${String(title).replace(/[\[\]]/g, '')}](${url})`)
        .join('\n');

    const tail = `\n\nSources:\n${list}`;

    text += tail;
    send({ text: tail });

  }

  if (!text) {
    send({ text: 'Sorry, I could not generate a response.' });
  }

  return true;

}


/*
  If the account cannot use the chosen model (not enabled
  yet, or a typo in a setting), fall back to the previous
  one rather than leaving everyone without replies.
*/
const FALLBACK_CHAT_MODEL = 'gpt-4o-mini';

async function createReply(payload) {

  try {

    return await openai.chat.completions.create(payload);

  } catch (error) {

    const status = error?.status;
    const text = String(error?.message || '');

    const modelProblem =
      (status === 404 || status === 400 || status === 403) &&
      /model|reasoning_effort|does not exist|not have access/i.test(text);

    if (!modelProblem || payload.model === FALLBACK_CHAT_MODEL) {
      throw error;
    }

    console.error('CHAT MODEL REFUSED, FALLING BACK:', text);

    raiseAlert(
      'chat model fallback',
      'medium',
      `${payload.model} was refused, replies are using ${FALLBACK_CHAT_MODEL}.`,
      text
    );

    const { reasoning_effort, ...rest } = payload;

    return openai.chat.completions.create({
      ...rest,
      model: FALLBACK_CHAT_MODEL
    });

  }

}

app.post('/api/chat', async (req, res) => {

  try {

    const user = await getUser(req);

    if (await holdingBlocks(user)) {

      return res.status(503).json({
        error:
          'Natter is being prepared and is not open yet.'
      });

    }

    const who =
      user
        ? `chat:${user.id}`
        : `chat:${req.ip}`;

    if (!withinLimit(who, CHAT_LIMIT_PER_HOUR)) {

      return res.status(429).json({
        error: 'Too many messages just now. Give it a minute.'
      });

    }

    const {
      messages = [],
      memory = {},

      /*
        A photo the user is asking about, as a data URL.
        Only the newest message gets it.
      */
      image = null,

      /* the browser asks for a streamed reply */
      stream = false,

      /* 'fast' or 'smart', chosen in the app */
      mode = 'fast'
    } = req.body;

    const systemPrompt = `
You are Natter AI.

You are a friendly, intelligent personal AI assistant.

PERSONALITY:

- Speak naturally and conversationally.
- Be helpful, warm and direct.
- Do not constantly flirt.
- Do not constantly make sexual or suggestive comments.
- Only become flirty, cheeky or sexual if the user clearly starts that type of conversation or directly asks for it.
- If the subject changes, return naturally to a normal helpful tone.
- Do not randomly turn ordinary conversations sexual.

MEMORY:

The user may provide saved memory.

Use saved memory naturally when relevant.

If a fact exists in the supplied memory, treat it as something the user previously told you.

Do not claim the user never told you something if it exists in memory.

CARDS:

Some answers read better as a picture than as a paragraph.
When the answer is one of these, send a card: a fenced block
marked natter holding one JSON object, with one short line of
your own words before it and nothing after it.

Use a card for: the weather, a football (or any sport) score or
fixture, a league table or ranking, a price or a market number,
and any small set of facts that belongs together (an event, a
journey, opening times, a comparison).

Do not use a card for ordinary chat, explanations, advice,
opinions, code or anything that needs a proper answer in
sentences. Never put made up numbers in a card. Only use a card
when you have the real figures, from the live web search or from
what the user told you.

The shapes, all fields optional except card:

Weather:
\`\`\`natter
{"card":"weather","place":"Thornaby","now":{"icon":"rain","temp":"11°C","text":"Light rain"},
"facts":[["Feels like","9°C"],["Wind","12 mph"],["Rain","80%"],["Sunset","4:41 pm"]],
"hours":[{"time":"3pm","icon":"rain","temp":"11°","rain":"70%"},{"time":"4pm","icon":"cloud","temp":"10°"}],
"days":[{"day":"Tue","icon":"partly","high":"13°","low":"7°"}]}
\`\`\`

Score or fixture:
\`\`\`natter
{"card":"score","competition":"Premier League","status":"FT","home":{"name":"Man Utd","score":2},
"away":{"name":"Arsenal","score":1},"notes":["Rashford 12'","Saka 48'","Fernandes 81'"],
"facts":[["Venue","Old Trafford"],["Kick off","3:00 pm"]]}
\`\`\`
For a game still to come, leave the scores out and put the time in status.

Table or ranking:
\`\`\`natter
{"card":"table","title":"Premier League","columns":["#","Team","P","GD","Pts"],
"rows":[["1","Arsenal","28","+34","65"],["2","Man City","28","+30","63"]],"highlight":"Arsenal"}
\`\`\`

A number that moved:
\`\`\`natter
{"card":"stat","title":"Bitcoin","value":"£52,310","change":"+2.4%","direction":"up",
"spark":[50100,50800,51600,52310],"rows":[["24h high","£53,010"],["24h low","£49,880"]]}
\`\`\`

Any other set of facts:
\`\`\`natter
{"card":"facts","icon":"🎬","title":"Dune: Part Two","subtitle":"Showing tonight",
"rows":[["Starts","7:30 pm"],["Where","Cineworld Stockton"],["Runtime","2h 46m"]]}
\`\`\`

Weather icons, use one of these words only: sun, moon, cloud,
partly, rain, showers, storm, snow, fog, wind.

Every card may carry "chips": up to four short follow up
questions, for example "chips":["Tomorrow","Next 5 days"].
Tapping one asks you that question, so write them as things the
user would ask.

USER MEMORY:

${typeof memory === 'string' ? (memory.trim() || '(nothing saved yet)') : JSON.stringify(memory, null, 2)}
${await (async () => {
  const lines = await houseLessonLines();
  return lines ? `\nHOUSE LESSONS (how to answer well, learned from feedback):\n${lines}\n` : '';
})()}`;

    const cleanMessages =
      Array.isArray(messages)
        ? messages.slice(-30).map(message => ({ ...message }))
        : [];

    /* rules reach the newest thing they typed */
    for (let i = cleanMessages.length - 1; i >= 0; i -= 1) {
      if (cleanMessages[i]?.role === 'user' && typeof cleanMessages[i].content === 'string') {
        cleanMessages[i].content = await applyRules(cleanMessages[i].content, 'chat');
        break;
      }
    }


    /*
      VISION

      With a photo attached, the last message carries both
      the question and the picture, so Natter can answer
      about what is in it.
    */

    if (image && cleanMessages.length) {

      const last =
        cleanMessages[cleanMessages.length - 1];

      cleanMessages[cleanMessages.length - 1] = {
        role: last.role,
        content: [
          {
            type: 'text',
            text: last.content || 'What is in this image?'
          },
          {
            type: 'image_url',
            image_url: { url: image }
          }
        ]
      };

    }


    /*
      Fast is the everyday model. Smart costs more and is
      for harder questions, so it is chosen per chat.
    */

    /*
      Back on the day one model, GPT-5.6. Fast thinks
      briefly so replies start quickly, Smart thinks harder.
      Both can be changed on Render without a deploy.
    */
    const model =
      mode === 'smart'
        ? (process.env.SMART_MODEL || 'gpt-5.6')
        : (process.env.FAST_MODEL || 'gpt-5.6');

    const effort =
      mode === 'smart'
        ? (process.env.SMART_EFFORT || 'medium')
        : (process.env.FAST_EFFORT || 'low');


    const payload = {

      model,

      reasoning_effort: effort,

      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        ...cleanMessages
      ]

    };


    /*
      STREAMING

      Sent as server sent events so the browser can show
      the answer as it arrives.
    */

    if (stream) {

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      let sent = false;

      const send = data =>
        res.write(`data: ${JSON.stringify(data)}\n\n`);

      try {

        /*
          LIVE WEB

          Replies go through the Responses API with web
          search switched on, so anything current (news,
          prices, sport, opening times, who holds a job) is
          checked live. If that route fails before a word
          is sent, the plain reply below takes over.
        */
        if (process.env.WEB_SEARCH !== 'off') {

          try {

            sent = await streamWithSearch({
              model,
              effort,
              instructions: systemPrompt + liveWebNote(),
              messages: cleanMessages,
              send
            });

            res.write('data: [DONE]\n\n');
            res.end();
            return;

          } catch (searchError) {

            if (searchError?.sentSomething) throw searchError;

            console.error('WEB SEARCH REPLY FAILED, PLAIN REPLY:', searchError?.message);

            raiseAlert(
              'web search failing',
              'medium',
              'Live web replies failed, answering without the web.',
              searchError?.message
            );

          }

        }

        const completion =
          await createReply({
            ...payload,
            stream: true
          });

        for await (const part of completion) {

          const piece =
            part.choices?.[0]?.delta?.content || '';

          if (piece) {

            sent = true;

            res.write(
              `data: ${JSON.stringify({ text: piece })}\n\n`
            );

          }

        }

        if (!sent) {

          res.write(
            `data: ${JSON.stringify({
              text: 'Sorry, I could not generate a response.'
            })}\n\n`
          );

        }

        res.write('data: [DONE]\n\n');

      } catch (error) {

        console.error('CHAT STREAM ERROR:', error);

        raiseAlert(
          'chat failing',
          'medium',
          'Replies are failing part way through.',
          error?.message
        );

        res.write(
          `data: ${JSON.stringify({
            error: error?.message || 'Chat request failed'
          })}\n\n`
        );

      }

      res.end();

      return;

    }


    const response =
      await createReply(payload);

    const reply =
      response.choices?.[0]?.message?.content ||
      'Sorry, I could not generate a response.';

    res.json({
      reply
    });

  } catch (error) {

    console.error(
      'CHAT ERROR:',
      error
    );

    raiseAlert(
      'chat failing',
      'medium',
      'Chat replies are failing.',
      error?.message
    );

    res.status(500).json({
      error: 'Chat request failed',
      details:
        error?.message ||
        'Unknown error'
    });

  }

});


// =====================================================
// IMAGE GENERATION
// =====================================================

// =====================================================
// LEARNING (automatic memory)
//
// After each exchange, a small model reads what the user
// said and decides whether anything is worth remembering
// for every future chat. It hands back the updated list;
// the browser seals it and saves it. Nothing is kept here.
// =====================================================

const MEMORY_MODEL =
  process.env.MEMORY_MODEL || 'gpt-5.6-luna';

const MEMORY_RULES = `
You keep a short memory file about one user of a chat app, so the assistant knows them in every future chat.

You get the current memory (one fact per line) and the latest exchange. Decide whether the USER revealed something durable:
- who they are: name, age range, where they live or are based, languages
- work and ventures: job, company, businesses they run, their role
- people and pets in their life, by name and relationship
- ongoing projects, plans and goals
- how they want replies: tone, length, spelling, formats, things to avoid
- stable likes and dislikes

Rules:
- Only use what the USER said, never what the assistant said.
- Skip one-off questions, tasks, temporary moods and small talk.
- If they correct a fact, or their situation changes (moved, sold a business, new job), replace the old line with the new situation, e.g. "Sold the pizza takeaway in 2026", rather than just deleting it.
- If they ask you to forget something, remove it.
- If they say "remember ...", keep it (unless it is one of the never-store items below).
- Never store passwords, card or bank numbers, ID numbers, or addresses of other people.
- Keep each line short, plain and in the third person, e.g. "Name is Aaron", "Runs a pizza takeaway in Thornaby".
- Keep existing lines unless they are wrong, duplicated, or asked to be forgotten. At most 80 lines.

Reply with JSON only:
{"changed": true|false, "memory": ["every line of the updated memory"], "added": ["new or changed lines"], "removed": ["lines taken out"]}
`.trim();


app.post('/api/memory/learn', async (req, res) => {

  try {

    const user = await getUser(req);

    const who = user ? `learn:${user.id}` : `learn:${req.ip}`;

    if (!withinLimit(who, 200)) {
      return res.json({ changed: false });
    }

    const memory = String(req.body?.memory || '').slice(0, 8000);
    const said = String(req.body?.userText || '').slice(0, 4000);
    const reply = String(req.body?.reply || '').slice(0, 2000);

    if (said.trim().length < 3) {
      return res.json({ changed: false });
    }

    const completion =
      await createReply({
        model: MEMORY_MODEL,
        reasoning_effort: 'low',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: MEMORY_RULES },
          {
            role: 'user',
            content:
              `CURRENT MEMORY:\n${memory || '(empty)'}\n\n` +
              `USER SAID:\n${said}\n\n` +
              `ASSISTANT REPLIED (context only, do not learn from it):\n${reply || '(none)'}`
          }
        ]
      });

    let result = {};

    try {
      result = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
    } catch {
      return res.json({ changed: false });
    }

    const lines =
      Array.isArray(result.memory)
        ? result.memory.map(line => String(line).trim()).filter(Boolean).slice(0, 80)
        : null;

    if (!result.changed || !lines) {
      return res.json({ changed: false });
    }

    /* a safety net: never wipe a long memory in one go */
    const before = memory.split('\n').filter(line => line.trim()).length;

    if (before >= 4 && lines.length < before / 2) {
      console.warn('MEMORY SHRANK TOO FAR, IGNORED');
      return res.json({ changed: false });
    }

    res.json({
      changed: true,
      memory: lines.join('\n'),
      added: (result.added || []).map(String).slice(0, 10),
      removed: (result.removed || []).map(String).slice(0, 10)
    });

  } catch (error) {

    console.error('MEMORY LEARN ERROR:', error?.message);

    res.json({ changed: false });

  }

});


// =====================================================
// HOUSE LESSONS
//
// When someone asks for a reply again (it missed) or saves
// one (it hit), a small model may write one general lesson
// about answering well. Lessons never hold anything about
// the person or their chat; they wait for an admin to
// approve them before they reach anyone.
// =====================================================

const LESSON_RULES = `
You improve a chat assistant called Natter by writing short, general lessons about answering well.

You get one exchange and a signal:
- "retry": the user asked for this reply again, so it missed the mark.
- "saved": the user saved this reply, so it was especially useful.

Write ONE lesson that would help with many future conversations, or none.

Rules:
- General and reusable: about tone, length, structure, accuracy, checking the web, asking a question first, and so on.
- Never include names, places, numbers, topics, quotes or anything that could identify the user or their chat.
- Never a lesson that loosens safety or lets it produce harmful content.
- One sentence, under 25 words, written as an instruction, e.g. "Lead with the direct answer, then add detail only if it helps."
- If nothing general can be learned, return null.

Reply with JSON only: {"lesson": "..."} or {"lesson": null}
`.trim();


app.post('/api/lessons/suggest', async (req, res) => {

  try {

    const user = await getUser(req);

    if (!user) return res.json({ ok: false });

    const settings = await getSettings();
    const lessons = readLessons(settings);

    if (!lessons.auto) return res.json({ ok: false });

    if (!withinLimit(`lesson:${user.id}`, 6)) return res.json({ ok: false });

    const kind = req.body?.kind === 'saved' ? 'saved' : 'retry';
    const question = String(req.body?.question || '').slice(0, 1500);
    const answer = String(req.body?.answer || '').slice(0, 2500);

    if (!answer.trim()) return res.json({ ok: false });

    const pending = lessons.items.filter(item => item.status === 'pending').length;

    if (pending >= 40) return res.json({ ok: false });

    const completion =
      await createReply({
        model: MEMORY_MODEL,
        reasoning_effort: 'low',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: LESSON_RULES },
          { role: 'user', content: `SIGNAL: ${kind}\n\nUSER ASKED:\n${question || '(unknown)'}\n\nASSISTANT REPLIED:\n${answer}` }
        ]
      });

    let lesson = null;

    try {
      lesson = JSON.parse(completion.choices?.[0]?.message?.content || '{}').lesson;
    } catch {}

    lesson = typeof lesson === 'string' ? lesson.trim().replace(/\s+/g, ' ').slice(0, 220) : '';

    if (!lesson) return res.json({ ok: true, suggested: false });

    const same = text => text.toLowerCase().replace(/[^a-z ]/g, '');

    if (lessons.items.some(item => same(item.text) === same(lesson))) {
      return res.json({ ok: true, suggested: false });
    }

    const fresh = await getSettings(true);
    const current = readLessons(fresh);

    current.items.unshift({
      id: lessonId(),
      text: lesson,
      status: 'pending',
      from: kind,
      created_at: new Date().toISOString()
    });

    await saveSettings({ lessons: { auto: current.auto, items: current.items.slice(0, 200) } });

    res.json({ ok: true, suggested: true });

  } catch (error) {

    console.error('LESSON SUGGEST ERROR:', error?.message);

    res.json({ ok: false });

  }

});


app.post('/api/admin/lessons', async (req, res) => {

  const user = await requireAdmin(req, res);

  if (!user) return;

  try {

    const { action, id } = req.body || {};
    const text = String(req.body?.text || '').trim().replace(/\s+/g, ' ').slice(0, 300);

    const lessons = readLessons(await getSettings(true));
    const item = lessons.items.find(one => one.id === id);

    if (action === 'auto') {
      lessons.auto = req.body?.auto !== false;
    } else if (action === 'add') {
      if (!text) return res.status(400).json({ error: 'Write the lesson first.' });
      lessons.items.unshift({ id: lessonId(), text, status: 'approved', from: 'admin', created_at: new Date().toISOString() });
    } else if (!item) {
      return res.status(404).json({ error: 'That lesson has gone. Refresh and try again.' });
    } else if (action === 'approve') {
      if (text) item.text = text;
      item.status = 'approved';
    } else if (action === 'reject' || action === 'remove') {
      lessons.items = lessons.items.filter(one => one.id !== id);
    } else if (action === 'edit') {
      if (!text) return res.status(400).json({ error: 'A lesson cannot be empty.' });
      item.text = text;
    } else {
      return res.status(400).json({ error: 'Unknown action.' });
    }

    const { settings, volatile } = await saveSettings({ lessons });

    console.log(`LESSONS ${action} BY ${user.email}`);

    res.json({ lessons: readLessons(settings), volatile });

  } catch (error) {

    res.status(500).json({ error: error.message });

  }

});


// =====================================================
// UPLOADS
//
// Every photo someone uploads is kept. Signed in users save
// their own (the browser writes the file and the record);
// guests have no account, so theirs come through here and
// land in a guest folder. Admins can browse all of them.
// =====================================================

const UPLOAD_KINDS = ['ask', 'edit', 'video'];

app.post('/api/uploads/guest', async (req, res) => {

  try {

    if (!supabaseAdmin) return res.json({ ok: false });

    if (!withinLimit(`guestupload:${req.ip}`, 30)) {
      return res.status(429).json({ ok: false });
    }

    const match =
      /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.image || ''));

    if (!match) return res.status(400).json({ ok: false, error: 'Not a picture.' });

    const bytes = Buffer.from(match[2], 'base64');

    if (bytes.length > 8 * 1024 * 1024) {
      return res.status(413).json({ ok: false, error: 'That picture is too large.' });
    }

    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[match[1]];
    const day = new Date().toISOString().slice(0, 10);
    const path = `guest/${day}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const { error: upError } =
      await supabaseAdmin.storage.from('images')
        .upload(path, bytes, { contentType: match[1], upsert: false });

    if (upError) throw upError;

    await supabaseAdmin.from('uploads').insert({
      user_id: null,
      path,
      kind: UPLOAD_KINDS.includes(req.body?.kind) ? req.body.kind : 'ask'
    });

    res.json({ ok: true });

  } catch (error) {

    console.error('GUEST UPLOAD ERROR:', error?.message);

    res.json({ ok: false });

  }

});


const uploadEmailCache = new Map();

async function emailFor(userId) {

  if (!userId) return 'Guest';

  if (uploadEmailCache.has(userId)) return uploadEmailCache.get(userId);

  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
    const email = data?.user?.email || 'Deleted account';
    uploadEmailCache.set(userId, email);
    return email;
  } catch {
    return 'Unknown';
  }

}


app.get('/api/admin/uploads', async (req, res) => {

  const user = await requireAdmin(req, res);

  if (!user) return;

  try {

    const offset = Math.max(0, Number(req.query?.offset) || 0);
    const size = 48;

    const { data, error } =
      await supabaseAdmin
        .from('uploads')
        .select('id, user_id, path, kind, created_at')
        .order('created_at', { ascending: false })
        .range(offset, offset + size - 1);

    if (error) throw error;

    const rows = data || [];

    const signed =
      rows.length
        ? (await supabaseAdmin.storage.from('images').createSignedUrls(rows.map(row => row.path), 3600)).data || []
        : [];

    const items = [];

    for (const [index, row] of rows.entries()) {
      items.push({
        id: row.id,
        kind: row.kind,
        created_at: row.created_at,
        who: await emailFor(row.user_id),
        url: signed[index]?.signedUrl || null
      });
    }

    const { count } =
      await supabaseAdmin.from('uploads').select('id', { count: 'exact', head: true });

    res.json({ items, total: count ?? null, done: rows.length < size });

  } catch (error) {

    res.status(500).json({ error: error.message });

  }

});


app.post('/api/admin/uploads/delete', async (req, res) => {

  const user = await requireAdmin(req, res);

  if (!user) return;

  try {

    const { data: row } =
      await supabaseAdmin.from('uploads').select('id, path').eq('id', String(req.body?.id || '')).maybeSingle();

    if (!row) return res.status(404).json({ error: 'That upload has gone already.' });

    await supabaseAdmin.storage.from('images').remove([row.path]);
    await supabaseAdmin.from('uploads').delete().eq('id', row.id);

    console.log(`UPLOAD REMOVED BY ${user.email}: ${row.path}`);

    res.json({ ok: true });

  } catch (error) {

    res.status(500).json({ error: error.message });

  }

});


// =====================================================
// HELP ME WORD THIS
//
// Turns a rough idea into a clear, detailed request. When a
// request was refused, it suggests a version that genuinely
// fits the rules (it changes what is asked for, it never
// hides the same thing behind other words).
// =====================================================

const WORDING_RULES = `
You help people write better requests for an AI app that chats, makes images and makes short videos.

Rewrite the user's draft so it gets a great result:
- Keep their intent, language and voice. British English.
- For images and video: describe subject, setting, style, lighting, composition and mood in one flowing paragraph.
- For chat: make the question clear and specific, adding any context that obviously helps.
- Under 90 words. No preamble, no quotes around it.

Safety, always:
- The result must be something a mainstream AI image and chat service allows.
- If the draft asks for something that is not allowed (for example sexual or nude content, sexualising a real or identifiable person, minors in any suggestive context, graphic violence, hate, or real people in deceptive situations), CHANGE what is asked for so it genuinely fits: e.g. make a person fully clothed and non-sexual, make it a fictional character, drop the harmful element.
- Never keep the disallowed idea by disguising it with euphemisms or softer words. The point is a different, acceptable request, not a way past the filter.
- If nothing acceptable is left of it, say so in the note and return an empty text.

Reply with JSON only: {"text": "the rewritten request", "note": "one short sentence on what you changed, or empty"}
`.trim();


app.post('/api/prompt/improve', async (req, res) => {

  try {

    const user = await getUser(req);
    const who = user ? `word:${user.id}` : `word:${req.ip}`;

    if (!withinLimit(who, 60)) {
      return res.status(429).json({ error: 'Lots of rewrites this hour. Give it a little while.' });
    }

    const text = String(req.body?.text || '').trim().slice(0, 2000);
    const kind = ['image', 'video', 'edit', 'chat'].includes(req.body?.kind) ? req.body.kind : 'chat';
    const refused = req.body?.refused === true;

    if (!text) return res.status(400).json({ error: 'Type something first.' });

    const completion =
      await createReply({
        model: MEMORY_MODEL,
        reasoning_effort: 'low',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: WORDING_RULES },
          {
            role: 'user',
            content:
              `KIND: ${kind}${refused ? '\nTHIS WAS REFUSED by the image service\'s safety check, so the new version must genuinely change what is asked for.' : ''}\n\nDRAFT:\n${text}`
          }
        ]
      });

    let result = {};

    try {
      result = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
    } catch {}

    res.json({
      text: String(result.text || '').trim().slice(0, 1200),
      note: String(result.note || '').trim().slice(0, 300)
    });

  } catch (error) {

    console.error('WORDING ERROR:', error?.message);

    res.status(500).json({ error: 'Could not reword that just now.' });

  }

});


// =====================================================
// VOICE (OpenAI Realtime)
//
// Live spoken conversation. The browser talks to OpenAI
// directly over WebRTC; all we do is hand it a short lived
// key for one session, so our own key never leaves here.
// Admins only while it is tested.
// =====================================================

const VOICE_MODEL =
  process.env.VOICE_MODEL || 'gpt-realtime-2.1-mini';

const VOICE_NAME =
  process.env.VOICE_NAME || 'marin';


app.post('/api/voice/session', async (req, res) => {

  try {

    const user = await getUser(req);

    if (!user) {
      return res.status(401).json({ error: 'Sign in to talk to Natter.' });
    }

    if (!featureAllowed(await getSettings(), 'voice', user)) {
      return res.status(403).json({ error: 'Voice chat is not switched on at the moment.' });
    }

    if (await holdingBlocks(user)) {
      return res.status(503).json({ error: 'Natter is being prepared and is not open yet.' });
    }

    if (!withinLimit(`voice:${user.id}`, 30)) {
      return res.status(429).json({ error: 'Lots of calls this hour. Give it a little while.' });
    }

    const memory =
      String(req.body?.memory || '').slice(0, 4000);

    const recent =
      String(req.body?.recent || '').slice(0, 4000);

    const today =
      new Date().toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        timeZone: 'Europe/London'
      });

    const instructions = `
You are Natter AI, talking out loud with the user in a live voice call.

- Speak naturally and warmly, like a friend on the phone. British English.
- Keep replies short: a sentence or two unless they ask for more. No lists, no markdown, no reading out links.
- If they interrupt, stop and listen.
- Be helpful and direct. Only get flirty or cheeky if they clearly start it.
- Today is ${today}. You cannot browse the web in a call; if they need something current, say so and suggest asking in the text chat.

SAVED MEMORY (things they told you before):
${memory || '(none)'}

THE CHAT SO FAR (for context):
${recent || '(new chat)'}

HOUSE LESSONS (how to answer well):
${(await houseLessonLines()) || '(none yet)'}
`.trim();

    const response =
      await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cleanKey(process.env.OPENAI_API_KEY)}`,
          'Content-Type': 'application/json',
          'OpenAI-Safety-Identifier':
            createHash('sha256').update(String(user.id)).digest('hex')
        },
        body: JSON.stringify({
          expires_after: { anchor: 'created_at', seconds: 120 },
          session: {
            type: 'realtime',
            model: VOICE_MODEL,
            instructions,
            audio: {
              input: {
                transcription: { model: 'gpt-4o-mini-transcribe' },
                turn_detection: { type: 'semantic_vad' }
              },
              output: { voice: VOICE_NAME }
            }
          }
        })
      });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data?.value) {
      throw new Error(data?.error?.message || `Voice service error ${response.status}`);
    }

    res.json({ key: data.value, model: VOICE_MODEL });

  } catch (error) {

    console.error('VOICE SESSION ERROR:', error);

    raiseAlert('voice failing', 'medium', 'A voice call could not be started.', error?.message);

    res.status(500).json({ error: error?.message || 'Could not start the call.' });

  }

});


// =====================================================
// VIDEO (Google Veo)
//
// OpenAI's video API closes on 24 September 2026, so video
// comes from Google's Veo through the Gemini API. Admins
// only while it is tested. A clip takes anywhere from about
// ten seconds to a few minutes, so the browser starts a job
// and then asks after it until it is ready.
// =====================================================

const GEMINI_API_KEY = cleanKey(process.env.GEMINI_API_KEY);

const VIDEO_MODEL =
  process.env.VIDEO_MODEL || 'veo-3.1-lite-generate-preview';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/* which job belongs to whom, and finished clips for a short while */
const videoJobs = new Map();

function tidyVideoJobs() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of videoJobs) {
    if (job.created < cutoff) videoJobs.delete(id);
  }
}

async function geminiFetch(path, options = {}) {

  const response =
    await fetch(`${GEMINI_BASE}/${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
        ...(options.headers || {})
      }
    });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data?.error?.message || `Video service error ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return data;

}


async function refundVideo(userId, amount, why) {

  if (!amount) return;

  try {
    await addCredits(userId, amount, `refund: ${why}`, null);
  } catch (error) {
    raiseAlert('refund failed', 'high', `A failed video could not be refunded, account ${userId}. They are ${amount} credits short.`, error.message);
  }

}


app.post('/api/video', async (req, res) => {

  try {

    const user = await getUser(req);

    if (!user) {
      return res.status(401).json({ error: 'Sign in to create videos.' });
    }

    const settingsNow = await getSettings();

    if (!featureAllowed(settingsNow, 'video', user)) {
      return res.status(403).json({ error: 'Video is not switched on at the moment.' });
    }

    if (await holdingBlocks(user)) {
      return res.status(503).json({ error: 'Natter is being prepared and is not open yet.' });
    }

    if (!GEMINI_API_KEY) {
      return res.status(503).json({
        error: 'Video is not switched on yet. Add GEMINI_API_KEY on Render.'
      });
    }

    if (!withinLimit(`video:${user.id}`, 20)) {
      return res.status(429).json({ error: 'That is a lot of videos for one hour. Give it a little while.' });
    }

    const prompt = (await applyRules(String(req.body?.prompt || ''), 'images')).trim().slice(0, 2000);
    const shape = req.body?.shape === 'portrait' ? 'portrait' : 'landscape';
    const image = typeof req.body?.image === 'string' ? req.body.image : null;

    if (!prompt) {
      return res.status(400).json({ error: 'Describe the video you want.' });
    }

    /*
      A video costs VIDEO_CREDIT_COST image credits, unless
      they are an admin, hold the coupon, or the paywall is
      off. Taken now, handed back if the clip never arrives.
    */
    let charged = 0;

    if (!isAdmin(user) && settingsNow.paywall_enabled !== false) {

      const account = await readAccount(user.id);

      if (account.broken) {
        return res.status(503).json({ error: 'Could not check your balance. Try again in a moment.' });
      }

      if (!account.unlimited && !account.unmetered) {

        if ((account.credits || 0) < VIDEO_CREDIT_COST) {
          return res.status(402).json({
            error: `A video uses ${VIDEO_CREDIT_COST} images and you have ${account.credits || 0} left. Top up to carry on.`,
            needsCredit: true,
            packImages: settingsNow.pack_images,
            packPricePence: settingsNow.pack_price_pence
          });
        }

        await addCredits(user.id, -VIDEO_CREDIT_COST, 'video', null);

        charged = VIDEO_CREDIT_COST;

      }

    }

    req.videoCharged = charged;

    const instance = { prompt };

    /* a photo becomes the opening frame */
    if (image) {

      const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(image);

      if (!match) {
        return res.status(400).json({ error: 'That photo could not be read. Try a PNG or JPEG.' });
      }

      instance.image = { inlineData: { mimeType: match[1], data: match[2] } };

    }

    const parameters = {
      aspectRatio: shape === 'portrait' ? '9:16' : '16:9',
      resolution: '720p',
      durationSeconds: '8',
      /* the only setting Google allows for UK users */
      personGeneration: 'allow_adult'
    };

    let operation;

    try {

      try {

      operation =
        await geminiFetch(`models/${VIDEO_MODEL}:predictLongRunning`, {
          method: 'POST',
          body: JSON.stringify({ instances: [instance], parameters })
        });

    } catch (error) {

      /* some regions and models refuse the people setting, so try once without it */
      if (error.status === 400 && /person/i.test(error.message)) {
        delete parameters.personGeneration;
        operation =
          await geminiFetch(`models/${VIDEO_MODEL}:predictLongRunning`, {
            method: 'POST',
            body: JSON.stringify({ instances: [instance], parameters })
          });
      } else {
        throw error;
      }

    }

    if (!operation?.name) {
      throw new Error('The video service did not start a job.');
    }

    } catch (startError) {

      await refundVideo(user.id, charged, 'video did not start');

      throw startError;

    }

    tidyVideoJobs();

    videoJobs.set(operation.name, { userId: user.id, created: Date.now(), video: null, charged });

    console.log(`VIDEO STARTED: ${operation.name}`);

    res.json({ id: operation.name });

  } catch (error) {

    console.error('VIDEO START ERROR:', error);

    raiseAlert('video failing', 'medium', 'A video could not be started.', error?.message);

    res.status(500).json({ error: error?.message || 'Could not start the video.' });

  }

});


app.get('/api/video/status', async (req, res) => {

  try {

    const user = await getUser(req);

    if (!user) {
      return res.status(401).json({ error: 'Sign in to see your video.' });
    }

    const id = String(req.query?.id || '');
    const job = videoJobs.get(id);

    /* only the person who started a job can see it */
    if (!job || job.userId !== user.id) {
      return res.status(404).json({ error: 'That video job has expired. Try again.' });
    }

    if (job.video) {
      return res.json({ done: true, video: job.video });
    }

    const operation = await geminiFetch(id);

    if (!operation.done) {
      return res.json({ done: false });
    }

    if (operation.error) {
      videoJobs.delete(id);
      await refundVideo(user.id, job.charged, 'video failed');
      return res.json({ done: true, error: operation.error.message || 'The video could not be made.' });
    }

    const result = operation.response?.generateVideoResponse || {};

    const uri = result.generatedSamples?.[0]?.video?.uri;

    if (!uri) {

      videoJobs.delete(id);

      await refundVideo(user.id, job.charged, 'video blocked');

      const reason =
        (result.raiMediaFilteredReasons || []).join(' ') ||
        'The video was blocked by the safety filter. Try describing it differently.';

      return res.json({ done: true, error: reason });

    }

    const file =
      await fetch(uri, { headers: { 'x-goog-api-key': GEMINI_API_KEY } });

    if (!file.ok) {
      throw new Error(`Could not download the video (${file.status}).`);
    }

    const bytes = Buffer.from(await file.arrayBuffer());

    job.video = `data:video/mp4;base64,${bytes.toString('base64')}`;

    console.log(`VIDEO READY: ${id} (${Math.round(bytes.length / 1024)} KB)`);

    res.json({ done: true, video: job.video });

  } catch (error) {

    console.error('VIDEO STATUS ERROR:', error);

    res.status(500).json({ error: error?.message || 'Could not check on the video.' });

  }

});


app.post('/api/image', async (req, res) => {

  let user = null;

  try {

    user = await requireUser(req, res);

    if (!user) {
      return;
    }

    const {
      prompt: typedPrompt,

      /* 'square', 'portrait' or 'landscape' */
      shape = 'square'
    } = req.body;

    const prompt = await applyRules(typedPrompt, 'images');

    if (!prompt || !prompt.trim()) {

      return res.status(400).json({
        error: 'Image prompt is required'
      });

    }

    console.log(
      `IMAGE GENERATION: ${prompt}`
    );


    /*
      FREE REIN

      Text to image is the user's own idea, so their words
      go to the model as they wrote them. No house style,
      no extra subject rules, nothing added that they did
      not ask for.
    */

    const finalPrompt = prompt;


    console.log(
      'SENDING IMAGE TO OPENAI...'
    );


    const result =
      await openai.images.generate({

        model: 'gpt-image-2',

        prompt: finalPrompt,

        size: sizeFor(shape),

        quality: 'medium',

        n: 1

      });


    const imageData =
      result?.data?.[0]?.b64_json;


    if (!imageData) {

      throw new Error(
        'OpenAI returned no image data.'
      );

    }


    console.log(
      'IMAGE GENERATED SUCCESSFULLY'
    );


    res.json({

      image:
        `data:image/png;base64,${imageData}`,

      creditsLeft:
        user?.unlimited ? null : user?.creditsLeft

    });


  } catch (error) {

    console.error(
      'IMAGE GENERATION ERROR:',
      error
    );

    raiseAlert(
      'images failing',
      'medium',
      'Image generation is failing. Credits are being refunded.',
      error?.message
    );

    await refundCredit(user, 'generate failed');

    res.status(500).json({

      error:
        'Image generation failed',

      details:
        error?.message ||
        'Unknown error'

    });

  }

});


// =====================================================
// IMAGE EDIT / RE-RENDER
// =====================================================

app.post('/api/image/edit', async (req, res) => {

  let user = null;

  try {

    user = await requireUser(req, res);

    if (!user) {
      return;
    }

    const {
      prompt: typedPrompt,
      image,
      regenerate = false,

      /* 'square', 'portrait' or 'landscape' */
      shape = 'square',

      /*
        true when the source is a photograph the user
        uploaded, which is when likeness must be locked.
      */
      fromUpload = false
    } = req.body;

    const prompt = await applyRules(typedPrompt, 'images');


    if (!prompt || !prompt.trim()) {

      return res.status(400).json({
        error:
          'Image edit prompt is required'
      });

    }


    if (!image) {

      return res.status(400).json({
        error:
          'Original image is required'
      });

    }


    console.log(
      regenerate
        ? `IMAGE RE-RENDER: ${prompt}`
        : `IMAGE EDIT: ${prompt}`
    );


    // =================================================
    // GET IMAGE DATA
    // =================================================

    /*
      The image arrives either as a data URL from the
      browser, or as a link to Supabase Storage once the
      picture has been saved there.
    */

    let originalBuffer;

    if (/^https?:\/\//i.test(image)) {

      const fetched = await fetch(image);

      if (!fetched.ok) {

        throw new Error(
          `Could not fetch the source image (${fetched.status}).`
        );

      }

      originalBuffer =
        Buffer.from(await fetched.arrayBuffer());

    } else {

      const match =
        image.match(
          /^data:image\/[^;]+;base64,(.+)$/s
        );

      const base64Data =
        match
          ? match[1]
          : image;

      originalBuffer =
        Buffer.from(
          base64Data,
          'base64'
        );

    }


    console.log(
      `SOURCE IMAGE: ${originalBuffer.length} bytes`
    );


    if (!originalBuffer.length) {

      throw new Error(
        'The supplied image could not be decoded.'
      );

    }


    // =================================================
    // NORMALISE IMAGE
    // =================================================

    const normalizedBuffer =
      await sharp(originalBuffer)

        .rotate()

        .resize({

          width: 1536,

          height: 1536,

          fit: 'inside',

          withoutEnlargement: true

        })

        .flatten({
          background: '#ffffff'
        })

        .jpeg({

          quality: 95,

          mozjpeg: true

        })

        .toBuffer();


    console.log(
      `IMAGE CONVERTED: ${normalizedBuffer.length} bytes`
    );


    // =================================================
    // CREATE OPENAI FILE
    // =================================================

    const imageFile =
      await toFile(

        normalizedBuffer,

        'source-image.jpg',

        {
          type: 'image/jpeg'
        }

      );


    // =================================================
    // NORMAL EDIT
    // =================================================

    let finalPrompt = `
${fromUpload
  ? `THIS IS A PHOTO EDIT, NOT A NEW IMAGE.

The supplied photograph is a real photograph
of a real person, and they must come out the
other side as the same person.`
  : `EDIT THE SUPPLIED IMAGE.

The supplied image is an existing picture.
Keep its subject and concept.`}

EDIT REQUESTED BY THE USER:

${prompt}


SOURCE IMAGE:

The supplied image is the authoritative
visual source. Copy the face from it.

Treat the face as fixed. Change only what
the requested edit needs.

Preserve the existing subject and identity.

Only make changes necessary to satisfy
the user's request.


PERSON PRESERVATION:

If a person is present, preserve their
likeness as closely as possible.

Preserve:

- facial structure
- face shape
- facial proportions
- eyes
- eyebrows
- nose
- mouth
- lips
- cheeks
- jawline
- ears
- skin tone
- hair
- hairline
- hairstyle
- distinctive facial characteristics
- visible body proportions

Do not replace the person.

Do not create a generic person.

Do not unnecessarily change their face.

Do not unnecessarily beautify them.

Do not unnecessarily age or de-age them.

Do not change their identity.


${fromUpload
  ? `LIKENESS IS THE FIRST PRIORITY:

If the requested edit and the person's
likeness ever pull against each other,
the likeness wins.

A result showing a different face is a
failed result, however good it looks.

Someone who knows this person must
recognise them instantly.`
  : ''}

IMPORTANT:

Make the requested change while keeping
the rest of the image as consistent as
reasonably possible.

Do not redesign the entire image.

Do not introduce unrelated changes.

Keep the result realistic unless the user
specifically requested another style.
`;


    // =================================================
    // RE-RENDER
    // =================================================

    if (regenerate) {

      finalPrompt = `
RE-RENDER THE SUPPLIED IMAGE AS A NEW VERSION.

${prompt}

THE SUBJECT DOES NOT CHANGE:

Keep the same subject and identity as the supplied
image. ${fromUpload
  ? `The person in it is a real person. Keep their
facial structure, features, skin tone and hair. A
different face is a failed result.`
  : `Same character, same species, same markings,
same defining features.`}

THE SCENE DOES CHANGE:

Move the lighting, the camera angle and the
background. All three must be visibly different
from the supplied image.

The background must be a real place that suits
the subject. Never a blank studio floor, seamless
backdrop, empty tarmac or plain grey ground: an
empty floor adds nothing to the picture. The only
exception is when the original request asked for
a plain background.

Do not hand back the supplied image with small
touch ups. Do not keep the same angle, the same
light and the same backdrop.

QUALITY:

Improve realism, detail, texture, shadow and
clarity. Keep it photographic unless another
style was requested.
`;


    }


    console.log(
      regenerate
        ? 'SENDING CURRENT IMAGE FOR IMPROVEMENT...'
        : 'SENDING IMAGE FOR EDIT...'
    );


    // =================================================
    // OPENAI IMAGE EDIT
    // =================================================

    const result =
      await openai.images.edit({

        model: 'gpt-image-2',

        image: imageFile,

        prompt: finalPrompt,

        size: sizeFor(shape),

        quality: 'medium',

        n: 1

      });


    const imageData =
      result?.data?.[0]?.b64_json;


    if (!imageData) {

      throw new Error(
        'OpenAI returned no edited image data.'
      );

    }


    console.log(
      regenerate
        ? 'IMAGE RE-RENDER SUCCESSFUL'
        : 'IMAGE EDITED SUCCESSFULLY'
    );


    res.json({

      image:
        `data:image/png;base64,${imageData}`,

      creditsLeft:
        user?.unlimited ? null : user?.creditsLeft

    });


  } catch (error) {

    console.error(
      'IMAGE EDIT ERROR:',
      error
    );

    raiseAlert(
      'image edits failing',
      'medium',
      'Image edits and Improve are failing. Credits are being refunded.',
      error?.message
    );

    await refundCredit(user, 'edit failed');

    res.status(500).json({

      error:
        'Image edit failed',

      details:
        error?.message ||
        'Unknown error'

    });

  }

});


// =====================================================
// HOME
// =====================================================

app.get('/', (req, res) => {

  res.send(
    'Natter AI is running.'
  );

});


// =====================================================
// START SERVER
// =====================================================

/*
  Anything nobody caught. A promise that rejected is
  recorded and the server carries on. A thrown exception
  leaves the process in an unknown state, so it is recorded
  and the server exits, and Render starts a clean one.
*/
process.on('unhandledRejection', reason => {

  raiseAlert(
    'server error',
    'medium',
    'Something failed that nothing was waiting for.',
    reason?.message || String(reason)
  );

});

process.on('uncaughtException', error => {

  console.error('UNCAUGHT EXCEPTION:', error);

  raiseAlert(
    'server crashed',
    'high',
    'The server hit an error it could not recover from and restarted.',
    error?.message
  ).finally(() => {
    setTimeout(() => process.exit(1), 500);
  });

});


app.listen(PORT, () => {

  console.log(
    `Natter AI server running on port ${PORT}`
  );

});
