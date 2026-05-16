import Stripe from "npm:stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01/Accounts";

async function sendSMS(to: string, body: string) {
  const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
  const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
  const TWILIO_WHATSAPP_FROM = Deno.env.get("TWILIO_WHATSAPP_FROM");
  const TWILIO_FROM = Deno.env.get("TWILIO_FROM_NUMBER");
  if (!TWILIO_ACCOUNT_SID) throw new Error("TWILIO_ACCOUNT_SID not configured");
  if (!TWILIO_AUTH_TOKEN) throw new Error("TWILIO_AUTH_TOKEN not configured");

  const auth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const url = `${TWILIO_API_BASE}/${TWILIO_ACCOUNT_SID}/Messages.json`;

  async function attempt(fromAddr: string, toAddr: string) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: toAddr, From: fromAddr, Body: body }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error(`[sendSMS confirm-checkout] failed status=${response.status} code=${data?.code} message=${data?.message}`);
      throw new Error(`Twilio error [${response.status}]: ${JSON.stringify(data)}`);
    }
    return data;
  }

  if (TWILIO_WHATSAPP_FROM) {
    let waFrom = TWILIO_WHATSAPP_FROM;
    if (!waFrom.startsWith("whatsapp:")) waFrom = `whatsapp:${waFrom}`;
    const waTo = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
    try {
      console.log(`[sendSMS confirm-checkout] transport=direct_twilio channel=whatsapp`);
      return await attempt(waFrom, waTo);
    } catch (err) {
      console.error("[sendSMS confirm-checkout] whatsapp failed, falling back to SMS:", err);
    }
  }
  if (!TWILIO_FROM) throw new Error("No Twilio sender configured");
  const smsTo = to.startsWith("whatsapp:") ? to.replace("whatsapp:", "") : to;
  console.log(`[sendSMS confirm-checkout] transport=direct_twilio channel=sms`);
  return await attempt(TWILIO_FROM, smsTo);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { userId } = await req.json();
    if (!userId) {
      return new Response(JSON.stringify({ error: "userId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, first_name, phone, is_paid, email")
      .eq("id", userId)
      .single();

    if (userError || !user) {
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Already paid AND email present AND welcome already sent — nothing to do
    const { data: existingWelcome } = await supabase
      .from("check_ins")
      .select("id")
      .eq("user_id", user.id)
      .eq("type", "welcome")
      .limit(1)
      .maybeSingle();

    if (user.is_paid && user.email && existingWelcome) {
      return new Response(JSON.stringify({ success: true, already_complete: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify subscription exists in Stripe
    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    const searchResult = await stripe.customers.search({
      query: `metadata["phone"]:"${user.phone}"`,
      limit: 1,
    });

    if (searchResult.data.length === 0) {
      return new Response(JSON.stringify({ error: "No Stripe customer found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const customerId = searchResult.data[0].id;
    const subs = await stripe.subscriptions.list({
      customer: customerId,
      limit: 1,
    });

    if (subs.data.length === 0) {
      return new Response(JSON.stringify({ error: "No subscription found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Mark user as paid and capture email + name if missing
    const updatePayload: Record<string, unknown> = { is_paid: true };

    // Try to back-fill missing fields from Stripe customer + payment method.
    // The v2 onboarding doesn't ask for name/email — the payment form is the
    // first place we capture them, so we mirror them back to our DB and the
    // Stripe customer record (so admin views show a name instead of "—").
    const stripeCustomer = await stripe.customers.retrieve(searchResult.data[0].id) as Stripe.Customer;
    const sub = subs.data[0];
    let pmBillingDetails: Stripe.PaymentMethod["billing_details"] | null = null;
    if (sub?.default_payment_method) {
      try {
        const pm = await stripe.paymentMethods.retrieve(sub.default_payment_method as string);
        pmBillingDetails = pm.billing_details ?? null;
      } catch (pmErr) {
        console.error("Failed to retrieve payment method:", pmErr);
      }
    }

    if (!user.email) {
      const stripeEmail = stripeCustomer.email ?? pmBillingDetails?.email ?? null;
      if (stripeEmail) {
        updatePayload.email = stripeEmail;
      }
    }

    if (!user.first_name) {
      const fullName = stripeCustomer.name ?? pmBillingDetails?.name ?? null;
      if (fullName) {
        // Use just the first token as first_name (e.g. "Sarah Johnson" → "Sarah").
        // Stripe's billing_details.name is typically the cardholder's full name.
        const firstName = fullName.trim().split(/\s+/)[0] ?? "";
        if (firstName) {
          updatePayload.first_name = firstName;
        }
        // Mirror the full name back to the Stripe customer if it's missing there.
        // This makes the Stripe customer list show real names instead of blanks.
        if (!stripeCustomer.name) {
          try {
            await stripe.customers.update(stripeCustomer.id, { name: fullName });
          } catch (custErr) {
            console.error("Failed to update Stripe customer name:", custErr);
          }
        }
      }
    }
    await supabase.from("users").update(updatePayload).eq("id", user.id);

    // Send welcome SMS only if not already sent (idempotent across retries)
    if (!existingWelcome) {
      const nameGreeting = user.first_name ? ` ${user.first_name}` : "";
      const message = `Hi${nameGreeting}, it's grace. Expect daily check-ins, simple meal ideas, and a little encouragement when you need it most. You can always reply to our messages — we're here to listen and cheer you on. Save this number so you always know it's us. Reply STOP to cancel, HELP for help. Msg & data rates may apply.`;

      try {
        await sendSMS(user.phone, message);
        await supabase.from("check_ins").insert({
          user_id: user.id,
          type: "welcome",
          message_sent: message,
        });
        console.log(`Welcome message sent to ${user.first_name} (${user.phone})`);

        // Fire-and-forget: personalized follow-up
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
        fetch(`${supabaseUrl}/functions/v1/send-welcome-sms`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${anonKey}`,
          },
          body: JSON.stringify({ userId: user.id }),
        }).catch((err) => console.error("Follow-up trigger error:", err));
      } catch (smsErr) {
        console.error("Welcome SMS send error:", smsErr);
        // Return error so frontend can surface it / retry
        return new Response(
          JSON.stringify({ success: true, paid: true, welcome_sent: false, error: String(smsErr) }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    return new Response(JSON.stringify({ success: true, welcome_sent: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
