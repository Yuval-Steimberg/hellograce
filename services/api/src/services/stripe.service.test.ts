import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

// ─── Mock the Stripe SDK ──────────────────────────────────────────────────────
// initStripe() does `new Stripe(key)`. We intercept the constructor so every
// instance shares these reconfigurable mock methods.
const m = {
  search: vi.fn(),
  retrieve: vi.fn(),
  subsList: vi.fn(),
  subsUpdate: vi.fn(),
  prodRetrieve: vi.fn(),
  constructEvent: vi.fn(),
};

vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(() => ({
    customers: { search: m.search, retrieve: m.retrieve, create: vi.fn() },
    subscriptions: { list: m.subsList, update: m.subsUpdate },
    products: { retrieve: m.prodRetrieve },
    webhooks: { constructEvent: m.constructEvent },
  })),
}));

import {
  initStripe,
  syncSubscriptionToDb,
  reactivateSubscription,
  changePlan,
  handleStripeWebhookEvent,
} from './stripe.service.js';

const PRO_PRICE = 'price_pro_123';
const BASE_PRICE = 'price_base_456';

/** Pool whose query() routes by SQL fragment. `selects` overrides the rows
 *  returned for SELECTs; every call is recorded for assertions. */
function makePool(selects: { userId?: unknown[]; phoneByCustomer?: unknown[] } = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/SELECT id FROM users/.test(sql)) return { rows: selects.userId ?? [{ id: 'user-uuid' }] };
    if (/SELECT phone FROM users WHERE stripe_customer_id/.test(sql)) {
      return { rows: selects.phoneByCustomer ?? [{ phone: '+15551112222' }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as unknown as Pool, calls, query };
}

function sub(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    status: 'active',
    cancel_at_period_end: false,
    canceled_at: null,
    items: { data: [{ id: 'si_1', price: { id: BASE_PRICE, nickname: 'Standard', product: 'prod_1' } }] },
    ...overrides,
  };
}

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  initStripe('sk_test_dummy');
});

describe('syncSubscriptionToDb', () => {
  it('mirrors an active base subscription → is_paid true, is_pro false', async () => {
    m.search.mockResolvedValueOnce({ data: [{ id: 'cus_1', metadata: {} }] });
    m.subsList.mockResolvedValueOnce({ data: [sub()] });
    m.prodRetrieve.mockResolvedValueOnce({ name: 'Grace Standard', deleted: false });
    const { pool, calls } = makePool();

    const res = await syncSubscriptionToDb(pool, '+15551112222', { proPriceId: PRO_PRICE });

    expect(res).toMatchObject({ synced: true, customer_id: 'cus_1', status: 'active', is_paid: true, is_pro: false });
    const update = calls.find((c) => /UPDATE users SET\s+stripe_customer_id/.test(c.sql));
    expect(update).toBeDefined();
    // params: [phone, customer, subId, status, plan, is_paid, is_pro]
    expect(update!.params).toEqual(['+15551112222', 'cus_1', 'sub_1', 'active', 'Grace Standard', true, false]);
  });

  it('flags is_pro when the subscription is on the pro price', async () => {
    m.search.mockResolvedValueOnce({ data: [{ id: 'cus_1', metadata: {} }] });
    m.subsList.mockResolvedValueOnce({ data: [sub({ items: { data: [{ id: 'si_1', price: { id: PRO_PRICE, product: 'prod_pro' } }] } })] });
    m.prodRetrieve.mockResolvedValueOnce({ name: 'Grace Pro', deleted: false });
    const { pool, calls } = makePool();

    const res = await syncSubscriptionToDb(pool, '+15551112222', { proPriceId: PRO_PRICE });

    expect(res).toMatchObject({ is_paid: true, is_pro: true });
    const update = calls.find((c) => /UPDATE users SET\s+stripe_customer_id/.test(c.sql));
    expect(update!.params[6]).toBe(true); // is_pro
  });

  it('canceled subscription → is_paid false (prevents drift)', async () => {
    m.search.mockResolvedValueOnce({ data: [{ id: 'cus_1', metadata: {} }] });
    m.subsList.mockResolvedValueOnce({ data: [sub({ status: 'canceled' })] });
    m.prodRetrieve.mockResolvedValueOnce({ name: 'Standard', deleted: false });
    const { pool, calls } = makePool();

    const res = await syncSubscriptionToDb(pool, '+15551112222', { proPriceId: PRO_PRICE });
    expect(res).toMatchObject({ is_paid: false, is_pro: false, status: 'canceled' });
    const update = calls.find((c) => /UPDATE users SET\s+stripe_customer_id/.test(c.sql));
    expect(update!.params[5]).toBe(false);
  });

  it('no Stripe customer → stamps synced_at + nulls customer, leaves is_paid untouched', async () => {
    m.search.mockResolvedValue({ data: [] }); // both phone + userId searches empty
    const { pool, calls } = makePool();

    const res = await syncSubscriptionToDb(pool, '+15551112222', { proPriceId: PRO_PRICE });
    expect(res).toMatchObject({ synced: true, customer_id: null, is_paid: null, is_pro: null });
    const update = calls.find((c) => /stripe_customer_id = NULL/.test(c.sql));
    expect(update).toBeDefined();
    // It must NOT touch is_paid in the no-customer path.
    expect(update!.sql).not.toMatch(/is_paid/);
  });

  it('records stripe_sync_error and returns synced:false on Stripe failure', async () => {
    m.search.mockRejectedValueOnce(new Error('stripe is down'));
    const { pool, calls } = makePool();

    const res = await syncSubscriptionToDb(pool, '+15551112222', { proPriceId: PRO_PRICE });
    expect(res).toMatchObject({ synced: false, error: 'stripe is down' });
    const errUpdate = calls.find((c) => /stripe_sync_error = \$2/.test(c.sql));
    expect(errUpdate!.params).toEqual(['+15551112222', 'stripe is down']);
  });

  it('returns null when the user does not exist', async () => {
    const { pool } = makePool({ userId: [] });
    const res = await syncSubscriptionToDb(pool, '+1nope', { proPriceId: PRO_PRICE });
    expect(res).toBeNull();
  });
});

