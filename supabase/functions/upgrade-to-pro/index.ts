import Stripe from "npm:stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const BASE_PRICE_ID = "price_1TWgb5LMk6wjvxD9Y9azDUfZ";
const PRO_PRICE_ID = "price_1TLla9E0DcWyPH4XZnep2X7G";

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
      .select("id, phone, first_name")
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

    // Find customer by phone
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

    // Find active/trialing subscription
    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 10,
    });

    const activeSub = subs.data.find(
      (s: any) => s.status === "active" || s.status === "trialing"
    );

    if (!activeSub) {
      return new Response(JSON.stringify({ error: "No active subscription found" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if already Pro
    const currentPriceId = activeSub.items.data[0]?.price?.id;
    if (currentPriceId === PRO_PRICE_ID) {
      return new Response(JSON.stringify({ alreadyPro: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Upgrade: swap the subscription item from base to pro
    await stripe.subscriptions.update(activeSub.id, {
      items: [
        {
          id: activeSub.items.data[0].id,
          price: PRO_PRICE_ID,
        },
      ],
      proration_behavior: "create_prorations",
    });

    // Update user in DB
    await supabase
      .from("users")
      .update({ is_pro: true })
      .eq("id", userId);

    return new Response(
      JSON.stringify({ success: true, message: "Upgraded to Pro!" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error upgrading:", error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
