import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01/Accounts";
const MAX_DAILY_MESSAGES_BASE = 10;

// ─── Weight-aware message builders ──────────────────────────────────

function buildReflection(name: string, currentWeight: number | null, goalWeight: number | null, medication: string): string {
  if (currentWeight && goalWeight && currentWeight > goalWeight) {
    const toGo = Math.round(currentWeight - goalWeight);
    const variants = [
      `Before you wind down — how did today go? You don't have to give me a report. Even just one word: hard, okay, good, great.`,
      `Evening check-in! One thing: what went right today? Doesn't have to be ${medication}-related. Anything counts.`,
      `Hey ${name} — end of day check. You're working toward a ${toGo}lb goal on ${medication}. Even on tough days, you're still showing up. How was today?`,
    ];
    return pickVariant(variants, name);
  }

  const variants = [
    `Before you wind down — how did today go? You don't have to give me a report. Even just one word: hard, okay, good, great.`,
    `Evening check-in! One thing: what went right today? Doesn't have to be ${medication}-related. Anything counts.`,
    `Hey ${name} — end of day check. If you had to grade today, what would you give it? A, B, C, or 'let's not talk about it' 😄`,
  ];
  return pickVariant(variants, name);
}

function buildEncouragement(name: string, medication: string): string {
  return `Hey ${name} — I've been thinking about you. How are you doing tonight? Some days on this ${medication} journey are just hard. That's real and it's allowed. 🧡`;
}

function buildPractical(foodDislikes: string | null): string {
  const dislikes = (foodDislikes || "").toLowerCase();

  // Build food-aware prep suggestions
  const suggestions: string[] = [];
  if (!dislikes.includes("yogurt") && !dislikes.includes("dairy")) suggestions.push("Greek yogurt in the fridge");
  if (!dislikes.includes("egg")) suggestions.push("hard boiled eggs ready");
  if (!dislikes.includes("shake") && !dislikes.includes("protein")) suggestions.push("a protein shake on the counter");
  if (dislikes.includes("dairy") || dislikes.includes("vegetarian") || dislikes.includes("vegan")) {
    suggestions.push("chia pudding in the fridge");
    suggestions.push("overnight oats prepped");
  }

  const prepList = suggestions.slice(0, 2).join(", ");

  const variants = [
    `Tonight prep: if you have protein prepped for tomorrow morning, tomorrow will be easier. ${prepList}. Takes 2 minutes. Worth it?`,
    `Quick water check before bed: have you hit 64oz today? No? There's still time — and it helps with tomorrow's hunger levels too.`,
  ];
  return pickVariant(variants, "practical");
}

// ─── Helpers ─────────────────────────────────────────────────────────

function getDayOfWeek(date: Date): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getDay()];
}

function pickVariant(variants: string[], seed: string): string {
  const week = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  const hash = seed.charCodeAt(0) + (seed.length > 1 ? seed.charCodeAt(seed.length - 1) : 0);
  return variants[(week + hash) % variants.length];
}

