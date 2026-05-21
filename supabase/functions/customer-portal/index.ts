import Stripe from "npm:stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

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
      .select("phone")
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

    const searchResult = await stripe.customers.search({
      query: `metadata["phone"]:"${user.phone}"`,
      limit: 1,
    });

    if (searchResult.data.length === 0) {
      return new Response(JSON.stringify({ error: "No subscription found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const fallbackWebUrl = Deno.env.get("PUBLIC_WEB_URL") || "https://grace-admin-silk.vercel.app";
    const rawOrigin = req.headers.get("origin") || fallbackWebUrl;
    // graceglp.com apex 307-redirects to www and strips query params, breaking
    // Stripe's return_url session_id round-trip. Force the canonical Vercel URL
    // when the request came from the apex domain.
    const origin = /^https?:\/\/(www\.)?graceglp\.com/i.test(rawOrigin) ? fallbackWebUrl : rawOrigin;

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: searchResult.data[0].id,
      return_url: `${origin}/settings`,
    });

    return new Response(JSON.stringify({ url: portalSession.url }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error creating portal session:", error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
