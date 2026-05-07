import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01/Accounts";
const MAX_DAILY_MESSAGES_BASE = 10;

function getLocalDate(now: Date, tz: string): string {
  const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
}

// ─── Goal-aware message builders ────────────────────────────────────

function buildProteinMessage(name: string, medication: string): string {
  const variants = [
    `Morning ${name}! Quick one: what's your protein plan today? On ${medication}, your body needs more protein than usual to stay strong. Even a rough idea helps — reply back!`,
    `Hey ${name} — ${medication} can reduce appetite, which means less protein if you're not careful. What's your first protein hit today? (Eggs, yogurt, shake — anything counts)`,
    `Good morning! Did you get 20g+ of protein at breakfast? On ${medication}, aiming for 60-100g daily is key. No judgment — just curious how it's going.`,
  ];
  return pickVariant(variants, name);
}

function buildHydrationMessage(name: string): string {
  const variants = [
    `Morning ${name}! GLP-1 can make it easy to forget water since you're not as hungry. First goal: drink something before you do anything else. Done? Reply 'done' 💧`,
    `Hey! Water check. Aim for 64oz by end of day. How are you starting? (Even coffee counts a little)`,
    `Good morning! Constipation check — the thing nobody warns you about. Fiber + water = your best friends. How's your water game lately? Reply: great / okay / honestly terrible`,
  ];
  return pickVariant(variants, name);
}

function buildMoodMessage(name: string): string {
  const variants = [
    `Morning ${name}! How are you feeling today — body and brain? Rate yourself 1 to 10. I track this over time and it's actually really useful.`,
    `Hey! Quick gut check: how's your energy today? 1 = dragging, 10 = actually excited about today. What are you?`,
    `Good morning! This is your weekly vibe check. Weight stuff aside — how are you FEELING? 1-10, or just tell me in words.`,
  ];
  return pickVariant(variants, name);
}

function buildHabitMessage(name: string): string {
  const variants = [
    `Morning ${name}! What's one small thing you can do today that Future You will thank you for? Doesn't have to be big. Reply with your plan.`,
    `Hey! Daily habit check: did you do that one thing yesterday that you said you would? (Be honest — I'm not judging, just keeping you accountable!)`,
    `Good morning! Three tiny wins to aim for today: drink water first thing, eat protein at breakfast, move for 10 minutes. Which one are you starting with?`,
  ];
  return pickVariant(variants, name);
}

function buildSideEffectMessage(name: string, medication: string): string {
  const variants = [
    `Morning ${name}! How's your body feeling today? Any nausea, fatigue, or anything off? ${medication} side effects can shift week to week — tracking them helps.`,
    `Hey! Body check: rate how you're physically feeling 1-10. If anything feels off, describe it — I'll keep notes so we can spot patterns.`,
    `Good morning! Quick ${medication} check: stomach okay? Energy okay? Sleep okay? Even just 'all good' works. I'm tracking for you.`,
  ];
  return pickVariant(variants, name);
}

function buildFiberMessage(name: string): string {
  const variants = [
    `Morning ${name}! Fiber focus today — aim for 25g. A cup of lentils = 15g, an apple = 4g, an avocado = 10g. What's your plan?`,
    `Hey! GI health check — things moving okay? If you've been backed up, more fiber + water is the move. What veggies or whole grains are on your menu today?`,
  ];
  return pickVariant(variants, name);
}

function buildLonelinessMessage(name: string): string {
  const variants = [
    `Morning ${name} — just checking in. This journey can feel lonely sometimes. How are you doing today, really? I'm here to listen. 🧡`,
    `Hey! Quick emotional check: do you have someone to talk to about how this is going? If not, that's okay — you've got me. How are you feeling?`,
  ];
  return pickVariant(variants, name);
}

const INJECTION_AWARENESS = (name: string, medication: string) =>
  `Hey ${name} — tomorrow is your ${medication} day! Anything you want to stock up on? (Ginger tea, crackers, electrolytes — just in case). Some people feel totally fine, some feel rough. Worth being prepared 🧡`;

