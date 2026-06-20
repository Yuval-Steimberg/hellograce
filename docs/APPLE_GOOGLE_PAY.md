# Apple Pay & Google Pay in the Grace checkout

Grace's registration checkout accepts **credit card, Apple Pay, and Google Pay**.
All three run through Stripe — there is no custom wallet code. This doc explains
how it works, what must be configured for production, and how to verify it.

---

## How it works (architecture)

The checkout is the Stripe **Payment Element + Express Checkout Element** running
against a **SetupIntent** (the 3-day free trial saves a card now and charges
when the trial ends). It is **not** Stripe Checkout (hosted redirect).

```
PaymentStep.tsx
  └─ create-checkout edge fn
        └─ stripe.subscriptions.create({ trial_period_days: 3,
             payment_behavior: "default_incomplete",
             expand: ["pending_setup_intent"] })
        └─ returns SetupIntent client_secret
  └─ <Elements clientSecret>
        ├─ <ExpressCheckoutElement>   ← Apple Pay / Google Pay buttons
        │     onConfirm → stripe.confirmSetup({ elements, clientSecret })
        └─ <PaymentElement> + email   ← credit card
              submit → stripe.confirmSetup({ elements })
  └─ redirect: /onboarding?checkout=success
        └─ confirm-checkout edge fn → sets is_paid, backfills email/name
  └─ Stripe webhook (customer.subscription.* / invoice.*) → syncs is_paid/is_pro
```

**Key fact:** Apple Pay and Google Pay are *wallets funded by a card*. They are
**not** separate `payment_method_types` — they ride on `"card"`, which is already
enabled in `create-checkout`. The resulting payment method is a normal card, so
**subscription activation and the webhook behave identically** for card and
wallet payers. No backend logic branches on payment method.

**Device-aware visibility:** The Express Checkout Element auto-detects what the
device/browser/location supports and only renders the buttons that are available
(Apple Pay on Safari/iOS, Google Pay on Chrome/Android and supported Chrome
desktop). When no wallet is available — or the element fails to load — nothing
extra is shown and the user falls straight through to the credit-card form. The
"or pay with card" divider only appears when a wallet button is actually present.

**No secret keys on the frontend:** the browser only ever uses
`VITE_STRIPE_PUBLISHABLE_KEY` (`pk_*`). The secret key lives in Supabase secrets.

---

## Production configuration checklist

Do all of this in the **live** Stripe account (the one whose `sk_live_*` is set
as `STRIPE_SECRET_KEY` in Supabase, and whose `pk_live_*` is set as
`VITE_STRIPE_PUBLISHABLE_KEY` on Vercel). Test mode and live mode are configured
separately.

### 1. Enable the wallets
- Stripe Dashboard → **Settings → Payment methods**.
- Make sure **Apple Pay** and **Google Pay** are **on**. (Card is already on.)
- They're on by default for most accounts, but confirm in live mode.

### 2. Verify the domain (required for Apple Pay)
- Stripe Dashboard → **Settings → Payment methods → Payment method domains**
  (a.k.a. "Apple Pay" → registered domains).
- **Add every domain that serves the checkout page**, e.g.:
  - `graceglp.com`
  - `grace-admin-silk.vercel.app` (and any other Vercel alias in use)
- Stripe verifies the domain automatically — because the wallet button renders
  inside a Stripe-hosted iframe, you do **not** need to host the
  `.well-known/apple-developer-merchantid-domain-association` file yourself.
- Google Pay does **not** require domain verification.
- If a domain isn't registered, the **Apple Pay button simply won't appear** on
  that domain (Google Pay and card are unaffected) — fail-soft, never a hard
  error.

### 3. Confirm env vars / secrets line up (same account, live values)
| Where | Variable | Value |
|---|---|---|
| Vercel (web) | `VITE_STRIPE_PUBLISHABLE_KEY` | `pk_live_…` |
| Supabase secrets | `STRIPE_SECRET_KEY` | `sk_live_…` (same account as above) |
| Supabase secrets | `STRIPE_BASE_PRICE_ID` | live price id for the $12/mo plan |
| Supabase secrets | `STRIPE_PRO_PRICE_ID` | live price id for Pro |
| Supabase secrets | `STRIPE_WEBHOOK_SECRET` | `whsec_…` from the **live** webhook endpoint |

The publishable and secret keys **must** come from the same account, or the
SetupIntent client secret created by the backend won't be usable by the frontend.

### 4. Webhook endpoint
- The live Stripe webhook (currently the Supabase `stripe-webhook` function)
  must be subscribed to `customer.subscription.created/updated/deleted` and
  `invoice.payment_succeeded/failed`, with its signing secret set as
  `STRIPE_WEBHOOK_SECRET`. This is unchanged by the wallet work — wallet
  payments emit the exact same events.

---

## Error handling & fallback (already built in)

- **Wallet unavailable / fails to load** → nothing renders; the credit-card form
  is the normal path. (`onReady` with no `availablePaymentMethods`, or
  `onLoadError`, sets `walletAvailable=false`.)
- **User cancels the wallet sheet** → `onCancel` resets the button; the user can
  retry or use a card. No stuck state.
- **Payment fails** (`card_error` / `validation_error`) → a friendly,
  Stripe-provided message via `toast`; any other error → a generic friendly
  message. The user is never shown internal details and never stuck.
- Console breadcrumbs (`[payment] …`) are logged at each step for debugging.

---

## How to test

### Test mode (no real charge)
1. Set Vercel `VITE_STRIPE_PUBLISHABLE_KEY=pk_test_…` and Supabase
   `STRIPE_SECRET_KEY=sk_test_…` from the same test account; register the test
   domain under test-mode payment method domains.
2. **Card:** complete registration → payment screen → enter
   `4242 4242 4242 4242`, any future expiry/CVC → "Start my free trial" →
   confirmation. Verify the user is `is_paid` (admin dashboard) and the
   subscription is `trialing` in Stripe.
3. **Google Pay:** open the flow in Chrome (desktop with a saved Google Pay card,
   or Android) → the Google Pay button appears above "or pay with card" → tap →
   authorize → redirect to confirmation. Verify activation.
4. **Apple Pay:** open the flow in Safari on a Mac/iPhone with a card in Wallet
   → the Apple Pay button appears → authorize with Touch ID/Face ID → redirect.
   Verify activation. (Apple Pay only shows once the domain is verified.)
5. **Webhook:** confirm `customer.subscription.created` and (after trial) an
   `invoice.payment_*` event flips/keeps `is_paid` correctly.
6. **Failure:** use `4000 0000 0000 0002` (declined) → friendly error, user can
   retry. Cancel the wallet sheet → no stuck state.

### Live mode
Repeat steps 2–5 on the production domain with a real card/wallet (you can cancel
the subscription immediately after). Apple Pay will only appear once the live
domain is verified per step 2 above.

---

## Files involved
- `apps/web/src/components/onboarding/PaymentStep.tsx` — Express Checkout Element
  (Apple/Google Pay) + Payment Element (card), shared `confirmSetup`, friendly
  errors, device-aware divider. Reused by `Upgrade.tsx`.
- `supabase/functions/create-checkout/index.ts` — creates the trial subscription
  + SetupIntent (`card`/`link`; wallets ride on `card`).
- `supabase/functions/confirm-checkout/index.ts` — finalizes after redirect.
- `supabase/functions/stripe-webhook/index.ts` — subscription/invoice → `is_paid`.
