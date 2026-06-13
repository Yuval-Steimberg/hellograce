// Thin wrapper around the Stripe SDK for admin Stripe-data reads + writes.
// Lives in the API (not edge functions) because admin auth is here too.

import Stripe from 'stripe';
import type { Pool } from 'pg';

let stripe: Stripe | null = null;

export function initStripe(secretKey: string | undefined): void {
  if (!secretKey) {
    stripe = null;
    return;
  }
  // apiVersion is typed as a literal union — cast to bypass exact-string check.
  // We use the latest stable version (matches Supabase edge functions).
  stripe = new Stripe(secretKey, { apiVersion: '2025-08-27.basil' as never });
}

export function isStripeEnabled(): boolean {
  return stripe !== null;
}

/** Verify + parse a Stripe webhook payload. Throws if the signature is bad.
 *  Exposed so the v2 webhook route can construct events without holding its
 *  own Stripe instance. */
export function constructWebhookEvent(
  rawBody: Buffer | string,
  signature: string,
  secret: string,
): Stripe.Event {
  if (!stripe) throw new Error('Stripe not configured');
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

export interface StripeBillingSnapshot {
  customer_id: string | null;
  customer_dashboard_url: string | null;
  subscription: {
    id: string;
    status: Stripe.Subscription.Status;
    plan_name: string | null;
    current_period_end: number | null; // unix seconds
    amount: number | null;             // in cents
    currency: string | null;
    cancel_at_period_end: boolean;
    canceled_at: number | null;
  } | null;
  payment_method: {
    brand: string | null;
    last4: string | null;
    exp_month: number | null;
    exp_year: number | null;
  } | null;
}

/**
 * Find a Stripe customer for the given Grace user. Tries phone first, then
 * grace_user_id. Returns null if no customer exists (e.g. user is on trial
 * and hasn't initiated checkout).
 */
async function findCustomer(userPhone: string, graceUserId: string): Promise<Stripe.Customer | null> {
  if (!stripe) return null;

  // Phone search is the primary path (set on customer creation in
  // create-checkout/confirm-checkout). Falls back to grace_user_id metadata
  // when the phone-metadata index is stale (Stripe search lags 30-60s).
  const byPhone = await stripe.customers.search({
    query: `metadata["phone"]:"${userPhone}"`,
    limit: 1,
  });
  if (byPhone.data.length > 0) return byPhone.data[0]!;

  const byUserId = await stripe.customers.search({
    query: `metadata["grace_user_id"]:"${graceUserId}"`,
    limit: 1,
  });
  return byUserId.data[0] ?? null;
}

/**
 * Fetch the live billing snapshot for a Grace user — subscription status,
 * plan, next billing, and payment method. Returns null only when Stripe
 * itself is not configured (no secret key). When the user has no Stripe
 * customer (e.g. trial user), returns a snapshot with all fields null.
 */
export async function getBillingSnapshot(
  pool: Pool,
  phone: string,
): Promise<StripeBillingSnapshot | null> {
  if (!stripe) return null;

  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE phone = $1 LIMIT 1`,
    [phone],
  );
  const graceUserId = rows[0]?.id;
  if (!graceUserId) return null;

  let customer: Stripe.Customer | null = null;
  try {
    customer = await findCustomer(phone, graceUserId);
  } catch (err) {
    // Stripe search can transiently 5xx or return a "search index unavailable"
    // error. Treat as "no customer found" rather than aborting the whole UI.
    // The error is the same shape the user would see if they actually had no
    // customer — admin can retry to clear.
    console.warn('[stripe.service] findCustomer failed', (err as Error).message);
  }
  if (!customer) {
    return {
      customer_id: null,
      customer_dashboard_url: null,
      subscription: null,
      payment_method: null,
    };
  }

  // Active subscription. We split the lookup into two steps so an expand
  // failure on the product side doesn't void the whole snapshot.
  let subs: Stripe.ApiList<Stripe.Subscription> | null = null;
  try {
    subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'all',
      limit: 5,
      expand: ['data.default_payment_method'],
    });
  } catch (err) {
    console.warn('[stripe.service] subscriptions.list failed', (err as Error).message);
  }
  // Prefer the active/trialing/past_due over canceled/incomplete.
  const ranked = subs ? [...subs.data].sort((a, b) => statusPriority(a.status) - statusPriority(b.status)) : [];
  const sub = ranked[0] ?? null;

  let subscription: StripeBillingSnapshot['subscription'] = null;
  if (sub) {
    const item = sub.items.data[0];
    const price = item?.price;
    // Fetch the product separately — safer than expand. Only call when we
    // have a string product id; if the price already came back with an
    // expanded product object (rare with our minimal expand list), use that.
    let planName: string | null = price?.nickname ?? null;
    try {
      if (price?.product) {
        if (typeof price.product === 'string') {
          const prod = await stripe.products.retrieve(price.product).catch(() => null);
          if (prod && !prod.deleted) planName = prod.name ?? planName;
        } else if ('name' in price.product) {
          planName = (price.product as Stripe.Product).name ?? planName;
        }
      }
    } catch (err) {
      console.warn('[stripe.service] products.retrieve failed', (err as Error).message);
    }
    // current_period_end lives on the Subscription (top-level) in the public
    // API. Cast through unknown because Stripe's TS types in v22 are noisier.
    const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end
      ?? item?.current_period_end
      ?? null;
    subscription = {
      id: sub.id,
      status: sub.status,
      plan_name: planName,
      current_period_end: periodEnd,
      amount: price?.unit_amount ?? null,
      currency: price?.currency ?? null,
      cancel_at_period_end: sub.cancel_at_period_end,
      canceled_at: sub.canceled_at ?? null,
    };
  }

  // Default payment method on the subscription (preferred) or customer.
  let pm: Stripe.PaymentMethod | null = null;
  try {
    if (sub && typeof sub.default_payment_method === 'object' && sub.default_payment_method) {
      pm = sub.default_payment_method;
    } else if (customer.invoice_settings?.default_payment_method) {
      const pmId =
        typeof customer.invoice_settings.default_payment_method === 'string'
          ? customer.invoice_settings.default_payment_method
          : customer.invoice_settings.default_payment_method.id;
      pm = await stripe.paymentMethods.retrieve(pmId).catch(() => null);
    }
  } catch (err) {
    console.warn('[stripe.service] payment method lookup failed', (err as Error).message);
  }

  const card = pm?.card ?? null;
  return {
    customer_id: customer.id,
    customer_dashboard_url: `https://dashboard.stripe.com/customers/${customer.id}`,
    subscription,
    payment_method: card
      ? {
          brand: card.brand,
          last4: card.last4,
          exp_month: card.exp_month,
          exp_year: card.exp_year,
        }
      : null,
  };
}

