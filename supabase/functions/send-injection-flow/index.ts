import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01/Accounts";

// ─── Message templates ──────────────────────────────────────────────

function injectionMorning(name: string, medication: string, injectionCount: number, foodDislikes: string | null): string {
  const prepTip = buildPrepTip(foodDislikes);
  if (injectionCount === 0) {
    return `Today's your first ${medication} injection day, ${name}! Rotate your injection site — stomach and thigh are the most common spots. ${prepTip}Take your time, and reply 'done' when you've injected 💉`;
  }
  if (injectionCount < 4) {
    return `It's ${medication} day, ${name}! Injection #${injectionCount + 1} — you know the drill. Rotate your site if you can (different spot than last time). ${prepTip}Reply 'done' when you've injected 💉`;
  }
  return `${medication} day, ${name}! Injection #${injectionCount + 1}. You're a pro at this now. Rotate your site and reply 'done' when you're good 💉`;
}

function buildPrepTip(foodDislikes: string | null): string {
  const dislikes = (foodDislikes || "").toLowerCase();
  const tips: string[] = [];
  if (!dislikes.includes("ginger")) tips.push("ginger tea");
  if (!dislikes.includes("cracker")) tips.push("plain crackers");
  tips.push("electrolytes");
  return `Have ${tips.join(", ")} ready just in case. `;
}

function postInjectionFollowup(name: string, medication: string): string {
  return `How are you feeling, ${name}? Some people feel totally normal after ${medication}, some get a little nauseous or tired — both are normal. What's going on for you right now?`;
}

function dayAfterFine(name: string, medication: string): string {
  return `Morning after ${medication} day! How are you feeling today, ${name}? Sometimes the second day is actually tougher than the first. Just checking in 🧡`;
}

function dayAfterNausea(name: string, medication: string, foodDislikes: string | null): string {
  const dislikes = (foodDislikes || "").toLowerCase();
  let tip = "Even a few crackers counts.";
  if (!dislikes.includes("broth") && !dislikes.includes("soup")) {
    tip = "Bone broth, crackers, or anything gentle on the stomach.";
  }
  return `Morning ${name} — how's your stomach today? Yesterday sounded rough after your ${medication}. Have you been able to eat anything? ${tip} I'm here if you need tips.`;
}

function dayAfterNoReply(name: string, medication: string): string {
  return `Hey ${name}! Checking in after your ${medication} injection yesterday. How did it go? Any side effects or totally smooth? I want to keep track of how you do each week.`;
}

function patternInsight(name: string, pattern: string, medication: string): string {
  return `By the way ${name} — I've been tracking your ${medication} injection days. You seem to ${pattern}. Does that match what you're noticing? Useful to know as you plan your weeks.`;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function getDayOfWeek(date: Date): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getDay()];
}

