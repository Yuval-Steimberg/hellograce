import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01/Accounts";
const RESEND_GATEWAY_URL = "https://connector-gateway.lovable.dev/resend";

async function sendSMS(to: string, body: string) {
  const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
  const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
  if (!TWILIO_ACCOUNT_SID) throw new Error("TWILIO_ACCOUNT_SID is not configured");
  if (!TWILIO_AUTH_TOKEN) throw new Error("TWILIO_AUTH_TOKEN is not configured");
  const waRaw = Deno.env.get("TWILIO_WHATSAPP_FROM");
  const smsRaw = Deno.env.get("TWILIO_FROM_NUMBER");
  // In testing mode we always prefer WhatsApp. Auto-prefix `whatsapp:` if missing.
  let TWILIO_FROM: string | undefined;
  let isWa = false;
  if (waRaw) {
    TWILIO_FROM = waRaw.startsWith("whatsapp:") ? waRaw : `whatsapp:${waRaw}`;
    isWa = true;
  } else if (smsRaw) {
    TWILIO_FROM = smsRaw;
    isWa = false;
  }
  if (!TWILIO_FROM) throw new Error("No Twilio sender configured");
  const toAddr = isWa && !to.startsWith("whatsapp:") ? `whatsapp:${to}` : to;

  const auth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const url = `${TWILIO_API_BASE}/${TWILIO_ACCOUNT_SID}/Messages.json`;
  console.log(`[sendSMS verification] transport=direct_twilio channel=${isWa ? "whatsapp" : "sms"}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: toAddr, From: TWILIO_FROM, Body: body }),
  });
  const data = await response.json();
  if (!response.ok) {
    console.error(`[sendSMS verification] failed status=${response.status} code=${data?.code} message=${data?.message}`);
    throw new Error(`Twilio error [${response.status}]: ${JSON.stringify(data)}`);
  }
  return data;
}

async function sendEmailCode(to: string, code: string) {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");

  const response = await fetch(`${RESEND_GATEWAY_URL}/emails`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LOVABLE_API_KEY}`,
      "X-Connection-Api-Key": RESEND_API_KEY,
    },
    body: JSON.stringify({
      from: "grace <hello@info.graceglp.com>",
      to: [to],
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
  if (!response.ok) throw new Error(`Resend error [${response.status}]: ${JSON.stringify(data)}`);
  return data;
}

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
    const { phone, email } = body;
    const method = email ? "email" : "phone";

    if (method === "phone") {
      if (!phone || typeof phone !== "string" || phone.trim().length < 10) {
        return new Response(JSON.stringify({ error: "Valid phone number required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } else {
      if (!email || typeof email !== "string" || !email.includes("@")) {
        return new Response(JSON.stringify({ error: "Valid email required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    let user;
    let lookupKey: string;

    if (method === "phone") {
      lookupKey = normalizePhone(phone);
      const { data } = await supabase.from("users").select("id").eq("phone", lookupKey).maybeSingle();
      user = data;
    } else {
      lookupKey = email.trim().toLowerCase();
      const { data } = await supabase.from("users").select("id").eq("email", lookupKey).maybeSingle();
      user = data;
    }

    if (!user) {
      const errorMsg = method === "phone"
        ? "No account found with this phone number"
        : "No account found with this email";
      return new Response(JSON.stringify({ error: errorMsg }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));

    // Mark old codes as used
    await supabase.from("verification_codes").update({ used: true }).eq("phone", lookupKey).eq("used", false);

    // Insert new code (phone column stores the identifier — phone or email)
    await supabase.from("verification_codes").insert({ phone: lookupKey, code });

    if (method === "phone") {
      await sendSMS(lookupKey, `Your grace verification code is: ${code}`);
    } else {
      await sendEmailCode(lookupKey, code);
    }

    return new Response(JSON.stringify({ success: true, method }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
