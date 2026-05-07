import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01/Accounts";

async function sendSMS(to: string, body: string) {
  const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
  const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
  if (!TWILIO_ACCOUNT_SID) throw new Error("TWILIO_ACCOUNT_SID is not configured");
  if (!TWILIO_AUTH_TOKEN) throw new Error("TWILIO_AUTH_TOKEN is not configured");

  const TWILIO_WHATSAPP_FROM = Deno.env.get("TWILIO_WHATSAPP_FROM");
  const TWILIO_FROM = Deno.env.get("TWILIO_FROM_NUMBER");

  const auth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const url = `${TWILIO_API_BASE}/${TWILIO_ACCOUNT_SID}/Messages.json`;

  async function attempt(fromAddr: string, toAddr: string) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: toAddr, From: fromAddr, Body: body }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error(`[sendSMS welcome-followup] failed status=${response.status} code=${data?.code} message=${data?.message}`);
      throw new Error(`Twilio API error [${response.status}]: ${JSON.stringify(data)}`);
    }
    return data;
  }

  if (TWILIO_WHATSAPP_FROM) {
    let waFrom = TWILIO_WHATSAPP_FROM;
    if (!waFrom.startsWith("whatsapp:")) waFrom = `whatsapp:${waFrom}`;
    const waTo = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
    try {
      console.log(`[sendSMS welcome-followup] transport=direct_twilio channel=whatsapp`);
      return await attempt(waFrom, waTo);
    } catch (err) {
      console.error("[sendSMS welcome-followup] whatsapp failed, falling back to SMS:", err);
    }
  }
  if (!TWILIO_FROM) throw new Error("No Twilio sender configured (TWILIO_WHATSAPP_FROM or TWILIO_FROM_NUMBER)");
  const smsTo = to.startsWith("whatsapp:") ? to.replace("whatsapp:", "") : to;
  console.log(`[sendSMS welcome-followup] transport=direct_twilio channel=sms`);
  return await attempt(TWILIO_FROM, smsTo);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildFollowUp(name: string, goals: string[], medication: string, injectionDay: string, wakeTime: string, foodDislikes: string | null): string {
  // Lead with something specific to their #1 goal
  let goalLead = "";
  if (goals.includes("Losing weight")) {
    goalLead = `You told me losing weight matters to you — so I'll keep an eye on your protein, hydration, and how ${medication} is working for you.`;
  } else if (goals.includes("Eating enough protein")) {
    goalLead = `Protein is your priority — I'll track that with you and suggest easy wins that actually fit your life.`;
  } else if (goals.includes("Managing side effects")) {
    goalLead = `I know ${medication} side effects can be unpredictable — I'll check in regularly and share what actually helps other people.`;
  } else if (goals.includes("Staying hydrated")) {
    goalLead = `Hydration is your focus — I'll nudge you throughout the day so it becomes second nature.`;
  } else if (goals.includes("Feeling less alone in this")) {
    goalLead = `You said you don't want to feel alone in this — and you won't. I'm here every day, and I actually care how you're doing.`;
  } else if (goals.includes("Building better habits")) {
    goalLead = `Building habits is all about small wins — I'll help you stack them up, one day at a time.`;
  } else if (goals.includes("Hitting my fiber goals")) {
    goalLead = `Fiber goals noted! I'll send practical ideas that fit what you actually like to eat.`;
  } else {
    goalLead = `I've got your goals noted — and I'll tailor everything I send to what matters most to you.`;
  }

  // Add food awareness if they shared dislikes — clean up raw user input
  const cleanFoodDislike = (raw: string): string => {
    let s = raw.split(",")[0].trim().toLowerCase();
    // Strip common leading phrases users type
    s = s.replace(/^(i\s+)?(really\s+|absolutely\s+)?(hate|don't like|do not like|dislike|can't stand|cannot stand|won't eat|will not eat|avoid)\s+/i, "");
    s = s.replace(/^i'?m\s+(a\s+)?(vegetarian|vegan|pescatarian)\s*\.?$/i, "$2 food");
    s = s.replace(/[.!?]+$/g, "").trim();
    return s;
  };
  const cleanedDislike = foodDislikes ? cleanFoodDislike(foodDislikes) : "";
  const foodNote = cleanedDislike
    ? ` (And don't worry — I remember you're not a fan of ${cleanedDislike}, so I won't suggest that.)`
    : "";

  // Parse wake time for the morning mention
  const [h] = (wakeTime || "07:00:00").split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  const displayHour = h > 12 ? h - 12 : h === 0 ? 12 : h;
  const wakeNote = `Your first check-in arrives tomorrow around ${displayHour}:${String((h * 60 + 45) % 60).padStart(2, "0")}${ampm}`;

  return `${name ? name + ", " : ""}${goalLead}${foodNote} ${wakeNote} — and I'll be here throughout the day after that. You're not doing this alone anymore${name ? ", " + name : ""}. I'm with you the whole way.`;
}

// This function is called fire-and-forget from complete-onboarding.
// It waits a few seconds, then sends the personalized follow-up SMS.
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
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: user, error } = await supabase
      .from("users")
      .select("first_name, phone, goals, medication, injection_day, wake_time, food_dislikes")
      .eq("id", userId)
      .maybeSingle();

    if (error || !user) {
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Wait before sending follow-up so user gets it as a separate message
    await sleep(8000);

    const followUp = buildFollowUp(
      user.first_name,
      user.goals || [],
      user.medication,
      user.injection_day,
      user.wake_time,
      user.food_dislikes,
    );

    await sendSMS(user.phone, followUp);

    await supabase.from("check_ins").insert({
      user_id: userId,
      type: "welcome_followup",
      message_sent: followUp,
    });

    console.log(`Welcome follow-up sent to ${user.first_name}`);

    return new Response(JSON.stringify({ success: true }), {
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
