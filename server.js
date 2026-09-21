import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import sharp from 'sharp';
import { toFile } from 'openai/uploads';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

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
  starter_credits: Number(process.env.STARTER_CREDITS || 0)
};

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
        'Nastivee is being prepared and is not open yet.'
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

  }

}

// =====================================================
// STRIPE WEBHOOK
//
// This one route needs the body exactly as Stripe sent
// it, byte for byte, or the signature will not check out.
// So it is mounted before the JSON parser.
// =====================================================

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

          console.log(
            `PAID: ${userId} +${images}, balance ${balance}`
          );

        }

      }

    } catch (error) {

      console.error('WEBHOOK HANDLING ERROR:', error);

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
    service: 'Nastivee AI',
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
      holding: settings.holding_mode !== false
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
    holding: settings.holding_mode !== false
  });

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
                name: `${settings.pack_images} Nastivee images`,
                description:
                  `${settings.pack_images} image generations on ` +
                  'your Nastivee AI account. They do not expire.'
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

app.post('/api/chat', async (req, res) => {

  try {

    const user = await getUser(req);

    if (await holdingBlocks(user)) {

      return res.status(503).json({
        error:
          'Nastivee is being prepared and is not open yet.'
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
You are Nastivee AI.

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

USER MEMORY:

${JSON.stringify(memory, null, 2)}
`;

    const cleanMessages =
      Array.isArray(messages)
        ? messages.slice(-30)
        : [];


    /*
      VISION

      With a photo attached, the last message carries both
      the question and the picture, so Nastivee can answer
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

    const model =
      mode === 'smart'
        ? (process.env.SMART_MODEL || 'gpt-4o')
        : (process.env.FAST_MODEL || 'gpt-4o-mini');


    const payload = {

      model,

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

      try {

        const completion =
          await openai.chat.completions.create({
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
      await openai.chat.completions.create(payload);

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

app.post('/api/image', async (req, res) => {

  let user = null;

  try {

    user = await requireUser(req, res);

    if (!user) {
      return;
    }

    const {
      prompt,

      /* 'square', 'portrait' or 'landscape' */
      shape = 'square'
    } = req.body;

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
      prompt,
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
    'Nastivee AI is running.'
  );

});


// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, () => {

  console.log(
    `Nastivee AI server running on port ${PORT}`
  );

});
