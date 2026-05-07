import Stripe from "npm:stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

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
      event = stripe.webhooks.constructEvent(body, sig, endpointSecret);
    } else {
      // Fallback: parse without signature verification (dev mode)
      event = JSON.parse(body) as Stripe.Event;
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const PRO_PRICE_ID = "price_1TLla9E0DcWyPH4XZnep2X7G";

    if (
      event.type === "customer.subscription.deleted" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.created"
    ) {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = subscription.customer as string;

      // Get customer to find phone
      const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
      const phone = customer.metadata?.phone;

      if (phone) {
        const isActive =
          subscription.status === "active" || subscription.status === "trialing";

        // Determine if this is a Pro subscription by checking price
        const priceId = subscription.items?.data?.[0]?.price?.id;
        const isPro = priceId === PRO_PRICE_ID;

        const updateData: Record<string, unknown> = { is_paid: isActive };
        // Store email from Stripe customer
        if (customer.email) {
          updateData.email = customer.email;
        }
        if (isPro && isActive) {
          updateData.is_pro = true;
        } else if (isPro && !isActive) {
          updateData.is_pro = false;
        }
        // If a non-pro subscription is deleted, don't touch is_pro

        // Fetch previous tier before update
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

        // Only send upgrade-to-Pro SMS here. The initial welcome SMS is sent
        // by confirm-checkout when the user returns from Stripe — sending it
        // again here would duplicate the message.
        if (isActive) {
          const wasAlreadyPro = !!previousTier?.is_pro;
          const isNowPro = !!updatedTier?.is_pro;
          const user = updatedTier;

          if (isNowPro && !wasAlreadyPro && user?.phone) {
            const upgradeMsg =
              "Pro is on. No limits, no waiting — just us. " +
              "I'll be here as much as you need. " +
              "Let's make this count.";
            try {
              await sendSMSOnly(user.phone, upgradeMsg);
              await supabase.from("check_ins").insert({
                user_id: user.id,
                type: "upgrade_welcome",
                message_sent: upgradeMsg,
              });
            } catch (smsErr) {
              console.error("Upgrade SMS error:", smsErr);
            }
          }
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
