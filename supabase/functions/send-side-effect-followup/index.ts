import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01/Accounts";

async function sendSMSOnly(to: string, body: string) {
  const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
  const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
  if (!TWILIO_ACCOUNT_SID) throw new Error("TWILIO_ACCOUNT_SID not configured");
  if (!TWILIO_AUTH_TOKEN) throw new Error("TWILIO_AUTH_TOKEN not configured");
  const TWILIO_WHATSAPP_FROM = Deno.env.get("TWILIO_WHATSAPP_FROM");
  const TWILIO_FROM_NUMBER = Deno.env.get("TWILIO_FROM_NUMBER");
  const useWhatsApp = !!TWILIO_WHATSAPP_FROM;
  let TWILIO_FROM = useWhatsApp ? TWILIO_WHATSAPP_FROM! : TWILIO_FROM_NUMBER!;
  if (!TWILIO_FROM) throw new Error("No Twilio sender configured");
  if (useWhatsApp && !TWILIO_FROM.startsWith("whatsapp:")) TWILIO_FROM = `whatsapp:${TWILIO_FROM}`;
  const toAddr = useWhatsApp && !to.startsWith("whatsapp:") ? `whatsapp:${to}` : to;

  const auth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const url = `${TWILIO_API_BASE}/${TWILIO_ACCOUNT_SID}/Messages.json`;
  console.log(`[sendSMSOnly] transport=direct_twilio channel=${useWhatsApp ? "whatsapp" : "sms"}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: toAddr, From: TWILIO_FROM, Body: body }),
  });
  const data = await response.json();
  if (!response.ok) {
    console.error(`[sendSMSOnly] failed status=${response.status} code=${data?.code} message=${data?.message}`);
    throw new Error(`Twilio error [${response.status}]: ${JSON.stringify(data)}`);
  }
  return data;
}

// ─── Food-aware nausea/constipation tips ─────────────────────────────

function nauseaTips(foodDislikes: string | null): string {
  const d = (foodDislikes || "").toLowerCase();
  const tips: string[] = [];
  if (!d.includes("ginger")) tips.push("ginger tea or ginger chews");
  if (!d.includes("cracker")) tips.push("plain crackers");
  if (!d.includes("broth") && !d.includes("soup")) tips.push("warm broth");
  tips.push("small sips of water");
  return tips.slice(0, 3).join(", ");
}

function constipationTips(foodDislikes: string | null): string {
  const d = (foodDislikes || "").toLowerCase();
  const tips: string[] = [];
  if (!d.includes("prune")) tips.push("prunes (3-4 per day)");
  if (!d.includes("apple")) tips.push("an apple with skin");
  if (!d.includes("oat")) tips.push("oatmeal");
  tips.push("extra water (aim for 80oz+)");
  return tips.slice(0, 3).join(", ");
}

// ─── Main ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const now = new Date();

    const { data: users, error } = await supabase
      .from("users")
      .select("id, first_name, phone, timezone, wake_time, medication, food_dislikes, side_effect_flow, side_effect_flow_started_at, side_effect_followup_sent, paused, active")
      .eq("active", true)
      .eq("paused", false)
      .eq("is_paid", true)
      .not("side_effect_flow", "is", null);

    if (error) {
      console.error("Fetch error:", error);
      return new Response(JSON.stringify({ error: "Failed to fetch" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let sent = 0, skipped = 0;

    for (const user of users || []) {
      try {
        const tz = user.timezone || "America/New_York";
        const localNow = new Date(now.toLocaleString("en-US", { timeZone: tz }));
        const localHour = localNow.getHours();

        // Quiet hours
        if (localHour >= 21 || localHour < 7) { skipped++; continue; }

        const flowStart = new Date(user.side_effect_flow_started_at);
        const hoursSinceStart = (now.getTime() - flowStart.getTime()) / (1000 * 60 * 60);

        if (user.side_effect_flow === "nausea") {
          // ── Nausea 4-hour check ──
          if (!user.side_effect_followup_sent && hoursSinceStart >= 4) {
            const { data: replies } = await supabase
              .from("check_ins")
              .select("id")
              .eq("user_id", user.id)
              .not("user_reply", "is", null)
              .gte("created_at", flowStart.toISOString())
              .limit(1);

            if (!replies || replies.length === 0) {
              const tips = nauseaTips(user.food_dislikes);
              const message = `Just checking in, ${user.first_name} — are you feeling any better? ${user.medication} nausea usually peaks and then fades. Try ${tips} if you haven't already. Still here for you 🧡`;
              await sendSMSOnly(user.phone, message);
              await supabase.from("check_ins").insert({
                user_id: user.id,
                type: "nausea_4hr_check",
                message_sent: message,
              });
            }

            await supabase.from("users").update({
              side_effect_followup_sent: true,
            }).eq("id", user.id);

            sent++;
            continue;
          }

          // ── Nausea next-morning follow-up ──
          if (user.side_effect_followup_sent && hoursSinceStart >= 12) {
            const [wakeH] = (user.wake_time || "07:00:00").split(":").map(Number);
            if (localHour >= wakeH && localHour <= wakeH + 2) {
              const message = `Morning ${user.first_name}! How's your stomach today? ${user.medication} nausea usually peaks about 24 hours after injection and then fades. Did it get better overnight? If it's still rough, try ${nauseaTips(user.food_dislikes)}.`;
              await sendSMSOnly(user.phone, message);
              await supabase.from("check_ins").insert({
                user_id: user.id,
                type: "nausea_morning_followup",
                message_sent: message,
              });

              await supabase.from("users").update({
                side_effect_flow: null,
                side_effect_flow_started_at: null,
                side_effect_followup_sent: false,
              }).eq("id", user.id);

              sent++;
              continue;
            }
          }
        }

        // Fatigue and constipation: auto-clear after 48 hours
        if (user.side_effect_flow === "constipation" && hoursSinceStart >= 24 && !user.side_effect_followup_sent) {
          const tips = constipationTips(user.food_dislikes);
          const message = `Hey ${user.first_name} — checking back on the constipation. It's really common on ${user.medication}. Here's what helps most people: ${tips}. How are things going?`;
          await sendSMSOnly(user.phone, message);
          await supabase.from("check_ins").insert({
            user_id: user.id,
            type: "constipation_followup",
            message_sent: message,
          });
          await supabase.from("users").update({ side_effect_followup_sent: true }).eq("id", user.id);
          sent++;
          continue;
        }

        if (user.side_effect_flow === "fatigue" && hoursSinceStart >= 24 && !user.side_effect_followup_sent) {
          const message = `Hey ${user.first_name} — how's your energy today? ${user.medication} fatigue usually improves after the first few weeks. Make sure you're eating enough (even small amounts) and staying hydrated — low calories + dehydration = double fatigue. How are you feeling?`;
          await sendSMSOnly(user.phone, message);
          await supabase.from("check_ins").insert({
            user_id: user.id,
            type: "fatigue_followup",
            message_sent: message,
          });
          await supabase.from("users").update({ side_effect_followup_sent: true }).eq("id", user.id);
          sent++;
          continue;
        }

        if (
          (user.side_effect_flow === "fatigue" || user.side_effect_flow === "constipation") &&
          hoursSinceStart >= 48
        ) {
          await supabase.from("users").update({
            side_effect_flow: null,
            side_effect_flow_started_at: null,
            side_effect_followup_sent: false,
          }).eq("id", user.id);
          skipped++;
          continue;
        }

        skipped++;
      } catch (err) {
        console.error(`Error for user ${user.id}:`, err);
      }
    }

    return new Response(
      JSON.stringify({ success: true, sent, skipped, total: (users || []).length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
