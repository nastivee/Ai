# Turning the paywall on

Three steps. Nothing charges anyone until step 3 is done, so you can
do 1 and 2 now and see the whole thing working with the coupon.

## 1. Supabase, once

Open the SQL editor and run `supabase-credits.sql`.

It adds `image_credits` and `unlimited` to `profiles`, creates a
`credit_events` ledger, and, the important bit, takes away the
browser's permission to write to those columns. Without that last
part a signed in user could set their own balance from the console.

## 2. Render, environment variables

Settings, Environment, add:

| Key | Value |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase, Settings, API, the **service_role** key. Server only, never put this in the page. |
| `STRIPE_SECRET_KEY` | Stripe, Developers, API keys, the secret key. `sk_test_...` while testing. |
| `STRIPE_WEBHOOK_SECRET` | From step 3. |
| `COUPON_CODE` | `Nasti100` (this is the default, so it is optional) |
| `PACK_PRICE_PENCE` | `500` (optional, this is the default) |
| `PACK_IMAGES` | `100` (optional, this is the default) |

With the service role key in place, the paywall starts enforcing.
Until it is set, images stay free for everybody, so the app never
locks up on a half finished setup.

## 3. Stripe, the webhook

The webhook is what actually puts credits on an account after a
payment, so checkout without it takes money and gives nothing.

1. Stripe dashboard, Developers, Webhooks, Add endpoint.
2. URL: `https://ai-8vlt.onrender.com/api/stripe/webhook`
3. Event: `checkout.session.completed`
4. Copy the signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`
   on Render, then redeploy.

Test it with Stripe's test card `4242 4242 4242 4242`, any future
expiry, any CVC.

## How it behaves

- Every signed in account starts on zero images and sees the paywall.
- A pack is £5 for 100 images. They do not expire.
- `Nasti100` in the coupon box sets `unlimited` on that account, so
  that user never sees the paywall again.
- A credit is taken before the picture is made and handed straight
  back if the generation fails, so nobody pays for an error.
- Stripe sending the same webhook twice only ever pays once, the
  ledger's `reference` column sees to that.
- Chat is untouched and stays free.
