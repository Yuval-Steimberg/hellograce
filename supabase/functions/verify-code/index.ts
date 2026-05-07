import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function normalizePhone(phone: string): string {
  const digits = phone.trim().replace(/\D/g, "");
  if (!digits) return phone.trim();
  const withPlus = `+${digits}`;
  return withPlus.replace(
    /^(\+1|\+7|\+2[0-9]|\+3[0-9]{1,2}|\+4[0-9]{1,2}|\+5[0-9]{1,2}|\+6[0-9]{1,2}|\+8[0-9]{1,2}|\+9[0-9]{1,2})0+/,
    "$1"
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { phone, email, code } = body;

    if (!code || code.length !== 6) {
      return new Response(JSON.stringify({ error: "6-digit code required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!phone && !email) {
      return new Response(JSON.stringify({ error: "Phone or email required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const method = email ? "email" : "phone";
    let lookupKey: string;

    if (method === "phone") {
      lookupKey = normalizePhone(phone);
    } else {
      lookupKey = email.trim().toLowerCase();
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Find valid, unused code — verification_codes.phone stores the identifier (phone or email)
    const { data: verification } = await supabase
      .from("verification_codes")
      .select("*")
      .eq("phone", lookupKey)
      .eq("code", code)
      .eq("used", false)
      .gte("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!verification) {
      return new Response(JSON.stringify({ error: "Invalid or expired code" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Mark code as used
    await supabase
      .from("verification_codes")
      .update({ used: true })
      .eq("id", verification.id);

    // Load user data
    let user;
    if (method === "phone") {
      const { data, error } = await supabase
        .from("users")
        .select("*")
        .eq("phone", lookupKey)
        .maybeSingle();
      if (error || !data) {
        return new Response(JSON.stringify({ error: "User not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      user = data;
    } else {
      const { data, error } = await supabase
        .from("users")
        .select("*")
        .eq("email", lookupKey)
        .maybeSingle();
      if (error || !data) {
        return new Response(JSON.stringify({ error: "User not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      user = data;
    }

    return new Response(JSON.stringify({ success: true, user }), {
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