/**
 * Cancel the user's most-recent active/trialing subscription at period end.
 * Returns the new subscription state or null if no cancellable sub found.
 * Idempotent — safe to call multiple times.
 */
export async function cancelSubscriptionAtPeriodEnd(
  pool: Pool,
  phone: string,
): Promise<{ subscription_id: string; cancel_at: number | null } | null> {
  if (!stripe) return null;

  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE phone = $1 LIMIT 1`,
    [phone],
  );
  const graceUserId = rows[0]?.id;
  if (!graceUserId) return null;

  const customer = await findCustomer(phone, graceUserId);
  if (!customer) return null;

  const subs = await stripe.subscriptions.list({
    customer: customer.id,
    status: 'all',
    limit: 5,
  });
  // Pick the active or trialing one (don't try to "cancel" already-canceled subs).
  const target = subs.data.find(
    (s) => s.status === 'active' || s.status === 'trialing' || s.status === 'past_due',
  );
  if (!target) return null;

  const updated = await stripe.subscriptions.update(target.id, {
    cancel_at_period_end: true,
  });
  return {
    subscription_id: updated.id,
    cancel_at: updated.cancel_at ?? null,
  };
}

/**
 * Idempotently ensure a Stripe customer exists for a Grace user. Called at
 * signup time so trial users appear in the Stripe dashboard from day one.
 * Lookup by phone metadata first (preferred), then grace_user_id, then
 * create with both. Safe to call multiple times — duplicate creates are
 * avoided by the search step.
 *
 * Returns the customer ID, or null when Stripe is not configured (so the
 * caller can degrade silently — onboarding must never block on Stripe).
 */
export async function ensureStripeCustomer(input: {
  graceUserId: string;
  phone: string;
  firstName?: string;
  medication?: string;
}): Promise<string | null> {
  if (!stripe) return null;

  // Existing customer? (handles re-onboarding the same phone, or any prior
  // checkout flow that already created one.)
  const byPhone = await stripe.customers.search({
    query: `metadata["phone"]:"${input.phone}"`,
    limit: 1,
  });
  if (byPhone.data.length > 0) return byPhone.data[0]!.id;

  const byUserId = await stripe.customers.search({
    query: `metadata["grace_user_id"]:"${input.graceUserId}"`,
    limit: 1,
  });
  if (byUserId.data.length > 0) return byUserId.data[0]!.id;

  // Fresh customer. Include both phone + grace_user_id metadata so future
  // lookups via either key succeed.
  const customer = await stripe.customers.create({
    name: input.firstName,
    phone: input.phone,
    metadata: {
      phone: input.phone,
      grace_user_id: input.graceUserId,
      ...(input.medication ? { medication: input.medication } : {}),
      source: 'grace_onboarding',
    },
  });
  return customer.id;
}

// Statuses that grant access. past_due is included so a transient payment
// retry doesn't immediately revoke access (Stripe keeps the sub active-ish
// while it retries). canceled / unpaid / incomplete* revoke access.
const PAID_STATUSES = new Set<Stripe.Subscription.Status>(['active', 'trialing', 'past_due']);

export interface SubscriptionSummary {
  subscription_id: string;
  status: Stripe.Subscription.Status;
  price_id: string | null;
  plan_name: string | null;
  cancel_at_period_end: boolean;
  is_paid: boolean;
  is_pro: boolean;
}

/** Reduce a Stripe subscription to the flags we mirror in our DB. `proPriceId`
 *  determines which price counts as the Pro tier. */
function summarizeSubscription(
  sub: Stripe.Subscription,
  proPriceId: string | undefined,
): SubscriptionSummary {
  const item = sub.items.data[0];
  const price = item?.price;
  const priceId = price?.id ?? null;
  const isPaid = PAID_STATUSES.has(sub.status);
  const isPro = isPaid && !!proPriceId && priceId === proPriceId;
  return {
    subscription_id: sub.id,
    status: sub.status,
    price_id: priceId,
    plan_name: price?.nickname ?? null,
    cancel_at_period_end: sub.cancel_at_period_end,
    is_paid: isPaid,
    is_pro: isPro,
  };
}

export interface SyncResult {
  synced: boolean;
  customer_id: string | null;
  status: Stripe.Subscription.Status | null;
  is_paid: boolean | null;
  is_pro: boolean | null;
  error?: string;
}

/**
 * Pull the user's live Stripe state and mirror it into the users row
 * (stripe_customer_id, stripe_subscription_id, subscription_status,
 * subscription_plan, is_paid, is_pro, stripe_synced_at). This is the
 * "Sync from Stripe" action — the canonical way to repair drift between the
 * dashboard and Stripe.
 *
 * Rules:
 *  - No Stripe customer at all → we can't infer billing; we leave is_paid/
 *    is_pro untouched (don't flip a manually-comped or trial user), just
 *    stamp stripe_synced_at + null the customer id.
 *  - Customer with no subscription → is_paid/is_pro = false (no active plan).
 *  - Customer with a subscription → mirror its status/flags exactly.
 *  - Any Stripe error is recorded in stripe_sync_error (and returned), never
 *    thrown to the caller — the dashboard shows the error inline.
 */
export async function syncSubscriptionToDb(
  pool: Pool,
  phone: string,
  opts?: { proPriceId?: string },
): Promise<SyncResult | null> {
  if (!stripe) return null;
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE phone = $1 LIMIT 1`,
    [phone],
  );
  const graceUserId = rows[0]?.id;
  if (!graceUserId) return null;

  try {
    const customer = await findCustomer(phone, graceUserId);
    if (!customer) {
      await pool.query(
        `UPDATE users SET stripe_customer_id = NULL, stripe_synced_at = now(),
                stripe_sync_error = NULL
         WHERE phone = $1`,
        [phone],
      );
      return { synced: true, customer_id: null, status: null, is_paid: null, is_pro: null };
    }

    const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 5 });
    const ranked = [...subs.data].sort((a, b) => statusPriority(a.status) - statusPriority(b.status));
    const sub = ranked[0] ?? null;
    const summary = sub ? summarizeSubscription(sub, opts?.proPriceId) : null;

    let planName = summary?.plan_name ?? null;
    if (sub && summary?.price_id) {
      // Resolve a human plan name from the product (nickname is often unset).
      const prodRef = sub.items.data[0]?.price?.product;
      if (typeof prodRef === 'string') {
        const prod = await stripe.products.retrieve(prodRef).catch(() => null);
        if (prod && !prod.deleted) planName = prod.name ?? planName;
      }
    }

    const isPaid = summary?.is_paid ?? false;
    const isPro = summary?.is_pro ?? false;
    await pool.query(
      `UPDATE users SET
         stripe_customer_id = $2,
         stripe_subscription_id = $3,
         subscription_status = $4,
         subscription_plan = $5,
         is_paid = $6,
         is_pro = $7,
         stripe_synced_at = now(),
         stripe_sync_error = NULL
       WHERE phone = $1`,
      [phone, customer.id, summary?.subscription_id ?? null, summary?.status ?? null, planName, isPaid, isPro],
    );
    return {
      synced: true,
      customer_id: customer.id,
      status: summary?.status ?? null,
      is_paid: isPaid,
      is_pro: isPro,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await pool
      .query(`UPDATE users SET stripe_synced_at = now(), stripe_sync_error = $2 WHERE phone = $1`, [phone, msg])
      .catch(() => undefined);
    return { synced: false, customer_id: null, status: null, is_paid: null, is_pro: null, error: msg };
  }
}

