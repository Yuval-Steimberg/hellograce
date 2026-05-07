import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01/Accounts";

const BodySchema = z.object({
  firstName: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(8).max(30),
  medication: z.string().trim().min(1).max(120),
  medicationFrequency: z.string().trim().min(1).max(30).optional().nullable(),
  injectionDay: z.string().trim().max(20).optional().nullable(),
  medicationTime: z.string().trim().max(30).optional().nullable(),
  wakeTime: z.string().regex(/^\d{2}:\d{2}$/),
  sleepTime: z.string().regex(/^\d{2}:\d{2}$/),
  foodDislikes: z.string().max(1000).optional().nullable(),
  currentWeight: z.number().finite().positive().optional().nullable(),
  goalWeight: z.number().finite().positive().optional().nullable(),
  goals: z.array(z.string().trim().min(1).max(120)).max(10),
  timezone: z.string().trim().min(1).max(100).optional(),
  checkinCountPerDay: z.number().int().min(1).max(5).optional().nullable(),
  checkinDaysInterval: z.number().int().min(1).max(14).optional().nullable(),
});

function normalizePhone(phone: string) {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");

  if (!digits) return trimmed;

  // Build E.164: +<country><subscriber>
  // Remove leading zero from subscriber part for common country codes
  // e.g. +972 0542405300 → +972542405300
  const withPlus = `+${digits}`;

  // Match known country code patterns and strip the leading 0 after them
  const fixed = withPlus.replace(
    /^(\+1|\+7|\+2[0-9]|\+3[0-9]{1,2}|\+4[0-9]{1,2}|\+5[0-9]{1,2}|\+6[0-9]{1,2}|\+8[0-9]{1,2}|\+9[0-9]{1,2})0+/,
    "$1"
  );

  return fixed;
}

async function sendSMS(to: string, body: string) {
  const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
  const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
  const TWILIO_FROM = Deno.env.get("TWILIO_WHATSAPP_FROM") || Deno.env.get("TWILIO_FROM_NUMBER");

  if (!TWILIO_ACCOUNT_SID) throw new Error("TWILIO_ACCOUNT_SID is not configured");
  if (!TWILIO_AUTH_TOKEN) throw new Error("TWILIO_AUTH_TOKEN is not configured");
  if (!TWILIO_FROM) throw new Error("No Twilio sender configured");
  const isWa = TWILIO_FROM.startsWith("whatsapp:");
  const toAddr = isWa && !to.startsWith("whatsapp:") ? `whatsapp:${to}` : to;

  const auth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const url = `${TWILIO_API_BASE}/${TWILIO_ACCOUNT_SID}/Messages.json`;
  console.log(`[sendSMS complete-onboarding] transport=direct_twilio channel=${isWa ? "whatsapp" : "sms"}`);

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
    console.error(`[sendSMS complete-onboarding] failed status=${response.status} code=${data?.code} message=${data?.message}`);
    throw new Error(`Twilio API error [${response.status}]: ${JSON.stringify(data)}`);
  }

  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const parsed = BodySchema.safeParse(await req.json());

    if (!parsed.success) {
      return new Response(JSON.stringify({ error: parsed.error.flatten() }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const {
      firstName,
      phone,
      medication,
      medicationFrequency,
      injectionDay,
      medicationTime,
      wakeTime,
      sleepTime,
      foodDislikes,
      currentWeight,
      goalWeight,
      goals,
      timezone,
      checkinCountPerDay,
      checkinDaysInterval,
    } = parsed.data;

    const normalizedPhone = normalizePhone(phone);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const userPayload: Record<string, unknown> = {
      auth_user_id: null,
      first_name: firstName,
      phone: normalizedPhone,
      medication,
      medication_frequency: medicationFrequency || "weekly",
      injection_day: injectionDay || "",
      medication_time: medicationTime || null,
      wake_time: `${wakeTime}:00`,
      sleep_time: `${sleepTime}:00`,
      food_dislikes: foodDislikes?.trim() || null,
      current_weight: currentWeight ?? null,
      goal_weight: goalWeight ?? null,
      goals,
      checkin_count_per_day: checkinCountPerDay || 2,
      checkin_days_interval: checkinDaysInterval || 1,
    };
    if (timezone) userPayload.timezone = timezone;

    const { data: existingUser, error: existingUserError } = await supabase
      .from("users")
      .select("id")
      .eq("phone", normalizedPhone)
      .maybeSingle();

    if (existingUserError) {
      console.error("Lookup error:", existingUserError);
      return new Response(JSON.stringify({ error: "Failed to save onboarding" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userQuery = existingUser
      ? supabase.from("users").update(userPayload).eq("id", existingUser.id)
      : supabase.from("users").insert(userPayload);

    const { data: savedUser, error: saveError } = await userQuery
      .select("id, first_name, phone")
      .single();

    if (saveError || !savedUser) {
      console.error("Save error:", saveError);
      return new Response(JSON.stringify({ error: "Failed to save onboarding" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: existingWelcome } = await supabase
      .from("check_ins")
      .select("id")
      .eq("user_id", savedUser.id)
      .eq("type", "welcome")
      .limit(1)
      .maybeSingle();

    if (!existingWelcome) {
      try {
        const welcomeMsg =
          `Hi ${firstName}, it's grace. Expect daily ` +
          `check-ins, simple meal ideas, and a little ` +
          `encouragement when you need it most. ` +
          `Reply anytime — I'm here. Reply STOP to ` +
          `cancel, HELP for help. Msg & data rates ` +
          `may apply.`;

        await sendSMS(normalizedPhone, welcomeMsg);

        await supabase.from("check_ins").insert({
          user_id: savedUser.id,
          type: "welcome",
          message_sent: welcomeMsg,
        });

        // Fire personalized follow-up after 8 seconds
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const serviceKey =
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        fetch(
          `${supabaseUrl}/functions/v1/send-welcome-sms`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${serviceKey}`,
            },
            body: JSON.stringify({ userId: savedUser.id }),
          }
        ).catch(err =>
          console.error("Follow-up trigger error:", err)
        );

        console.log(
          `Welcome SMS sent to ${firstName} (${normalizedPhone})`
        );
      } catch (smsErr) {
        console.error("Welcome SMS error:", smsErr);
      }
    }

    return new Response(JSON.stringify({ success: true, userId: savedUser.id }), {
      status: 200,
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