describe('reactivateSubscription', () => {
  it('clears cancel_at_period_end on a scheduled-to-cancel sub', async () => {
    m.search.mockResolvedValueOnce({ data: [{ id: 'cus_1', metadata: {} }] });
    m.subsList.mockResolvedValueOnce({ data: [sub({ cancel_at_period_end: true })] });
    m.subsUpdate.mockResolvedValueOnce({ id: 'sub_1' });
    const { pool } = makePool();

    const res = await reactivateSubscription(pool, '+15551112222');
    expect(res).toEqual({ subscription_id: 'sub_1' });
    expect(m.subsUpdate).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: false });
  });

  it('returns null when nothing is scheduled to cancel', async () => {
    m.search.mockResolvedValueOnce({ data: [{ id: 'cus_1', metadata: {} }] });
    m.subsList.mockResolvedValueOnce({ data: [sub({ cancel_at_period_end: false })] });
    const { pool } = makePool();
    expect(await reactivateSubscription(pool, '+15551112222')).toBeNull();
    expect(m.subsUpdate).not.toHaveBeenCalled();
  });
});

describe('changePlan', () => {
  it('swaps the subscription item to the pro price with proration', async () => {
    m.search.mockResolvedValueOnce({ data: [{ id: 'cus_1', metadata: {} }] });
    m.subsList.mockResolvedValueOnce({ data: [sub()] }); // currently on BASE
    m.subsUpdate.mockResolvedValueOnce({ id: 'sub_1' });
    const { pool } = makePool();

    const res = await changePlan(pool, '+15551112222', 'pro', { basePriceId: BASE_PRICE, proPriceId: PRO_PRICE });
    expect(res).toEqual({ subscription_id: 'sub_1', plan: 'pro' });
    expect(m.subsUpdate).toHaveBeenCalledWith('sub_1', {
      items: [{ id: 'si_1', price: PRO_PRICE }],
      proration_behavior: 'create_prorations',
    });
  });

  it('is a no-op (no Stripe write) when already on the target price', async () => {
    m.search.mockResolvedValueOnce({ data: [{ id: 'cus_1', metadata: {} }] });
    m.subsList.mockResolvedValueOnce({ data: [sub()] }); // on BASE
    const { pool } = makePool();

    const res = await changePlan(pool, '+15551112222', 'base', { basePriceId: BASE_PRICE, proPriceId: PRO_PRICE });
    expect(res).toEqual({ subscription_id: 'sub_1', plan: 'base' });
    expect(m.subsUpdate).not.toHaveBeenCalled();
  });
});