function sameLocalDate(d1: Date, tz: string, d2: Date): boolean {
  const a = new Date(d1.toLocaleString("en-US", { timeZone: tz }));
  const b = new Date(d2.toLocaleString("en-US", { timeZone: tz }));
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function getLocalDate(now: Date, tz: string): string {
  const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
}

// Fallback wrapper to match aiProactiveMessage signature
function buildMessage(
  mode: string,
  name: string,
  medication: string,
  _historyCtx: string | null,
  user?: any,
): string {
  if (mode === "encouragement") return buildEncouragement(name, medication);
  if (mode === "practical") return buildPractical(user?.food_dislikes ?? null);
  return buildReflection(name, user?.current_weight ?? null, user?.goal_weight ?? null, medication);
}

async function aiProactiveMessage(
  mode: string,
  user: any,
  historyCtx: string | null,
  lovableApiKey: string,
): Promise<string> {
  const modeInstructions: Record<string, string> = {
    reflection: "End-of-day reflection. Ask how today went in one word or short reply.",
    encouragement: "Warm emotional encouragement at the end of a hard day. Make them feel seen and not alone.",
    practical: "Practical evening prep tip — protein for tomorrow morning or hydration check before bed.",
  };
  const instruction = modeInstructions[mode] || modeInstructions.reflection;

  const systemPrompt = `You are Grace — a warm, human SMS wellness companion for women on GLP-1 medications.

GRACE'S VOICE RULES (non-negotiable):
- Sound like a close friend texting, not an app
- Keep it SHORT — 1-2 sentences maximum for proactive messages
- Never use exclamation marks
- Never say "Morning!" or "Good morning!" as an opener
- Never use bullet points
- No corporate language ("checking in", "quick reminder")
- No em-dashes (—)
- Vary your openers — never start two consecutive messages the same way
- Reference their history naturally if available

USER CONTEXT:
Name: ${user.first_name}
Medication: ${user.medication}
Goals: ${(user.goals || []).join(", ")}
Food dislikes: ${user.food_dislikes || "none"}
Grace's notebook: ${user.grace_notes || "nothing yet"}
${historyCtx ? `Reference from today: ${historyCtx}` : ""}

TODAY'S FOCUS: ${instruction}

Write ONE short proactive message Grace would send. No greeting like "Hi" or "Hey [name]" unless it feels very natural. Just get to the point warmly. Maximum 2 sentences. No question mark at the end unless you're genuinely asking something important.`;

  try {
    const response = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lovableApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash-lite",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: "Write the proactive check-in message now." },
          ],
          max_tokens: 100,
        }),
      },
    );
    if (!response.ok) throw new Error(`AI error: ${response.status}`);
    const data = await response.json();
    const aiMessage = data.choices?.[0]?.message?.content?.trim();
    if (!aiMessage || aiMessage.length < 10) throw new Error("Empty AI response");
    return aiMessage.replace(/^\s*[.,;]\s*/g, "").trim();
  } catch (err) {
    console.error("AI message generation failed, using fallback:", err);
    return buildMessage(mode, user.first_name, user.medication || "your GLP-1", historyCtx, user);
  }
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
      .select("id, first_name, phone, sleep_time, timezone, injection_day, injection_flow_stage, injection_evening_followup_due, low_mood_mode, last_evening_sent_at, last_reply_at, messages_sent_today, messages_sent_today_date, paused, active, current_weight, goal_weight, food_dislikes, medication, goals, is_paid, is_pro, trial_start, grace_notes")
      .eq("active", true)
      .eq("paused", false);

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
        const localMinute = localNow.getMinutes();
        const localDayName = getDayOfWeek(localNow);

        // Quiet hours guard for the injection follow-up too
        const inQuietHours = localHour >= 21 || localHour < 7;

        // ── Injection evening follow-up — runs any day, takes priority ──
        if (user.injection_evening_followup_due && !inQuietHours) {
          const eveningMsg =
            "Hey — how are you feeling after today's injection? Any side effects or anything different this time?";
          await sendSMSOnly(user.phone, eveningMsg);
          await supabase.from("users").update({
            injection_evening_followup_due: false,
          }).eq("id", user.id);
          await supabase.from("check_ins").insert({
            user_id: user.id,
            type: "injection_evening_followup",
            message_sent: eveningMsg,
          });
          sent++;
          console.log(`Injection evening followup sent to ${user.first_name}`);
          continue;
        }

        // Only Tue/Thu/Sun
        if (!["Tuesday", "Thursday", "Sunday"].includes(localDayName)) { skipped++; continue; }

        // Never on injection day
        if (localDayName === user.injection_day) { skipped++; continue; }

        // Skip if injection flow active
        if (user.injection_flow_stage) { skipped++; continue; }

        // Quiet hours
        if (localHour >= 21 || localHour < 7) { skipped++; continue; }

        // Send at bedtime - 90 minutes
        const [sleepH, sleepM] = (user.sleep_time || "22:00:00").split(":").map(Number);
        const targetMin = (sleepH * 60 + sleepM) - 90;
        const currentMin = localHour * 60 + localMinute;
        if (currentMin < targetMin || currentMin > targetMin + 15) { skipped++; continue; }

        // Don't double-send
        if (user.last_evening_sent_at && sameLocalDate(new Date(user.last_evening_sent_at), tz, now)) {
          skipped++; continue;
        }

        // Free-trial expired users (>3 days, not paid, not pro): skip entirely
        const trialStart = user.trial_start ? new Date(user.trial_start) : now;
        const daysSinceTrial = (now.getTime() - trialStart.getTime()) / (1000 * 60 * 60 * 24);
        if (!user.is_paid && !user.is_pro && daysSinceTrial > 3) {
        }

        // Skip if user chatted in last 3 hours
        const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
        if (user.last_reply_at && user.last_reply_at > threeHoursAgo) {
          console.log(`Skipping ${user.first_name} — last reply was within 3 hours`);
          skipped++;
          continue;
        }
        // Proactive messages are unlimited for base & pro tiers
        const localDate = getLocalDate(now, tz);

        // Fetch today's interactions for context
        const todayStart = new Date(localNow);
        todayStart.setHours(0, 0, 0, 0);
        const { data: todayCheckins } = await supabase
          .from("check_ins")
          .select("type, user_reply, mood_score, protein_logged")
          .eq("user_id", user.id)
          .gte("created_at", todayStart.toISOString())
          .order("created_at", { ascending: false })
          .limit(10);

        const todayReplies = todayCheckins?.filter(c => c.user_reply) || [];
        const todayMood = todayReplies.find(c => c.mood_score !== null);
        const todayProtein = todayReplies.find(c => c.protein_logged);
        const hadSideEffects = todayReplies.some(c => c.type.includes("nausea") || c.type.includes("fatigue") || c.type.includes("side_effect"));

        // Build a day-aware prefix
        let dayContext = "";
        if (todayMood && todayMood.mood_score !== null) {
          if (todayMood.mood_score <= 4) {
            dayContext = `I know today was hard (you said ${todayMood.mood_score}/10). `;
          } else if (todayMood.mood_score >= 8) {
            dayContext = `What a day — you were at a ${todayMood.mood_score} this morning! `;
          }
        }
        if (hadSideEffects && !dayContext) {
          dayContext = "You dealt with some side effects today — that takes real toughness. ";
        }
        if (todayProtein && !dayContext) {
          dayContext = `You logged ${todayProtein.protein_logged} today — nice work. `;
        }

        // Check recent mood
        let useEncouragement = user.low_mood_mode;
        if (!useEncouragement) {
          const { data: recentMoods } = await supabase
            .from("check_ins")
            .select("mood_score")
            .eq("user_id", user.id)
            .not("mood_score", "is", null)
            .order("created_at", { ascending: false })
            .limit(3);

          if (recentMoods && recentMoods.length >= 2) {
            const avg = recentMoods.reduce((s, c) => s + (c.mood_score || 0), 0) / recentMoods.length;
            if (avg < 5) useEncouragement = true;
          }
        }

        const med = user.medication || "GLP-1";
        let message: string;
        let tone: string;

        if (useEncouragement) {
          tone = "encouragement";
        } else {
          const week = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
          tone = week % 2 === 0 ? "reflection" : "practical";
        }

        const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY") || "";
        const aiBody = await aiProactiveMessage(tone, user, dayContext.trim() || null, LOVABLE_API_KEY);
        message = dayContext + aiBody;

        await sendSMSOnly(user.phone, message);

        await supabase.from("check_ins").insert({
          user_id: user.id,
          type: `evening_${tone}`,
          message_sent: message,
        });

        await supabase.from("users").update({
          last_evening_sent_at: now.toISOString(),
          messages_sent_today: (user.messages_sent_today || 0) + 1,
          messages_sent_today_date: localDate,
        }).eq("id", user.id);

        sent++;
        console.log(`Evening ${tone} sent to ${user.first_name}`);
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
