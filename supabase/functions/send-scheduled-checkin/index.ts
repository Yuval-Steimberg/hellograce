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
  if (useWhatsApp && !TWILIO_FROM.startsWith("whatsapp:")) {
    TWILIO_FROM = `whatsapp:${TWILIO_FROM}`;
  }
  const toAddr = useWhatsApp && !to.startsWith("whatsapp:") ? `whatsapp:${to}` : to;

  const auth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const url = `${TWILIO_API_BASE}/${TWILIO_ACCOUNT_SID}/Messages.json`;

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
    console.error(`[sendSMSOnly] failed status=${response.status}`, data);
    throw new Error(`Twilio error [${response.status}]: ${JSON.stringify(data)}`);
  }
  return data;
}

function getCheckinSlots(
  wakeTime: string,
  sleepTime: string,
  countPerDay: number,
): number[] {
  const wakeHour = parseInt(wakeTime.split(":")[0]);
  const sleepHour = parseInt(sleepTime.split(":")[0]);
  const totalHours = sleepHour - wakeHour;

  if (countPerDay <= 1) return [wakeHour];

  const slots: number[] = [];
  const interval = totalHours / (countPerDay - 1);
  for (let i = 0; i < countPerDay; i++) {
    slots.push(Math.round(wakeHour + i * interval));
  }
  return slots;
}

function getUserLocalHour(timezone: string): number {
  const tz = timezone || "America/New_York";
  const localNow = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
  return localNow.getHours();
}

function getUserLocalWeekday(timezone: string): string {
  const tz = timezone || "America/New_York";
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: tz,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: users, error } = await supabase
      .from("users")
      .select(
        `id, first_name, phone, timezone, wake_time, sleep_time, goals,
         medication, injection_day, food_dislikes, current_weight, goal_weight,
         checkin_count_per_day, checkin_days_interval, last_reply_at,
         medication_frequency, grace_notes, is_paid, is_pro, trial_start,
         paused, blocked, active`,
      )
      .eq("active", true)
      .eq("paused", false)
      .eq("blocked", false);

    if (error) {
      console.error("Fetch users error:", error);
      return new Response(JSON.stringify({ error: "Failed to fetch users" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let sent = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const user of users || []) {
      try {
        const tz = user.timezone || "America/New_York";
        const localHour = getUserLocalHour(tz);

        const wakeTime = (user.wake_time || "07:00").toString().slice(0, 5);
        const sleepTime = (user.sleep_time || "22:00").toString().slice(0, 5);
        const countPerDay = user.checkin_count_per_day || 2;

        const slots = getCheckinSlots(wakeTime, sleepTime, countPerDay);

        const currentSlot = slots.find((s) => Math.abs(s - localHour) < 1);
        if (currentSlot === undefined) {
          skipped++;
          continue;
        }

        // Check if already sent this slot (within current hour window)
        const slotStart = new Date();
        slotStart.setHours(currentSlot, 0, 0, 0);
        const slotEnd = new Date();
        slotEnd.setHours(currentSlot + 1, 0, 0, 0);

        const { count: alreadySent } = await supabase
          .from("check_ins")
          .select("*", { count: "exact", head: true })
          .eq("user_id", user.id)
          .eq("type", "scheduled_checkin")
          .gte("created_at", slotStart.toISOString())
          .lt("created_at", slotEnd.toISOString());

        if (alreadySent && alreadySent > 0) {
          skipped++;
          continue;
        }

        // Skip if user texted in last 30 minutes
        const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
        if (user.last_reply_at && new Date(user.last_reply_at) > thirtyMinAgo) {
          console.log(`Skipping ${user.first_name} — active chat`);
          skipped++;
          continue;
        }

        // Check days interval — only fire on scheduled days
        if ((user.checkin_days_interval || 1) > 1) {
          const { data: lastSent } = await supabase
            .from("check_ins")
            .select("created_at")
            .eq("user_id", user.id)
            .eq("type", "scheduled_checkin")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (lastSent) {
            const daysSinceLast =
              (Date.now() - new Date(lastSent.created_at).getTime()) /
              (1000 * 60 * 60 * 24);
            if (daysSinceLast < (user.checkin_days_interval || 1) - 0.1) {
              skipped++;
              continue;
            }
          }
        }

        const slotIndex = slots.indexOf(currentSlot);
        const isFirstSlot = slotIndex === 0;
        const isLastSlot = slotIndex === slots.length - 1;

        const isInjectionDay =
          !!user.injection_day &&
          getUserLocalWeekday(tz) === user.injection_day;

        const goals: string[] = user.goals || [];
        const name = user.first_name;

        let message = "";

        if (isInjectionDay && slotIndex >= 1) {
          const injectionMessages = [
            `Injection day — have you done it yet?`,
            `How are you feeling after today's injection?`,
            `Any side effects from the injection today?`,
            `Drink extra water today — injection days need it. How are you holding up?`,
          ];
          message = injectionMessages[slotIndex % injectionMessages.length];
        } else if (goals.includes("Losing weight")) {
          const weightMessages = [
            isFirstSlot ? `Morning ${name}. What's your first protein hit today?` : null,
            `How's your eating going today?`,
            `Hit your protein goal yet?`,
            `Staying hydrated?`,
            `How are your energy levels today?`,
            `Any cravings hitting today?`,
            isLastSlot ? `How did today go with food?` : null,
          ].filter(Boolean) as string[];
          message = weightMessages[Math.floor(Math.random() * weightMessages.length)];
        } else if (goals.includes("Managing side effects")) {
          const sideEffectMessages = [
            `How's your stomach feeling today?`,
            `Any nausea or fatigue today?`,
            `Energy levels holding up?`,
            `How are you feeling overall today?`,
            `Any symptoms bothering you today?`,
          ];
          message =
            sideEffectMessages[Math.floor(Math.random() * sideEffectMessages.length)];
        } else {
          const generalMessages = [
            isFirstSlot ? `Morning ${name} — how are you today?` : null,
            `How are you feeling right now?`,
            `How's your day going?`,
            `Checking in — how are you holding up?`,
            isLastSlot ? `How was your day overall?` : null,
          ].filter(Boolean) as string[];
          message = generalMessages[Math.floor(Math.random() * generalMessages.length)];
        }

        // Don't repeat recent messages
        const { data: lastCheckins } = await supabase
          .from("check_ins")
          .select("message_sent")
          .eq("user_id", user.id)
          .eq("type", "scheduled_checkin")
          .order("created_at", { ascending: false })
          .limit(3);

        const recentMessages = (lastCheckins || []).map((c) => c.message_sent);
        if (recentMessages.includes(message)) {
          message = `How are you doing right now?`;
        }

        await sendSMSOnly(user.phone, message);
        await supabase.from("check_ins").insert({
          user_id: user.id,
          type: "scheduled_checkin",
          message_sent: message,
          slot_index: slotIndex,
        });

        console.log(
          `Sent slot ${slotIndex + 1}/${slots.length} to ${user.first_name}: "${message}"`,
        );
        sent++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error for user ${user.id}:`, msg);
        errors.push(`${user.id}: ${msg}`);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        sent,
        skipped,
        total: (users || []).length,
        errors: errors.length ? errors : undefined,
      }),
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
