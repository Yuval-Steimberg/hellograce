import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01/Accounts";
const MAX_DAILY_MESSAGES_BASE = 10;

// ─── Food-aware message builders ────────────────────────────────────

function buildProteinMessage(name: string, foodDislikes: string | null, medication: string): string {
  const dislikes = (foodDislikes || "").toLowerCase();
  
  const suggestions: string[] = [];
  if (!dislikes.includes("yogurt") && !dislikes.includes("dairy")) suggestions.push("Greek yogurt (17g)");
  if (!dislikes.includes("egg")) suggestions.push("a hard-boiled egg (6g)");
  if (!dislikes.includes("soy") && !dislikes.includes("bean")) suggestions.push("edamame (8g)");
  if (!dislikes.includes("chicken")) suggestions.push("chicken breast (31g)");
  if (!dislikes.includes("fish") && !dislikes.includes("tuna")) suggestions.push("canned tuna (20g)");
  if (dislikes.includes("meat") || dislikes.includes("vegetarian") || dislikes.includes("vegan")) {
    suggestions.push("tofu (10g per half cup)");
    suggestions.push("hemp seeds (10g per 3 tbsp)");
  }

  const snackList = suggestions.slice(0, 3).join(", ");

  const variants = [
    `Hey ${name}, how's your afternoon going? ${medication} can reduce appetite, so protein gets missed fast. What did you eat for lunch?`,
    `Quick hello ${name} — protein check. Most people on ${medication} should aim for 60-100g per day. Where are you roughly right now?`,
    `Checking in — how's the day treating you? Quick high-protein snack ideas: ${snackList}. Any of those doable right now?`,
  ];
  return pickVariant(variants, name);
}

function buildFiberMessage(foodDislikes: string | null, medication: string): string {
  const dislikes = (foodDislikes || "").toLowerCase();
  
  const suggestions: string[] = [];
  if (!dislikes.includes("lentil") && !dislikes.includes("bean")) suggestions.push("a cup of lentils (15g)");
  if (!dislikes.includes("apple")) suggestions.push("an apple (4g)");
  if (!dislikes.includes("avocado")) suggestions.push("an avocado (10g)");
  if (!dislikes.includes("broccoli")) suggestions.push("broccoli (5g per cup)");
  if (!dislikes.includes("oat")) suggestions.push("oatmeal (4g per cup)");

  const fiberList = suggestions.slice(0, 3).join(", ");

  const variants = [
    `Hey, how's your afternoon going? Fiber check — aim for 25g+ per day. Constipation is super common on ${medication}, and fiber is your best defense. Some easy options: ${fiberList}.`,
    `Quick gut check — are things moving okay? ${medication} can slow things down. If you've been backed up, reply 'help' and I'll send tips.`,
    `Checking in — how's the day treating you? Fiber options: ${fiberList}. What are you adding in today?`,
  ];
  return pickVariant(variants, "fiber");
}

