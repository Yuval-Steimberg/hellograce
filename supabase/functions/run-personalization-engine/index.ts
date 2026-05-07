import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: users, error } = await supabase
      .from("users")
      .select("*")
      .eq("active", true)
      .eq("paused", false);

    if (error) throw error;

    const now = new Date();
    let updated = 0;

    for (const user of users || []) {
      // Only run for users who've been on the program 4+ weeks
      const trialStart = new Date(user.trial_start);
      const weeksOn = Math.floor((now.getTime() - trialStart.getTime()) / (7 * 86400000));
      if (weeksOn < 4) continue;

      const fourWeeksAgo = new Date(now.getTime() - 28 * 86400000);
      const twoWeeksAgo = new Date(now.getTime() - 14 * 86400000);

      // Fetch recent check-ins (last 4 weeks)
      const { data: checkIns } = await supabase
        .from("check_ins")
        .select("type, mood_score, protein_logged, water_logged, user_reply, created_at")
        .eq("user_id", user.id)
        .gte("created_at", fourWeeksAgo.toISOString())
        .order("created_at", { ascending: false });

      if (!checkIns || checkIns.length === 0) continue;

      const flags: Record<string, boolean> = {};

      // === PROTEIN FOCUS BOOST ===
      // If user consistently logs low/no protein → boost protein morning messages
      const morningCheckins = checkIns.filter((c) => c.type === "morning_checkin");
      const proteinLogged = morningCheckins.filter((c) => c.protein_logged);
      const proteinRate = morningCheckins.length > 0 ? proteinLogged.length / morningCheckins.length : 1;
      flags.protein_focus_boost = proteinRate < 0.3; // less than 30% of mornings have protein logged

      // === HYDRATION STRUGGLE ===
      // If user never reports water intake
      const waterLogged = checkIns.filter((c) => c.water_logged === true);
      const hydrationCheckins = checkIns.filter((c) =>
        c.type === "morning_checkin" || c.type === "midday_nudge"
      );
      const waterRate = hydrationCheckins.length > 0 ? waterLogged.length / hydrationCheckins.length : 1;
      flags.hydration_struggle = waterRate < 0.15; // almost never logs water

      // === LOW MOOD MODE ===
      // If mood scores average below 5 for 2+ consecutive weeks
      const recentMoods = checkIns
        .filter((c) => c.mood_score !== null && new Date(c.created_at) >= twoWeeksAgo)
        .map((c) => c.mood_score!);
      if (recentMoods.length >= 3) {
        const avgMood = recentMoods.reduce((a, b) => a + b, 0) / recentMoods.length;
        flags.low_mood_mode = avgMood < 5;
      }

      // === MIDDAY SKIP ===
      // If user never replies to midday messages but always replies to morning
      const middayCheckins = checkIns.filter((c) => c.type === "midday_nudge");
      const middayReplies = middayCheckins.filter((c) => c.user_reply);
      const middayReplyRate = middayCheckins.length >= 4
        ? middayReplies.length / middayCheckins.length
        : 1; // not enough data, default to keeping midday

      const morningReplies = morningCheckins.filter((c) => c.user_reply);
      const morningReplyRate = morningCheckins.length > 0
        ? morningReplies.length / morningCheckins.length
        : 0;

      // Skip midday if they almost never reply to midday but consistently reply to morning
      flags.midday_skip = middayCheckins.length >= 4 && middayReplyRate < 0.15 && morningReplyRate > 0.5;

      // === INJECTION SIDE EFFECT FREE ===
      // If injection day replies consistently report no side effects → shorten flow
      const { data: injections } = await supabase
        .from("injections")
        .select("side_effects_reported")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(4);

      if (injections && injections.length >= 4) {
        const allClear = injections.every(
          (inj) => !inj.side_effects_reported || inj.side_effects_reported === "none"
        );
        flags.injection_side_effect_free = allClear;
      }

      // Only update if any flag actually changed
      const changed: Record<string, boolean> = {};
      let hasChange = false;
      for (const [key, val] of Object.entries(flags)) {
        if ((user as any)[key] !== val) {
          changed[key] = val;
          hasChange = true;
        }
      }

      if (hasChange) {
        await supabase.from("users").update(changed).eq("id", user.id);
        updated++;
      }
    }

    return new Response(
      JSON.stringify({ success: true, users_analyzed: users?.length || 0, users_updated: updated }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