const DOSE_CHANGE_VARIANTS = [
  (name: string, med: string) =>
    `Morning ${name}! New ${med} dose week — how are you feeling? Any nausea, fatigue, or anything different? Even 'totally fine' is useful to know.`,
  (name: string, med: string) =>
    `Hey ${name} — dose increase check! Eat small amounts frequently, stay hydrated, and be gentle with yourself. How's your body doing?`,
  (name: string, med: string) =>
    `Good morning! Quick ${med} dose adjustment check: how did you sleep? New doses can affect sleep and energy. Rate 1-10 or just tell me.`,
];

// ─── Goal-based topic selection ─────────────────────────────────────

// Map goal labels to message modes
const GOAL_MODE_MAP: Record<string, string> = {
  "Losing weight": "protein",        // Weight loss needs protein focus
  "Eating enough protein": "protein",
  "Staying hydrated": "hydration",
  "Managing side effects": "side_effects",
  "Building better habits": "habits",
  "Feeling less alone in this": "loneliness",
  "Hitting my fiber goals": "fiber",
  "Protecting my muscle": "muscle",
};

function getGoalBasedMode(
  goals: string[],
  dayOfWeek: number,
  userId: string,
): string {
  if (!goals || goals.length === 0) return "protein"; // default

  // Map goals to modes, deduplicate
  const modes = [...new Set(goals.map(g => GOAL_MODE_MAP[g] || "protein"))];
  
  // Rotate through user's relevant modes based on day
  const hash = userId.charCodeAt(0) + userId.charCodeAt(userId.length - 1);
  return modes[(dayOfWeek + hash) % modes.length];
}

// ─── Helpers ─────────────────────────────────────────────────────────

function getDayOfWeek(date: Date): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getDay()];
}

function getNextDay(dayName: string): string {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const idx = days.indexOf(dayName);
  return days[(idx + 1) % 7];
}

function pickVariant(variants: string[], seed: string): string {
  const week = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  const hash = seed.charCodeAt(0) + (seed.length > 1 ? seed.charCodeAt(seed.length - 1) : 0);
  return variants[(week + hash) % variants.length];
}

function buildMuscleMessage(name: string): string {
  const variants = [
    `Protein check — are you hitting 0.7g per lb of body weight? On GLP-1s, this is the best way to protect your muscle while losing fat.`,
    `Did you do any resistance movement this week? Even 20 minutes counts. Muscle loss is the hidden risk on GLP-1s — you're ahead just by thinking about it.`,
    `Quick muscle check: how's your protein today? And any strength work planned this week?`,
    `GLP-1s help you lose weight but can take muscle with it. Two things fight that: protein and resistance exercise. How's your week looking on both?`,
  ];
  return pickVariant(variants, name);
}

function buildMessage(
  mode: string,
  name: string,
  medication: string,
  historyContext: string | null,
): string {
  const base = (() => {
    switch (mode) {
      case "protein": return buildProteinMessage(name, medication);
      case "hydration": return buildHydrationMessage(name);
      case "mood": return buildMoodMessage(name);
      case "habits": return buildHabitMessage(name);
      case "side_effects": return buildSideEffectMessage(name, medication);
      case "fiber": return buildFiberMessage(name);
      case "loneliness": return buildLonelinessMessage(name);
      case "muscle": return buildMuscleMessage(name);
      default: return buildProteinMessage(name, medication);
    }
  })();

  // Prepend a history callback if we have one
  if (historyContext) {
    return `${historyContext} ${base}`;
  }
  return base;
}

// ─── History context builder ─────────────────────────────────────────

interface RecentCheckin {
  type: string;
  message_sent: string;
  user_reply: string | null;
  mood_score: number | null;
  protein_logged: string | null;
  created_at: string;
}

