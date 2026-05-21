import Stripe from "npm:stripe@18.5.0";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01/Accounts";

async function sendSMSOnly(to: string, body: string) {
  const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
  const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
  if (!TWILIO_ACCOUNT_SID) throw new Error("TWILIO_ACCOUNT_SID not configured");
  if (!TWILIO_AUTH_TOKEN) throw new Error("TWILIO_AUTH_TOKEN not configured");
  const TWILIO_WHATSAPP_FROM = Deno.env.get("TWILIO_WHATSAPP_FROM");
  const TWILIO_FROM_NUMBER = Deno.env.get("TWILIO_FROM_NUMBER");
  const useWhatsApp = !!TWILIO_WHATSAPP_FROM;
  let TWILIO_FROM = useWhatsApp ? TWILIO_WHATSAPP_FROM! : TWILIO_FROM_NUMBER!;
  if (!TWILIO_FROM) throw new Error("No Twilio sender configured");
  if (useWhatsApp && !TWILIO_FROM.startsWith("whatsapp:")) TWILIO_FROM = `whatsapp:${TWILIO_FROM}`;
  const toAddr = useWhatsApp && !to.startsWith("whatsapp:") ? `whatsapp:${to}` : to;

  const auth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const url = `${TWILIO_API_BASE}/${TWILIO_ACCOUNT_SID}/Messages.json`;
  console.log(`[sendSMSOnly] transport=direct_twilio channel=${useWhatsApp ? "whatsapp" : "sms"}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: toAddr, From: TWILIO_FROM, Body: body }),
  });
  const data = await response.json();
  if (!response.ok) {
    console.error(`[sendSMSOnly] failed status=${response.status} code=${data?.code} message=${data?.message}`);
    throw new Error(`Twilio error [${response.status}]: ${JSON.stringify(data)}`);
  }
  return data;
}

function formatDate(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

interface UserRow {
  id: string;
  phone: string;
}

// Send a one-time notification, deduplicated by check_ins.type.
// Use this for events that only fire once per subscription lifecycle
// (trial_converted, cancel_scheduled, subscription_ended, subscription_reactivated).
async function sendOnce(
  supabase: SupabaseClient,
  user: UserRow,
  type: string,
  message: string,
) {
  const { data: existing } = await supabase
    .from("check_ins")
    .select("id")
    .eq("user_id", user.id)
    .eq("type", type)
    .limit(1)
    .maybeSingle();
  if (existing) {
    console.log(`[sendOnce] already sent ${type} to ${user.phone}, skipping`);
    return;
  }
  try {
    await sendSMSOnly(user.phone, message);
    await supabase.from("check_ins").insert({
      user_id: user.id,
      type,
      message_sent: message,
    });
    console.log(`[sendOnce] sent ${type} to ${user.phone}`);
  } catch (err) {
    console.error(`[sendOnce] failed to send ${type}:`, err);
  }
}

// Send a repeatable notification, deduplicated by a unique key (e.g. invoice ID).
// The key is embedded in message_sent as a hidden sentinel so subsequent
// retries of the same invoice don't fire again.
async function sendOncePerKey(
  supabase: SupabaseClient,
  user: UserRow,
  type: string,
  key: string,
  message: string,
) {
  const sentinel = `<${key}>`;
  const { data: existing } = await supabase
    .from("check_ins")
    .select("id")
    .eq("user_id", user.id)
    .eq("type", type)
    .ilike("message_sent", `%${sentinel}%`)
    .limit(1)
    .maybeSingle();
  if (existing) {
    console.log(`[sendOncePerKey] already sent ${type}:${key} to ${user.phone}, skipping`);
    return;
  }
  try {
    await sendSMSOnly(user.phone, message);
    // Store sentinel at the end so it's not visible in admin viewers' first line.
    await supabase.from("check_ins").insert({
      user_id: user.id,
      type,
      message_sent: `${message} ${sentinel}`,
    });
    console.log(`[sendOncePerKey] sent ${type}:${key} to ${user.phone}`);
  } catch (err) {
    console.error(`[sendOncePerKey] failed to send ${type}:${key}:`, err);
  }
}

async function findUserByCustomer(
  stripe: Stripe,
  supabase: SupabaseClient,
  customerId: string,
): Promise<{ user: UserRow | null; phone: string | null }> {
  const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
  const phone = customer.metadata?.phone ?? null;
  if (!phone) return { user: null, phone: null };
  const { data: user } = await supabase
    .from("users")
    .select("id, phone")
    .eq("phone", phone)
    .maybeSingle();
  return { user: user ?? null, phone };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    const body = await req.text();
    const sig = req.headers.get("stripe-signature");

    let event: Stripe.Event;

    const endpointSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (endpointSecret && sig) {
      event = await stripe.webhooks.constructEventAsync(body, sig, endpointSecret);
    } else {
      // Fallback: parse without signature verification (dev mode)
      event = JSON.parse(body) as Stripe.Event;
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Read from Supabase secret so this matches upgrade-to-pro + create-checkout.
    // Going live = set STRIPE_PRO_PRICE_ID in secrets, no code change needed.
    const PRO_PRICE_ID = Deno.env.get("STRIPE_PRO_PRICE_ID") ?? "price_1TLla9E0DcWyPH4XZnep2X7G";

    // ─── Subscription lifecycle events ─────────────────────────────────────
    if (
      event.type === "customer.subscription.deleted" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.created"
    ) {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = subscription.customer as string;

      const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
      const phone = customer.metadata?.phone;

      if (phone) {
        const isActive =
          subscription.status === "active" || subscription.status === "trialing";

        // Determine if this is a Pro subscription by checking price
        const priceId = subscription.items?.data?.[0]?.price?.id;
        const isPro = priceId === PRO_PRICE_ID;

        const updateData: Record<string, unknown> = { is_paid: isActive };
        if (customer.email) {
          updateData.email = customer.email;
        }
        if (isPro && isActive) {
          updateData.is_pro = true;
        } else if (isPro && !isActive) {
          updateData.is_pro = false;
        }

        const { data: previousTier } = await supabase
          .from("users")
          .select("id, phone, is_paid, is_pro")
          .eq("phone", phone)
          .maybeSingle();

        await supabase
          .from("users")
          .update(updateData)
          .eq("phone", phone);

        const { data: updatedTier } = await supabase
          .from("users")
          .select("id, phone, is_paid, is_pro")
          .eq("phone", phone)
          .maybeSingle();

        console.log(
          `Subscription ${event.type}: phone=${phone}, is_paid=${isActive}, is_pro=${isPro && isActive}`
        );

        const user = updatedTier as UserRow | null;

        // Pro upgrade notification (transition base → pro)
        if (isActive && user) {
          const wasAlreadyPro = !!previousTier?.is_pro;
          const isNowPro = !!updatedTier?.is_pro;

          if (isNowPro && !wasAlreadyPro) {
            await sendOnce(
              supabase,
              user,
              "upgrade_welcome",
              "Pro is on. No limits, no waiting, just us. I'll be here as much as you need. Let's make this count.",
            );
          }
        }

        // Subscription state transition notifications
        if (event.type === "customer.subscription.updated" && user) {
          const prev = (event.data as { previous_attributes?: Record<string, unknown> })
            .previous_attributes ?? {};

          // Trial converted to paid (first successful charge after trial)
          if (prev.status === "trialing" && subscription.status === "active") {
            await sendOnce(
              supabase,
              user,
              "trial_converted",
              "Your 3 day trial just wrapped up and you're officially in. So glad you're staying. Let's keep going.",
            );
          }

          // User scheduled cancellation (still has access until period end)
          if (
            prev.cancel_at_period_end === false &&
            subscription.cancel_at_period_end === true
          ) {
            const endDate = formatDate(subscription.current_period_end);
            const msg = endDate
              ? `Got it, your subscription is set to end on ${endDate}. You'll keep full access until then. I'll be here either way.`
              : `Got it, your subscription is canceled. You'll keep full access until the end of your billing period. I'll be here either way.`;
            await sendOnce(supabase, user, "cancel_scheduled", msg);
          }

          // User reactivated (un-canceled before period end)
          if (
            prev.cancel_at_period_end === true &&
            subscription.cancel_at_period_end === false
          ) {
            await sendOnce(
              supabase,
              user,
              "subscription_reactivated",
              "You're back. So glad. Nothing changes, I'm here as always.",
            );
          }

          // Payment past_due (Stripe is retrying the charge)
          if (prev.status !== "past_due" && subscription.status === "past_due") {
            await sendOnce(
              supabase,
              user,
              "subscription_past_due",
              "Heads up, your last payment didn't go through. Update your card here so we don't miss a beat: graceglp.com/settings",
            );
          }
        }

        // Subscription fully ended (immediate cancel or after retries exhausted)
        if (event.type === "customer.subscription.deleted" && user) {
          await sendOnce(
            supabase,
            user,
            "subscription_ended",
            "Your access has ended for now. If you want to come back, head to graceglp.com. I'll be here.",
          );
        }
      }
    }

    // ─── Invoice events ────────────────────────────────────────────────────
    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = invoice.customer as string;
      if (customerId) {
        const { user } = await findUserByCustomer(stripe, supabase, customerId);
        if (user) {
          const invoiceId = invoice.id ?? "unknown";
          await sendOncePerKey(
            supabase,
            user,
            "payment_failed",
            invoiceId,
            "Heads up, your last payment didn't go through. Update your card here so we don't miss a beat: graceglp.com/settings",
          );
        }
      }
    }

    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = invoice.customer as string;
      // Only notify when this is a real charge (not the $0 trial setup invoice)
      // and only for the first paid invoice after a trial conversion. Routine
      // monthly renewals don't need a notification — Stripe emails a receipt.
      const amountPaid = invoice.amount_paid ?? 0;
      const isFirstPaid = invoice.billing_reason === "subscription_cycle" ||
        invoice.billing_reason === "subscription_create";
      if (customerId && amountPaid > 0 && isFirstPaid) {
        const { user } = await findUserByCustomer(stripe, supabase, customerId);
        if (user) {
          // Stored once per subscription via type-only dedup. Renewals won't
          // re-fire because the check_in already exists.
          await sendOnce(
            supabase,
            user,
            "payment_succeeded_first",
            "Quick note, your payment went through. You're all set, and a receipt is on its way to your email. Thanks for being here.",
          );
        }
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Webhook error:", err);
    return new Response(JSON.stringify({ error: "Webhook error" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
