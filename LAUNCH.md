# Before opening Atla to the public

Checked 21 September 2026. In order of how badly each would hurt.

## 1. Email will fail. Fix before launch.

Supabase's built-in email sends **2 emails an hour for the whole
project**, and the setting is locked until you bring your own
sender. "Confirm email" is switched on, so every signup needs one,
and password resets draw on the same 2.

The third person to sign up in any hour gets no confirmation email
and cannot get in. They will not know why.

**Fix:** connect a proper sender under Supabase, Authentication,
Emails, SMTP Settings. Resend, Postmark and Brevo all have free
tiers big enough for a launch. You will need:

- **`heyatla.co.uk` to exist first.** Checked 21 September 2026 against
  two public resolvers: the domain does not resolve at all, so it is
  either not registered, or registered with no nameservers set. Until
  that is fixed, nothing can be sent from `hello@heyatla.co.uk`, and
  `privacy@heyatla.co.uk` in the legal pages cannot receive mail either
- then to verify `heyatla.co.uk` with the provider (a few DNS records,
  they walk you through it), so mail comes from `hello@heyatla.co.uk`
  rather than landing in spam
- the provider's SMTP host, port, username and password, pasted
  into that Supabase screen

Once it is saved, the rate limit field unlocks. 30 an hour is a
sensible start. Then paste the two styled templates from `emails/`
into Authentication, Emails, Templates.

## 2. The server sleeps. Stopgap in place, real fix is a paid plan.

Render's free plan sleeps after 15 quiet minutes and takes about 50
seconds to wake. The app warns people while it waits, but a first
impression of a minute's spinner is poor.

**Stopgap, already done:** `.github/workflows/keep-warm.yml` pings
the server every 10 minutes from 06:00 to midnight UTC, about 18
hours a day, which sits comfortably inside the free plan's monthly
allowance. GitHub switches scheduled
jobs off after 60 days with no commits to the repo, so if it goes
quiet, that is why.

**Real fix:** Render's paid instances never sleep. Check the
current price on Render, upgrade the Ai service, then delete the
keep-warm file.

## 3. Payments. Code verified, one real test purchase still needed.

Tested locally against the real server code with genuinely signed
Stripe events:

- a real `checkout.session.completed` is accepted and credits the
  pack
- a wrong secret, a missing signature, a replay from an hour ago,
  and a body altered after signing to claim 99,999 images are all
  refused

What cannot be tested from here is the round trip through Stripe's
own checkout page. Do one purchase yourself on the test card
`4242 4242 4242 4242`, any future expiry, any CVC, and check your
credits go up by 100 within a few seconds. Then check Stripe,
Developers, Webhooks, shows the delivery as succeeded.

Make sure the endpoint in Stripe is the **https** address. An earlier
build showed it as http, which Stripe refuses.

## 4. Done today

- CORS now only lets the app itself call the API from a browser.
  Stripe's webhook is server to server and unaffected.
- The Supabase key had a space in it from copying. Keys are now
  cleaned of all whitespace.

## Before going live with real money

- swap `sk_test_` for the live `sk_live_` key on Render
- create a **new** webhook endpoint in live mode, it has its own
  `whsec_`
- replace the sample company details in `privacy.html` and
  `terms.html` (highlighted, with a preview banner at the top) and
  delete the `.preview` banner
- switch the holding page off in Admin
