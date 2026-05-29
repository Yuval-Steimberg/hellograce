import Stripe from "npm:stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Specific error codes the frontend can interpret and show friendly toasts for.
type PortalErrorCode =
  | "missing_user_id"
  | "user_not_found"
  | "no_phone_on_user"
  | "no_stripe_customer"      // search returned 0 — eventual consistency OR no checkout completed
  | "portal_not_configured"   // Stripe dashboard: Customer portal not activated
  | "stripe_error"            // Other Stripe API error (returns the raw message too)
  | "internal_error";

function errorResponse(status: number, code: PortalErrorCode, message: string, extra?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ error: message, code, ...extra }),
    { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { userId } = await req.json();
    if (!userId) {
      return errorResponse(400, "missing_user_id", "userId is required");
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Pull phone AND id so we can fall back to grace_user_id search if the
    // phone-metadata index hasn't caught up yet (Stripe search is eventually
    // consistent, ~30-60s lag after customer creation).
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, phone")
      .eq("id", userId)
      .single();

    if (userError || !user) {
      console.error("[customer-portal] user lookup failed", { userId, err: userError?.message });
      return errorResponse(404, "user_not_found", "User not found");
    }

    if (!user.phone) {
      return errorResponse(400, "no_phone_on_user", "User has no phone number on record");
    }

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    // Try phone-metadata search first (covers users who subscribed > 1min ago).
    // If empty, fall back to grace_user_id-metadata search (set at customer
    // creation in create-checkout/confirm-checkout). Stripe's search indexes
    // BOTH metadata fields independently, so a hit on either confirms identity.
    let customerId: string | null = null;
    try {
      const byPhone = await stripe.customers.search({
        query: `metadata["phone"]:"${user.phone}"`,
        limit: 1,
      });
      if (byPhone.data.length > 0) {
        customerId = byPhone.data[0].id;
      } else {
        const byUserId = await stripe.customers.search({
          query: `metadata["grace_user_id"]:"${user.id}"`,
          limit: 1,
        });
        if (byUserId.data.length > 0) {
          customerId = byUserId.data[0].id;
        }
      }
    } catch (searchErr) {
      const msg = searchErr instanceof Error ? searchErr.message : String(searchErr);
      console.error("[customer-portal] stripe search failed", { phone: user.phone, msg });
      return errorResponse(500, "stripe_error", `Stripe search failed: ${msg}`);
    }

    if (!customerId) {
      console.warn("[customer-portal] no stripe customer found", { userId, phone: user.phone });
      return errorResponse(
        404,
        "no_stripe_customer",
        "We couldn't find your subscription yet. If you just subscribed, try again in 30 seconds.",
      );
    }

    const fallbackWebUrl = Deno.env.get("PUBLIC_WEB_URL") || "https://grace-admin-silk.vercel.app";
    const rawOrigin = req.headers.get("origin") || fallbackWebUrl;
    // graceglp.com apex 307-redirects to www and strips query params, breaking
    // Stripe's return_url session_id round-trip. Force the canonical Vercel URL
    // when the request came from the apex domain.
    const origin = /^https?:\/\/(www\.)?graceglp\.com/i.test(rawOrigin) ? fallbackWebUrl : rawOrigin;

    try {
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${origin}/settings`,
      });
      return new Response(
        JSON.stringify({ url: portalSession.url }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (portalErr) {
      const msg = portalErr instanceof Error ? portalErr.message : String(portalErr);
      console.error("[customer-portal] billing portal create failed", { customerId, msg });
      // Stripe returns this exact text when the customer portal isn't
      // activated in the dashboard. Most common cause for first-time setups.
      // Fix: https://dashboard.stripe.com/settings/billing/portal
      if (/configuration.*has not been (created|saved)|no configuration provided/i.test(msg)) {
        return errorResponse(
          500,
          "portal_not_configured",
          "Subscription manager isn't set up yet. Please contact support.",
          { dashboard_link: "https://dashboard.stripe.com/settings/billing/portal" },
        );
      }
      return errorResponse(500, "stripe_error", `Stripe portal create failed: ${msg}`);
    }
  } catch (error) {
    console.error("[customer-portal] unhandled error", error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    return errorResponse(500, "internal_error", msg);
  }
});