function buildHistoryContext(history: RecentCheckin[], name: string): string | null {
  if (!history || history.length === 0) return null;

  // Find yesterday's replies (most recent user replies)
  const replied = history.filter(h => h.user_reply);
  if (replied.length === 0) return null;

  const latest = replied[0];
  const reply = latest.user_reply!.trim();

  // Reference mood scores
  if (latest.mood_score !== null) {
    if (latest.mood_score <= 4) {
      return `Yesterday was tough (you said ${latest.mood_score}/10) — I hope today's a little better.`;
    }
    if (latest.mood_score >= 8) {
      return `Love that you were at a ${latest.mood_score} yesterday!`;
    }
  }

  // Reference food logging
  if (latest.protein_logged) {
    return `Nice job logging ${latest.protein_logged} yesterday — keep that going!`;
  }

  // Reference side effect conversations
  if (latest.type.includes("nausea") || latest.type.includes("fatigue") || latest.type.includes("constipation") || latest.type.includes("side_effect")) {
    return `Checking in after yesterday — how's your body feeling today?`;
  }

  // Reference specific short replies
  if (reply.length < 30 && /good|great|amazing|wonderful/i.test(reply)) {
    return `Glad yesterday was good!`;
  }
  if (reply.length < 30 && /hard|rough|bad|terrible/i.test(reply)) {
    return `Yesterday was rough — today's a new day.`;
  }

  return null;
}

// ─── AI proactive message generation ─────────────────────────────────