/**
 * Undo a scheduled cancellation (cancel_at_period_end = false). Only works
 * while the subscription is still active/trialing/past_due and within its
 * period — a fully-canceled sub cannot be reactivated and returns null (the
 * user must re-checkout). Idempotent.
 */
export async function reactivateSubscription(
  pool: Pool,
  phone: string,
): Promise<{ subscription_id: string } | null> {
  if (!stripe) return null;
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM users WHERE phone = $1 LIMIT 1`, [phone]);
  const graceUserId = rows[0]?.id;
  if (!graceUserId) return null;
  const customer = await findCustomer(phone, graceUserId);
  if (!customer) return null;

  const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 5 });
  const target = subs.data.find(
    (s) => (s.status === 'active' || s.status === 'trialing' || s.status === 'past_due') && s.cancel_at_period_end,
  );
  if (!target) return null;
  const updated = await stripe.subscriptions.update(target.id, { cancel_at_period_end: false });
  return { subscription_id: updated.id };
}

/**
 * Move the user's active subscription to the Standard (base) or Pro price,
 * pro-rating mid-cycle. Returns null if no swappable subscription exists.
 */
export async function changePlan(
  pool: Pool,
  phone: string,
  target: 'base' | 'pro',
  priceIds: { basePriceId: string; proPriceId: string },
): Promise<{ subscription_id: string; plan: 'base' | 'pro' } | null> {
  if (!stripe) return null;
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM users WHERE phone = $1 LIMIT 1`, [phone]);
  const graceUserId = rows[0]?.id;
  if (!graceUserId) return null;
  const customer = await findCustomer(phone, graceUserId);
  if (!customer) return null;

  const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 5 });
  const sub = subs.data.find((s) => s.status === 'active' || s.status === 'trialing' || s.status === 'past_due');
  if (!sub) return null;
  const item = sub.items.data[0];
  if (!item) return null;
  const newPrice = target === 'pro' ? priceIds.proPriceId : priceIds.basePriceId;
  if (item.price?.id === newPrice) return { subscription_id: sub.id, plan: target }; // already on it

  await stripe.subscriptions.update(sub.id, {
    items: [{ id: item.id, price: newPrice }],
    proration_behavior: 'create_prorations',
  });
  return { subscription_id: sub.id, plan: target };
}