function sameLocalDate(d1: Date, d2: Date, tz: string): boolean {
  const a = new Date(d1.toLocaleString("en-US", { timeZone: tz }));
  const b = new Date(d2.toLocaleString("en-US", { timeZone: tz }));
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function localDateOffset(date: Date, tz: string, offsetDays: number): Date {
  const local = new Date(date.toLocaleString("en-US", { timeZone: tz }));
  local.setDate(local.getDate() + offsetDays);
  return local;
}

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

// ─── Pattern analysis ────────────────────────────────────────────────

async function analyzeInjectionPattern(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<string | null> {
  const { data: checkins } = await supabase
    .from("check_ins")
    .select("type, user_reply, mood_score, created_at")
    .eq("user_id", userId)
    .in("type", [
      "injection_followup_reply",
      "injection_dayafter_reply",
      "nausea_reply",
      "fatigue_reply",
    ])
    .order("created_at", { ascending: false })
    .limit(20);

  if (!checkins || checkins.length < 3) return null;

  const replies = checkins.map((c: any) => (c.user_reply || "").toLowerCase());
  const nauseaCount = replies.filter((r) =>
    ["nauseous", "nausea", "sick", "queasy"].some((k) => r.includes(k))
  ).length;
  const fineCount = replies.filter((r) =>
    ["fine", "good", "great", "normal", "okay"].some((k) => r.includes(k))
  ).length;
  const tiredCount = replies.filter((r) =>
    ["tired", "exhausted", "fatigue"].some((k) => r.includes(k))
  ).length;

  if (nauseaCount >= 2 && nauseaCount > fineCount) {
    return "usually feel nauseous for about 24 hours after your injection";
  }
  if (tiredCount >= 2 && tiredCount > fineCount) {
    return "tend to feel more tired on injection day but bounce back by day 2";
  }
  if (fineCount >= 3) {
    return "tolerate your injections really well — that's great and tends to stay consistent";
  }

  return "have a mixed pattern — some weeks are easier than others, which is really normal";
}

// ─── Main handler ────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const now = new Date();

    const { data: users, error } = await supabase
      .from("users")
      .select(
        "id, first_name, phone, wake_time, timezone, injection_day, injection_flow_stage, injection_flow_started_at, injection_done_at, injection_count, paused, active, injection_side_effect_free, medication, food_dislikes, is_paid, is_pro, trial_start, grace_notes",
      )
      .eq("active", true)
      .eq("paused", false);

    if (error) {
      console.error("Fetch error:", error);
      return new Response(JSON.stringify({ error: "Failed to fetch users" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let sent = 0;
    let skipped = 0;

    for (const user of users || []) {
      try {
        const tz = user.timezone || "America/New_York";
        const localNow = new Date(now.toLocaleString("en-US", { timeZone: tz }));
        const localHour = localNow.getHours();
        const localDayName = getDayOfWeek(localNow);

        // Quiet hours
        if (localHour >= 21 || localHour < 7) {
          skipped++;
          continue;
        }

        // Free-trial expired (>3 days, not paid, not pro): skip entirely
        const trialStart = user.trial_start ? new Date(user.trial_start) : now;
        const daysSinceTrial = (now.getTime() - trialStart.getTime()) / (1000 * 60 * 60 * 24);
        if (!user.is_paid && !user.is_pro && daysSinceTrial > 3) {
          skipped++;
          continue;
        }

        const isInjectionDay = localDayName === user.injection_day;
        const stage = user.injection_flow_stage;

        // ── STAGE 0: Injection morning (8am on shot day) ──────────
        if (isInjectionDay && !stage) {
          if (localHour !== 8) {
            skipped++;
            continue;
          }

          const message = injectionMorning(user.first_name, user.medication, user.injection_count, user.food_dislikes);
          await sendSMSOnly(user.phone, message);

          await supabase.from("check_ins").insert({
            user_id: user.id,
            type: "injection_morning",
            message_sent: message,
          });

          await supabase
            .from("users")
            .update({
              injection_flow_stage: "morning_sent",
              injection_flow_started_at: now.toISOString(),
              last_morning_sent_at: now.toISOString(),
            })
            .eq("id", user.id);

          sent++;
          console.log(`Injection morning sent to ${user.first_name} (${user.medication} #${user.injection_count + 1})`);
          continue;
        }

        // ── STAGE 1: Post-injection follow-up (3h after morning or 'done') ──
        if (stage === "morning_sent" || stage === "done_confirmed") {
          if (user.injection_side_effect_free && stage === "done_confirmed") {
            await supabase
              .from("users")
              .update({
                injection_flow_stage: "followup_sent",
                injection_evening_followup_due: true,
              })
              .eq("id", user.id);
            skipped++;
            continue;
          }

          const referenceTime = stage === "done_confirmed" && user.injection_done_at
            ? new Date(user.injection_done_at)
            : new Date(user.injection_flow_started_at);

          const hoursSince = (now.getTime() - referenceTime.getTime()) / (1000 * 60 * 60);

          if (hoursSince >= 3) {
            const message = postInjectionFollowup(user.first_name, user.medication);
            await sendSMSOnly(user.phone, message);

            await supabase.from("check_ins").insert({
              user_id: user.id,
              type: "injection_followup",
              message_sent: message,
            });

            await supabase
              .from("users")
              .update({
                injection_flow_stage: "followup_sent",
                injection_evening_followup_due: true,
              })
              .eq("id", user.id);

            sent++;
          } else {
            skipped++;
          }
          continue;
        }

        // ── STAGE 2: Day-after check-in (next morning, wake + 45min) ──
        if (stage === "followup_sent") {
          const yesterday = localDateOffset(now, tz, -1);
          const yesterdayName = getDayOfWeek(yesterday);

          if (yesterdayName !== user.injection_day) {
            skipped++;
            continue;
          }

          const [wakeH, wakeM] = (user.wake_time || "07:00:00").split(":").map(Number);
          const targetMin = wakeH * 60 + wakeM + 45;
          const currentMin = localHour * 60 + localNow.getMinutes();

          if (currentMin < targetMin || currentMin > targetMin + 15) {
            skipped++;
            continue;
          }

          // Determine which day-after variant based on their followup reply
          const { data: lastReply } = await supabase
            .from("check_ins")
            .select("user_reply")
            .eq("user_id", user.id)
            .eq("type", "injection_followup_reply")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          let message: string;
          const replyText = (lastReply?.user_reply || "").toLowerCase();

          if (!lastReply?.user_reply) {
            message = dayAfterNoReply(user.first_name, user.medication);
          } else if (
            ["nauseous", "nausea", "sick", "queasy"].some((k) => replyText.includes(k))
          ) {
            message = dayAfterNausea(user.first_name, user.medication, user.food_dislikes);
          } else {
            message = dayAfterFine(user.first_name, user.medication);
          }

          // Pattern insight at 4th+ injection
          const newCount = user.injection_count + 1;
          if (newCount >= 4) {
            const pattern = await analyzeInjectionPattern(supabase as any, user.id);
            if (pattern) {
              message += "\n\n" + patternInsight(user.first_name, pattern, user.medication);
            }
          }

          await sendSMSOnly(user.phone, message);

          await supabase.from("check_ins").insert({
            user_id: user.id,
            type: "injection_dayafter",
            message_sent: message,
          });

          await supabase
            .from("users")
            .update({
              injection_flow_stage: null,
              injection_flow_started_at: null,
              injection_done_at: null,
              injection_count: newCount,
              last_morning_sent_at: now.toISOString(),
            })
            .eq("id", user.id);

          await supabase.from("injections").insert({
            user_id: user.id,
            confirmed_at: user.injection_done_at || null,
          });

          sent++;
          console.log(`Injection day-after sent to ${user.first_name} (${user.medication} #${newCount})`);
          continue;
        }
      } catch (userErr) {
        console.error(`Error for user ${user.id}:`, userErr);
      }
    }

    return new Response(
      JSON.stringify({ success: true, sent, skipped, total: (users || []).length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
