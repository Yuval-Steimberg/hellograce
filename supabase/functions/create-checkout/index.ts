import Stripe from "npm:stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Set STRIPE_BASE_PRICE_ID in Supabase secrets to swap test → live.
// Falls back to the test price for local/sandbox dev only.
const PRICE_ID = Deno.env.get("STRIPE_BASE_PRICE_ID") ?? "price_1TWgb5LMk6wjvxD9Y9azDUfZ";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { userId } = await req.json();
    if (!userId) {
      return new Response(JSON.stringify({ error: "userId is required" }), {
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
      .select("id, first_name, phone")
      .eq("id", userId)
      .single();

    if (userError || !user) {
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    // Find or create Stripe customer by phone
    let customerId: string | undefined;
    const searchResult = await stripe.customers.search({
      query: `metadata["phone"]:"${user.phone}"`,
      limit: 1,
    });

    if (searchResult.data.length > 0) {
      customerId = searchResult.data[0].id;

      // Check if already has an active/trialing subscription
      const existingSubs = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 10,
      });

      // Only treat as "already active" if there's a paid active sub with a payment method.
      // Trialing subs without a payment method are stale leftovers — cancel them so we can
      // create a fresh subscription that forces the user through the card form.
      for (const sub of existingSubs.data) {
        if (sub.status === "active" && sub.default_payment_method) {
          return new Response(
            JSON.stringify({ alreadyActive: true }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }

      // Cancel any incomplete OR trialing-without-payment subs so we can start fresh
      for (const sub of existingSubs.data) {
        if (
          sub.status === "incomplete" ||
          sub.status === "incomplete_expired" ||
          (sub.status === "trialing" && !sub.default_payment_method) ||
          (sub.status === "active" && !sub.default_payment_method)
        ) {
          try {
            await stripe.subscriptions.cancel(sub.id);
          } catch (e) {
            console.error("Failed to cancel stale sub", sub.id, e);
          }
        }
      }
    } else {
      const customer = await stripe.customers.create({
        name: user.first_name,
        phone: user.phone,
        metadata: { phone: user.phone, grace_user_id: user.id },
      });
      customerId = customer.id;
    }

    // Create subscription with trial — payment_behavior: default_incomplete
    // This returns a pending_setup_intent with client_secret for the frontend
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: PRICE_ID }],
      trial_period_days: 3,
      payment_behavior: "default_incomplete",
      payment_settings: {
        save_default_payment_method: "on_subscription",
        payment_method_types: ["card", "link"],
      },
      metadata: { grace_user_id: user.id },
      expand: ["pending_setup_intent"],
    });

    const setupIntent = subscription.pending_setup_intent as Stripe.SetupIntent;

    if (!setupIntent?.client_secret) {
      return new Response(
        JSON.stringify({ error: "Failed to create setup intent" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        clientSecret: setupIntent.client_secret,
        subscriptionId: subscription.id,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error creating checkout:", error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