function buildHydrationMessage(name: string, medication: string): string {
  const variants = [
    `Hey ${name}, how's your afternoon going? Water check — how many glasses since you woke up? ${medication} can make you forget to drink since you're not as hungry. Be honest 💧`,
    `Quick hello ${name} — hydration check. If you have a headache or feel foggy right now, drink a big glass of water first. On ${medication}, dehydration sneaks up fast.`,
    `Checking in — have you had 32oz of water yet today? That's your halfway point. Reply yes/no — I'm tracking how you're doing this week.`,
  ];
  return pickVariant(variants, name);
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

// Goal-based mode for midday
const GOAL_MIDDAY_MAP: Record<string, string> = {
  "Eating enough protein": "protein",
  "Staying hydrated": "hydration",
  "Hitting my fiber goals": "fiber",
  "Losing weight": "protein",
};

function getGoalBasedMiddayMode(goals: string[], dayIdx: number, userId: string): "protein" | "fiber" | "hydration" {
  const relevantGoals = goals.filter(g => GOAL_MIDDAY_MAP[g]);
  const modes = [...new Set(relevantGoals.map(g => GOAL_MIDDAY_MAP[g]))] as ("protein" | "fiber" | "hydration")[];
  if (modes.length === 0) return "protein";
  const hash = userId.charCodeAt(0) + (userId.length > 1 ? userId.charCodeAt(userId.length - 1) : 0);
  return modes[(dayIdx + hash) % modes.length];
}

// Fallback wrapper to match aiProactiveMessage signature
function buildMessage(
  mode: string,
  name: string,
  medication: string,
  _historyCtx: string | null,
  foodDislikes?: string | null,
): string {
  if (mode === "fiber") return buildFiberMessage(foodDislikes ?? null, medication);
  if (mode === "hydration") return buildHydrationMessage(name, medication);
  return buildProteinMessage(name, foodDislikes ?? null, medication);
}

async function aiProactiveMessage(
  mode: string,
  user: any,
  historyCtx: string | null,
  lovableApiKey: string,
): Promise<string> {
  const modeInstructions: Record<string, string> = {
    protein: "Midday protein check. Ask what they had for lunch or how their protein is going.",
    hydration: "Midday water check. Ask how their hydration is going so far today.",
    fiber: "Midday fiber and digestive health check.",
  };
  const instruction = modeInstructions[mode] || modeInstructions.protein;

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
${historyCtx ? `Reference from yesterday: ${historyCtx}` : ""}

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
    return buildMessage(mode, user.first_name, user.medication || "your GLP-1", historyCtx, user.food_dislikes);
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
      .select("id, first_name, phone, timezone, injection_day, injection_flow_stage, midday_skip, last_midday_sent_at, last_reply_at, messages_sent_today, messages_sent_today_date, paused, active, goals, food_dislikes, medication, is_paid, is_pro, trial_start, grace_notes, checkin_frequency")
      .eq("active", true)
      .eq("paused", false)
      .eq("midday_skip", false);

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

        // Respect "less" frequency: skip midday entirely
        if (user.checkin_frequency === "less") {
          console.log(`Skipping midday for ${user.id} — prefers less check-ins`);
          skipped++; continue;
        }

        // Only Mon/Wed/Fri
        if (!["Monday", "Wednesday", "Friday"].includes(localDayName)) { skipped++; continue; }

        // Never on injection day or day after
        if (localDayName === user.injection_day) { skipped++; continue; }
        const yesterdayIdx = (localNow.getDay() + 6) % 7;
        const yesterdayName = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][yesterdayIdx];
        if (yesterdayName === user.injection_day) { skipped++; continue; }

        // Skip if injection flow active
        if (user.injection_flow_stage) { skipped++; continue; }

        // Midday window: 11am to 2pm local time only
        console.log(
          `Midday check for ${user.first_name}: local hour = ${localHour}, window = 11-14`
        );
        if (localHour < 11 || localHour >= 14) { skipped++; continue; }

        // Don't double-send
        if (user.last_midday_sent_at && sameLocalDate(new Date(user.last_midday_sent_at), tz, now)) {
          skipped++; continue;
        }

        // Skip if user chatted in last 3 hours
        const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
        if (user.last_reply_at && user.last_reply_at > threeHoursAgo) {
          console.log(`Skipping ${user.first_name} — last reply was within 3 hours`);
          skipped++;
          continue;
        }
        // Free-trial expired users (>3 days, not paid, not pro): skip entirely
        const trialStart = user.trial_start ? new Date(user.trial_start) : now;
        const daysSinceTrial = (now.getTime() - trialStart.getTime()) / (1000 * 60 * 60 * 24);
        if (!user.is_paid && !user.is_pro && daysSinceTrial > 3) {
          skipped++; continue;
        }
        // Proactive messages are unlimited for base & pro tiers
        const localDate = getLocalDate(now, tz);

        // Fetch today's morning reply for context
        const todayStart = new Date(localNow);
        todayStart.setHours(0, 0, 0, 0);
        const { data: todayCheckins } = await supabase
          .from("check_ins")
          .select("type, user_reply, mood_score, protein_logged")
          .eq("user_id", user.id)
          .gte("created_at", todayStart.toISOString())
          .order("created_at", { ascending: false })
          .limit(5);

        const morningReply = todayCheckins?.find(c => c.user_reply && c.type.startsWith("morning_"));

        // Skip midday if user already engaged today via morning reply
        // (unless they prefer "more" frequency — then send anyway)
        if (morningReply && user.checkin_frequency !== "more") {
          console.log(`Skipping midday for ${user.id} — already replied today`);
          skipped++;
          continue;
        }

        let historyPrefix = "";

        // Goal-based mode selection
        const mode = getGoalBasedMiddayMode(user.goals || [], localNow.getDay(), user.id);
        const med = user.medication || "your GLP-1";

        const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY") || "";
        const message: string = await aiProactiveMessage(mode, user, null, LOVABLE_API_KEY);

        await sendSMSOnly(user.phone, message);

        await supabase.from("check_ins").insert({
          user_id: user.id,
          type: `midday_${mode}`,
          message_sent: message,
        });

        await supabase.from("users").update({
          last_midday_sent_at: now.toISOString(),
          messages_sent_today: (user.messages_sent_today || 0) + 1,
          messages_sent_today_date: localDate,
        }).eq("id", user.id);

        sent++;
        console.log(`Midday ${mode} sent to ${user.first_name} (${med})`);
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