describe('handleStripeWebhookEvent', () => {
  it('subscription.updated → mirrors status/flags, resolves user by stripe_customer_id', async () => {
    const { pool, calls } = makePool({ phoneByCustomer: [{ phone: '+15559998888' }] });
    const event = {
      id: 'evt_1',
      type: 'customer.subscription.updated',
      data: { object: sub({ customer: 'cus_99', status: 'active', items: { data: [{ id: 'si', price: { id: PRO_PRICE } }] } }) },
    } as never;

    const res = await handleStripeWebhookEvent(pool, event, { proPriceId: PRO_PRICE });
    expect(res).toEqual({ status: 'processed', target_user: '+15559998888' });
    const update = calls.find((c) => /UPDATE users SET\s+stripe_customer_id/.test(c.sql));
    expect(update!.params).toEqual(['+15559998888', 'cus_99', 'sub_1', 'active', true, true]);
    // Did NOT need to retrieve the customer (fast path via stripe_customer_id).
    expect(m.retrieve).not.toHaveBeenCalled();
  });

  it('subscription.deleted → forces is_paid/is_pro false regardless of object status', async () => {
    const { pool, calls } = makePool({ phoneByCustomer: [{ phone: '+1555' }] });
    const event = {
      id: 'evt_2',
      type: 'customer.subscription.deleted',
      data: { object: sub({ customer: 'cus_99', status: 'active' }) }, // stale active
    } as never;

    const res = await handleStripeWebhookEvent(pool, event, { proPriceId: PRO_PRICE });
    expect(res.status).toBe('processed');
    const update = calls.find((c) => /UPDATE users SET\s+stripe_customer_id/.test(c.sql));
    expect(update!.params[3]).toBe('canceled'); // status
    expect(update!.params[4]).toBe(false);      // is_paid
    expect(update!.params[5]).toBe(false);      // is_pro
  });

  it('falls back to customer.metadata.phone and backfills stripe_customer_id', async () => {
    const { pool, calls } = makePool({ phoneByCustomer: [] }); // not found by id
    m.retrieve.mockResolvedValueOnce({ id: 'cus_meta', metadata: { phone: '+1backfill' }, deleted: false });
    const event = {
      id: 'evt_3',
      type: 'customer.subscription.updated',
      data: { object: sub({ customer: 'cus_meta' }) },
    } as never;

    const res = await handleStripeWebhookEvent(pool, event, { proPriceId: PRO_PRICE });
    expect(res.target_user).toBe('+1backfill');
    const backfill = calls.find((c) => /UPDATE users SET stripe_customer_id = \$2 WHERE phone/.test(c.sql));
    expect(backfill!.params).toEqual(['+1backfill', 'cus_meta']);
  });

  it('skips events with no resolvable customer', async () => {
    const { pool } = makePool();
    const event = { id: 'evt_4', type: 'invoice.payment_succeeded', data: { object: {} } } as never;
    const res = await handleStripeWebhookEvent(pool, event, { proPriceId: PRO_PRICE });
    expect(res.status).toBe('skipped');
  });

  it('invoice.payment_failed → marks past_due', async () => {
    const { pool, calls } = makePool({ phoneByCustomer: [{ phone: '+1pd' }] });
    const event = { id: 'evt_5', type: 'invoice.payment_failed', data: { object: { customer: 'cus_1' } } } as never;
    const res = await handleStripeWebhookEvent(pool, event, { proPriceId: PRO_PRICE });
    expect(res.status).toBe('processed');
    expect(calls.some((c) => /subscription_status = 'past_due'/.test(c.sql))).toBe(true);
  });
});
