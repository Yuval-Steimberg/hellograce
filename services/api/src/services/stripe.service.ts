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

  const customer = await findCustomer(phone, graceUserId);
  if (!customer) {
    return {
      customer_id: null,
      customer_dashboard_url: null,
      subscription: null,
      payment_method: null,
    };
  }

  // Active subscription (active + trialing + past_due all count as "current").
  // expand the price + product so we can name the plan in the UI.
  const subs = await stripe.subscriptions.list({
    customer: customer.id,
    status: 'all',
    limit: 5,
    expand: ['data.items.data.price.product', 'data.default_payment_method'],
  });
  // Prefer the active/trialing/past_due over canceled/incomplete.
  const ranked = [...subs.data].sort((a, b) => statusPriority(a.status) - statusPriority(b.status));
  const sub = ranked[0] ?? null;

  let subscription: StripeBillingSnapshot['subscription'] = null;
  if (sub) {
    const item = sub.items.data[0];
    const price = item?.price;
    const product = price?.product;
    const planName =
      typeof product === 'object' && product && 'name' in product
        ? (product as Stripe.Product).name
        : price?.nickname ?? null;
    subscription = {
      id: sub.id,
      status: sub.status,
      plan_name: planName,
      // current_period_end is on the SubscriptionItem in 2025+ API.
      current_period_end: item?.current_period_end ?? null,
      amount: price?.unit_amount ?? null,
      currency: price?.currency ?? null,
      cancel_at_period_end: sub.cancel_at_period_end,
      canceled_at: sub.canceled_at ?? null,
    };
  }

  // Default payment method on the subscription (preferred) or customer.
  let pm: Stripe.PaymentMethod | null = null;
  if (sub && typeof sub.default_payment_method === 'object' && sub.default_payment_method) {
    pm = sub.default_payment_method;
  } else if (customer.invoice_settings?.default_payment_method) {
    const pmId =
      typeof customer.invoice_settings.default_payment_method === 'string'
        ? customer.invoice_settings.default_payment_method
        : customer.invoice_settings.default_payment_method.id;
    pm = await stripe.paymentMethods.retrieve(pmId).catch(() => null);
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
