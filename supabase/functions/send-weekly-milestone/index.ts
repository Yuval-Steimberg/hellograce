import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01/Accounts";

// ─── Weight comparison lookup ────────────────────────────────────────

function weightComparison(lbs: number): string {
  if (lbs <= 2) return "a can of soup";
  if (lbs <= 5) return "a large bag of apples";
  if (lbs <= 8) return "a gallon of milk";
  if (lbs <= 11) return "a newborn baby";
  if (lbs <= 15) return "a small bowling ball";
  if (lbs <= 20) return "a car tire";
  if (lbs <= 25) return "a 5-year-old child";
  if (lbs <= 30) return "a medium dog";
  if (lbs <= 40) return "a large bag of dog food";
  if (lbs <= 50) return "a carry-on suitcase";
  if (lbs <= 65) return "a golden retriever";
  if (lbs <= 80) return "a 10-year-old child";
  return "literally a whole person";
}

function goalEncouragement(goals: string[] | null): string {
  if (!goals || goals.length === 0) return "Keep going — you're building something real.";

  const g = goals[0].toLowerCase();
  if (g.includes("weight") || g.includes("lose")) return "Every pound is proof this is working.";
  if (g.includes("energy")) return "Your energy levels are part of this transformation.";
  if (g.includes("health") || g.includes("healthy")) return "You're investing in your future health every single day.";
  if (g.includes("confidence") || g.includes("feel")) return "The way you feel in your own skin is changing — and that matters.";
  return "Keep going — you're building something real.";
}

// ─── Helpers ─────────────────────────────────────────────────────────

function getDayOfWeek(date: Date): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getDay()];
}

function sameLocalDate(d1: Date, tz: string, d2: Date): boolean {
  const a = new Date(d1.toLocaleString("en-US", { timeZone: tz }));
  const b = new Date(d2.toLocaleString("en-US", { timeZone: tz }));
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
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
      .select("id, first_name, phone, timezone, goals, current_weight, created_at, last_milestone_sent_at, paused, active, medication")
      .eq("active", true)
      .eq("paused", false)
      .eq("is_paid", true);

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
        const localDayName = getDayOfWeek(localNow);

        // Only Sunday
        if (localDayName !== "Sunday") { skipped++; continue; }

        // 10am window (10:00–10:15)
        const localMinute = localNow.getMinutes();
        const currentMin = localHour * 60 + localMinute;
        if (currentMin < 600 || currentMin > 615) { skipped++; continue; }

        // Don't double-send
        if (user.last_milestone_sent_at && sameLocalDate(new Date(user.last_milestone_sent_at), tz, now)) {
          skipped++; continue;
        }

        // Calculate weeks on program
        const startDate = new Date(user.created_at);
        const weeksOn = Math.max(1, Math.floor((now.getTime() - startDate.getTime()) / (7 * 24 * 60 * 60 * 1000)));

        // Get weight logs
        const { data: weightLogs } = await supabase
          .from("weight_logs")
          .select("weight, logged_at")
          .eq("user_id", user.id)
          .order("logged_at", { ascending: true });

        // Calculate reply streak (consecutive days with at least one reply)
        const { data: recentCheckins } = await supabase
          .from("check_ins")
          .select("created_at")
          .eq("user_id", user.id)
          .not("user_reply", "is", null)
          .order("created_at", { ascending: false })
          .limit(30);

        let streak = 0;
        if (recentCheckins && recentCheckins.length > 0) {
          const today = new Date(localNow);
          today.setHours(0, 0, 0, 0);

          for (let d = 0; d < 30; d++) {
            const checkDate = new Date(today);
            checkDate.setDate(checkDate.getDate() - d);
            const dateStr = checkDate.toISOString().split("T")[0];

            const hasReply = recentCheckins.some((c) => {
              const cLocal = new Date(new Date(c.created_at).toLocaleString("en-US", { timeZone: tz }));
              const cDate = `${cLocal.getFullYear()}-${String(cLocal.getMonth() + 1).padStart(2, "0")}-${String(cLocal.getDate()).padStart(2, "0")}`;
              return cDate === dateStr;
            });

            if (hasReply) streak++;
            else break;
          }
        }

        let message: string;
        const med = user.medication || "GLP-1";

        if (weightLogs && weightLogs.length >= 2) {
          const firstWeight = weightLogs[0].weight;
          const latestWeight = weightLogs[weightLogs.length - 1].weight;
          const totalLost = Math.round((firstWeight - latestWeight) * 10) / 10;

          if (totalLost > 0) {
            const comparison = weightComparison(totalLost);
            const encouragement = goalEncouragement(user.goals);
            message = `Week ${weeksOn} update, ${user.first_name}! You're down ${totalLost} lbs total — that's the weight of ${comparison}. Let that sink in for a second. You did that. 🎉 ${encouragement}`;

            // Plateau detection: no loss in 2+ weeks
            if (weightLogs.length >= 3) {
              const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
              const recentLogs = weightLogs.filter((w) => new Date(w.logged_at) >= twoWeeksAgo);
              if (recentLogs.length >= 2) {
                const recentFirst = recentLogs[0].weight;
                const recentLast = recentLogs[recentLogs.length - 1].weight;
                if (Math.abs(recentFirst - recentLast) < 0.5) {
                  message += `\n\nQuick note on the scale: plateaus are a normal part of this journey — not a sign that something's wrong. GLP-1 weight loss often comes in waves. Your body is still changing even when the number isn't. Are you noticing anything else — energy, sleep, how clothes fit?`;
                }
              }
            }
          } else {
            message = `Week ${weeksOn} on ${med}, ${user.first_name}! ${weeksOn} weeks in. The scale is just one way to measure this — how are your clothes fitting? How's your energy? How are you sleeping? Reply with one thing that's better than it was ${weeksOn} weeks ago.`;
          }
        } else {
          message = `Week ${weeksOn} on ${med}, ${user.first_name}! The scale is just one way to measure this — how are your clothes fitting? How's your energy? How are you sleeping? Reply with one thing that's better than it was ${weeksOn} weeks ago — I want to celebrate it.`;
        }

        // Streak bonus
        if (streak >= 7) {
          message += `\n\nBy the way — you've replied every day this week. That's not nothing. Consistency is literally the whole game. 🏆`;
        }

        await sendSMSOnly(user.phone, message);

        await supabase.from("check_ins").insert({
          user_id: user.id,
          type: "weekly_milestone",
          message_sent: message,
        });

        await supabase.from("users").update({
          last_milestone_sent_at: now.toISOString(),
        }).eq("id", user.id);

        sent++;
        console.log(`Weekly milestone sent to ${user.first_name} (week ${weeksOn}, streak ${streak})`);
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