async function aiProactiveMessage(
  mode: string,
  user: any,
  historyCtx: string | null,
  lovableApiKey: string,
): Promise<string> {
  const modeInstructions: Record<string, string> = {
    protein: "Focus on protein intake today. Ask about their first protein hit or how they're tracking protein.",
    hydration: "Focus on water and hydration. Ask how their water intake is going.",
    mood: "Focus on emotional wellbeing. Ask how they're feeling today, 1-10 or in words.",
    habits: "Focus on one small healthy habit for today.",
    side_effects: "Check in on physical side effects — nausea, fatigue, stomach.",
    fiber: "Focus on fiber intake and digestive health.",
    loneliness: "Emotional check-in. Make them feel seen and not alone.",
    injection_awareness: "Tomorrow is injection day. Help them prepare warmly.",
    post_injection: "Yesterday was their injection day. Some people feel rough the day after (nausea, fatigue), some feel fine. Check in gently — don't assume they feel bad, but let them know you're aware it was injection day yesterday and you're here either way. Keep it to 1-2 sentences.",
    dose_change: "They recently changed their dose. Check how their body is adjusting.",
    reflection: "End-of-day reflection. Ask how today went in one word or short reply.",
    encouragement: "Warm emotional encouragement at the end of a hard day. Make them feel seen.",
    practical: "Practical evening prep tip — protein for tomorrow or hydration check.",
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
    return buildMessage(mode, user.first_name, user.medication, historyCtx);
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
      .select("id, first_name, phone, medication, goals, food_dislikes, current_weight, goal_weight, injection_count, timezone, wake_time, last_morning_sent_at, last_reply_at, protein_focus_boost, hydration_struggle, low_mood_mode, consecutive_no_reply_days, is_paid, is_pro, trial_start, injection_day, injection_flow_stage, dose_change_started_at, messages_sent_today, messages_sent_today_date, grace_notes, active, paused, checkin_frequency, checkin_count_per_day, checkin_days_interval, medication_frequency, medication_time")
      .eq("active", true)
      .eq("paused", false);

    if (error) {
      console.error("Fetch users error:", error);
      return new Response(JSON.stringify({ error: "Failed to fetch users" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("Users found:", users?.length || 0);
    console.log("User data:", JSON.stringify(users?.[0]));

    let sent = 0;
    let skipped = 0;

    for (const user of users || []) {
      try {
        const tz = user.timezone || "America/New_York";
        const localNow = new Date(
          now.toLocaleString("en-US", { timeZone: tz }),
        );
        const localHour = localNow.getHours();
        const localMinute = localNow.getMinutes();
        const localDayName = getDayOfWeek(localNow);

        console.log("User timezone:", user.timezone);
        console.log("User wake_time:", user.wake_time);
        console.log("Current UTC time:", new Date().toISOString());
        console.log("User local hour:", localHour);

        // Quiet hours: never send between 9pm and 7am
        if (localHour >= 21 || localHour < 7) { skipped++; continue; }

        // Parse wake_time (format: "07:00:00") — fallback to 8:00am if not set
        const wakeH = user.wake_time
          ? parseInt(user.wake_time.split(":")[0])
          : 8;
        const wakeM = user.wake_time
          ? parseInt(user.wake_time.split(":")[1])
          : 0;
        const wakeMinutes = wakeH * 60 + wakeM;
        const currentMinutes = localHour * 60 + localMinute;

        console.log(`User: ${user.first_name}`);
        console.log(`Local time: ${localHour}:${localMinute}`);
        console.log(`Wake time: ${wakeH}:${wakeM}`);
        console.log(`Window check: ${Math.abs(currentMinutes - wakeMinutes)} minutes from wake time`);
        console.log(`Last morning sent: ${user.last_morning_sent_at || "never"}`);

        if (Math.abs(currentMinutes - wakeMinutes) > 60) {
          skipped++; continue;
        }

        // Respect checkin_days_interval — skip if too soon since last morning
        if (user.checkin_days_interval && user.checkin_days_interval > 1) {
          const lastSent = user.last_morning_sent_at
            ? new Date(user.last_morning_sent_at)
            : null;
          if (lastSent) {
            const daysSinceLast =
              (now.getTime() - lastSent.getTime()) / (1000 * 60 * 60 * 24);
            if (daysSinceLast < user.checkin_days_interval) {
              console.log(
                `Skipping ${user.first_name} — interval is ${user.checkin_days_interval} days, last sent ${daysSinceLast.toFixed(1)} days ago`,
              );
              skipped++; continue;
            }
          }
        }

        // Don't double-send today
        if (user.last_morning_sent_at) {
          const lastSent = new Date(user.last_morning_sent_at);
          const lastSentLocal = new Date(
            lastSent.toLocaleString("en-US", { timeZone: tz }),
          );
          if (
            lastSentLocal.getFullYear() === localNow.getFullYear() &&
            lastSentLocal.getMonth() === localNow.getMonth() &&
            lastSentLocal.getDate() === localNow.getDate()
          ) { skipped++; continue; }
        }

        // Respect "less" frequency preference: only send every other day (≥36h gap)
        if (user.checkin_frequency === "less") {
          const lastMorning = user.last_morning_sent_at
            ? new Date(user.last_morning_sent_at)
            : null;
          const hoursSinceLastMorning = lastMorning
            ? (Date.now() - lastMorning.getTime()) / (1000 * 60 * 60)
            : 999;
          if (hoursSinceLastMorning < 36) {
            console.log(
              `Skipping morning for ${user.id} — prefers less, last morning was ${hoursSinceLastMorning.toFixed(1)}h ago`,
            );
            skipped++; continue;
          }
        }

        // Free-trial expired users (>3 days, not paid, not pro): skip entirely
        const trialStart = user.trial_start ? new Date(user.trial_start) : now;
        const daysSinceTrial = (now.getTime() - trialStart.getTime()) / (1000 * 60 * 60 * 24);
        if (!user.is_paid && !user.is_pro && daysSinceTrial > 3) {
          skipped++; continue;
        }
        // Note: proactive messages are unlimited for base & pro tiers (no per-day cap here)
        const localDate = getLocalDate(now, tz);

        // Skip if injection flow is active
        if (user.injection_flow_stage) { skipped++; continue; }

        // Only apply injection day skips for weekly users
        const isWeeklyUser =
          !user.medication_frequency ||
          user.medication_frequency === "weekly";
        if (isWeeklyUser) {
          // Skip on injection day itself
          if (localDayName === user.injection_day) { skipped++; continue; }

          // Day after injection — send gentle midday-timed check-in instead of morning
          const yesterdayIdx = (localNow.getDay() + 6) % 7;
          const yesterdayName = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][yesterdayIdx];
          const isDayAfterInjection = yesterdayName === user.injection_day && isWeeklyUser;
          if (isDayAfterInjection) {
            // Only send if it's midday or later (hour >= 11) and user hasn't chatted today
            if (localHour < 11) { skipped++; continue; }
            const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
            if (user.last_reply_at && new Date(user.last_reply_at) > threeHoursAgo) { skipped++; continue; }

            // Fetch recent history for personalization
            const { data: postRecentHistory } = await supabase
              .from("check_ins")
              .select("type, message_sent, user_reply, mood_score, protein_logged, created_at")
              .eq("user_id", user.id)
              .order("created_at", { ascending: false })
              .limit(5);
            const postHistoryCtx = buildHistoryContext(postRecentHistory || [], user.first_name);

            // Send a gentle post-injection check-in
            const postInjectionVariants = [
              `How are you feeling today? Yesterday was shot day — some people feel rough the day after, some feel totally fine. Either way, I'm here.`,
              `Checking in after injection day. How's your body doing today?`,
              `Post-injection check-in — how are you feeling? Nausea, fatigue, or all good?`,
            ];
            const fallbackPost = postHistoryCtx
              ? `${postHistoryCtx} ${postInjectionVariants[Math.floor(Math.random() * postInjectionVariants.length)]}`
              : postInjectionVariants[Math.floor(Math.random() * postInjectionVariants.length)];

            const LOVABLE_API_KEY_PI = Deno.env.get("LOVABLE_API_KEY") || "";
            let postMessage = fallbackPost;
            try {
              postMessage = await aiProactiveMessage("post_injection", user, postHistoryCtx, LOVABLE_API_KEY_PI);
              if (!postMessage) postMessage = fallbackPost;
            } catch (_e) {
              postMessage = fallbackPost;
            }

            await sendSMSOnly(user.phone, postMessage);
            await supabase.from("check_ins").insert({
              user_id: user.id,
              type: "morning_post_injection",
              message_sent: postMessage,
            });
            await supabase.from("users").update({
              last_checkin_mode: "post_injection",
              last_morning_sent_at: now.toISOString(),
              messages_sent_today: (user.messages_sent_today || 0) + 1,
              messages_sent_today_date: localDate,
            }).eq("id", user.id);

            sent++;
            continue;
          }
        }

        // Skip if user chatted in last 3 hours
        const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
        if (user.last_reply_at && user.last_reply_at > threeHoursAgo) {
          console.log(`Skipping ${user.first_name} — last reply was within 3 hours`);
          skipped++;
          continue;
        }

        // Fetch recent history for personalization
        const { data: recentHistory } = await supabase
          .from("check_ins")
          .select("type, message_sent, user_reply, mood_score, protein_logged, created_at")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(5);

        const historyCtx = buildHistoryContext(recentHistory || [], user.first_name);

        // Dose change week override
        let mode: string;
        let message: string;
        const doseChangeActive = user.dose_change_started_at &&
          (now.getTime() - new Date(user.dose_change_started_at).getTime()) < 7 * 24 * 60 * 60 * 1000;

        // Day before injection → injection awareness
        const dayBeforeInjection = getNextDay(localDayName);

        if (doseChangeActive) {
          mode = "dose_change";
        } else if (dayBeforeInjection === user.injection_day) {
          mode = "injection_awareness";
        } else {
          // Goal-based topic selection
          mode = getGoalBasedMode(user.goals || [], localNow.getDay(), user.id);

          // Personalization flag overrides
          if (user.protein_focus_boost && mode !== "protein" && localDayName !== "Wednesday") {
            if (localNow.getDay() % 2 === 0) mode = "protein";
          }
          if (user.hydration_struggle && mode !== "hydration" && localDayName !== "Wednesday") {
            if (localNow.getDay() % 2 === 1) mode = "hydration";
          }

          // Always include a mood check on Wednesdays regardless of goals
          if (localDayName === "Wednesday") mode = "mood";
        }

        const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY") || "";
        message = await aiProactiveMessage(mode, user, historyCtx, LOVABLE_API_KEY);

        console.log("Sending morning message to:", user.phone);
        await sendSMSOnly(user.phone, message);
        console.log("Morning message sent successfully");

        await supabase.from("check_ins").insert({
          user_id: user.id,
          type: `morning_${mode}`,
          message_sent: message,
        });

        const userUpdateData: Record<string, unknown> = {
          last_checkin_mode: mode,
          last_morning_sent_at: now.toISOString(),
          messages_sent_today: (user.messages_sent_today || 0) + 1,
          messages_sent_today_date: localDate,
        };

        if (user.dose_change_started_at &&
          (now.getTime() - new Date(user.dose_change_started_at).getTime()) >= 7 * 24 * 60 * 60 * 1000) {
          userUpdateData.dose_change_started_at = null;
        }

        await supabase.from("users").update(userUpdateData).eq("id", user.id);

        sent++;
        console.log(`Sent morning ${mode} to ${user.first_name} (${user.id})`);
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