export interface WebhookHandleResult {
  status: 'processed' | 'skipped';
  target_user: string | null;
  reason?: string;
}

/**
 * Apply a Stripe webhook event to our DB. Resolves the affected user by
 * stripe_customer_id (fast path) or by the customer's phone metadata
 * (fallback, also backfills the id). Mirrors subscription state with the same
 * rules as syncSubscriptionToDb. Pure DB writes — no message sends.
 *
 * Returns 'skipped' for event types we don't act on (still recorded in
 * stripe_events for the audit trail).
 */
export async function handleStripeWebhookEvent(
  pool: Pool,
  event: Stripe.Event,
  opts: { proPriceId?: string },
): Promise<WebhookHandleResult> {
  const type = event.type;

  // Resolve the Stripe customer id off whichever object this event carries.
  const obj = event.data.object as { customer?: string | { id: string }; id?: string };
  const customerId =
    typeof obj.customer === 'string' ? obj.customer : obj.customer?.id ?? null;

  if (!customerId) {
    return { status: 'skipped', target_user: null, reason: 'no customer on event' };
  }

  // Find the Grace user for this customer.
  let phone: string | null = null;
  const { rows: byId } = await pool.query<{ phone: string }>(
    `SELECT phone FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
    [customerId],
  );
  phone = byId[0]?.phone ?? null;
  if (!phone && stripe) {
    const cust = await stripe.customers.retrieve(customerId).catch(() => null);
    const meta = cust && !('deleted' in cust && cust.deleted) ? (cust as Stripe.Customer).metadata : undefined;
    phone = meta?.phone ?? null;
    if (phone) {
      // Backfill the id so the next event takes the fast path.
      await pool.query(`UPDATE users SET stripe_customer_id = $2 WHERE phone = $1`, [phone, customerId]).catch(() => undefined);
    }
  }
  if (!phone) {
    return { status: 'skipped', target_user: null, reason: 'no matching user' };
  }

  switch (type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      // deleted → no access regardless of the (stale) status on the object.
      const summary = type === 'customer.subscription.deleted'
        ? { ...summarizeSubscription(sub, opts.proPriceId), is_paid: false, is_pro: false, status: 'canceled' as Stripe.Subscription.Status }
        : summarizeSubscription(sub, opts.proPriceId);
      await pool.query(
        `UPDATE users SET
           stripe_customer_id = $2,
           stripe_subscription_id = $3,
           subscription_status = $4,
           is_paid = $5,
           is_pro = $6,
           stripe_synced_at = now(),
           stripe_sync_error = NULL
         WHERE phone = $1`,
        [phone, customerId, summary.subscription_id, summary.status, summary.is_paid, summary.is_pro],
      );
      return { status: 'processed', target_user: phone };
    }
    case 'invoice.payment_failed': {
      await pool.query(
        `UPDATE users SET subscription_status = 'past_due', stripe_synced_at = now() WHERE phone = $1`,
        [phone],
      );
      return { status: 'processed', target_user: phone };
    }
    case 'invoice.payment_succeeded': {
      await pool.query(
        `UPDATE users SET is_paid = TRUE, stripe_synced_at = now(), stripe_sync_error = NULL WHERE phone = $1`,
        [phone],
      );
      return { status: 'processed', target_user: phone };
    }
    default:
      return { status: 'skipped', target_user: phone, reason: `unhandled type ${type}` };
  }
}

/** Idempotently record a webhook event + its processing outcome. */
export async function recordStripeEvent(
  pool: Pool,
  event: Pick<Stripe.Event, 'id' | 'type' | 'data'>,
  result: { status: string; target_user: string | null; error?: string },
): Promise<void> {
  await pool
    .query(
      `INSERT INTO stripe_events (stripe_event_id, type, status, target_user, payload, error, attempts, processed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 1, now())
       ON CONFLICT (stripe_event_id) DO UPDATE SET
         status = EXCLUDED.status,
         target_user = EXCLUDED.target_user,
         error = EXCLUDED.error,
         attempts = stripe_events.attempts + 1,
         processed_at = now()`,
      [
        event.id,
        event.type,
        result.status,
        result.target_user,
        JSON.stringify(event.data?.object ?? {}),
        result.error ?? null,
      ],
    )
    .catch(() => undefined);
}

// Rank subscription statuses so active ones float to the top when sorting.
function statusPriority(status: Stripe.Subscription.Status): number {
  switch (status) {
    case 'active': return 0;
    case 'trialing': return 1;
    case 'past_due': return 2;
    case 'unpaid': return 3;
    case 'incomplete': return 4;
    case 'incomplete_expired': return 5;
    case 'canceled': return 6;
    case 'paused': return 7;
    default: return 99;
  }
}
