import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GATEWAY_URL = "https://connector-gateway.lovable.dev/resend";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { email, code } = await req.json();
    if (!email || !code) {
      return new Response(JSON.stringify({ error: "email and code required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");

    const response = await fetch(`${GATEWAY_URL}/emails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LOVABLE_API_KEY}`,
        "X-Connection-Api-Key": RESEND_API_KEY,
      },
      body: JSON.stringify({
        from: "grace <hello@info.graceglp.com>",
        to: [email],
        subject: "Your grace login code",
        html: `
          <div style="font-family: 'DM Sans', Arial, sans-serif; max-width: 400px; margin: 0 auto; padding: 40px 20px;">
            <h1 style="font-family: 'DM Serif Display', Georgia, serif; font-size: 28px; color: #3B1F1E; margin-bottom: 8px;">Your login code</h1>
            <p style="color: #6B5A59; font-size: 16px; margin-bottom: 32px;">Enter this code in grace to sign in:</p>
            <div style="background: #FFF5F0; border-radius: 16px; padding: 24px; text-align: center; margin-bottom: 32px;">
              <span style="font-family: 'DM Serif Display', Georgia, serif; font-size: 36px; letter-spacing: 0.3em; color: #3B1F1E;">${code}</span>
            </div>
            <p style="color: #A89490; font-size: 13px;">This code expires in 10 minutes. If you didn't request this, you can safely ignore it.</p>
          </div>
        `,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("Resend error:", data);
      throw new Error(`Resend API error [${response.status}]: ${JSON.stringify(data)}`);
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ error: "Failed to send email" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
