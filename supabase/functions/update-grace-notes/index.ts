import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { user_id } = await req.json();
    if (!user_id || typeof user_id !== "string") {
      return new Response(
        JSON.stringify({ error: "user_id required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Fetch user's current grace_notes
    const { data: user, error: userErr } = await supabase
      .from("users")
      .select("grace_notes")
      .eq("id", user_id)
      .maybeSingle();

    if (userErr || !user) {
      return new Response(
        JSON.stringify({ error: "user not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const currentNotes = user.grace_notes || "";

    // Fetch last 50 check-ins
    const { data: checkIns } = await supabase
      .from("check_ins")
      .select("type, message_sent, user_reply, created_at")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(50);

    const recentConvo = (checkIns || [])
      .reverse()
      .map((c) => {
        const parts: string[] = [];
        if (c.message_sent) parts.push(`Grace: ${c.message_sent}`);
        if (c.user_reply) parts.push(`User: ${c.user_reply}`);
        return parts.join("\n");
      })
      .filter(Boolean)
      .join("\n\n");

    const systemPrompt = `You are updating Grace's private notebook about a user. Grace is an AI wellness companion for women on GLP-1 medications.

Your job is to read the recent conversation history and update the notebook with anything new and important that Grace learned about this user.

The notebook should capture:
- Foods the user mentioned eating (beyond profile)
- Symptoms or side effects reported
- Emotional patterns (what makes her struggle, what makes her feel good)
- Wins and milestones mentioned
- Concerns or worries she expressed
- Any preferences, habits, or personal details she shared naturally in conversation

Keep the notebook under 300 words.
Write in third person past tense.
Only include things actually said, never infer or assume.
Merge with existing notes, don't replace, update.

EXISTING NOTES:
${currentNotes || "None yet."}

RECENT CONVERSATION:
${recentConvo}

Write the updated notebook now:`;

    const aiResp = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [{ role: "system", content: systemPrompt }],
        }),
      },
    );

    if (!aiResp.ok) {
      const t = await aiResp.text();
      console.error("AI gateway error:", aiResp.status, t);
      return new Response(
        JSON.stringify({ error: "AI gateway error", status: aiResp.status }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const aiData = await aiResp.json();
    const updatedNotes: string =
      aiData?.choices?.[0]?.message?.content?.trim() || "";

    if (!updatedNotes) {
      return new Response(
        JSON.stringify({ error: "empty AI response" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { error: updateErr } = await supabase
      .from("users")
      .update({ grace_notes: updatedNotes })
      .eq("id", user_id);

    if (updateErr) {
      console.error("Update error:", updateErr);
      return new Response(
        JSON.stringify({ error: "failed to save notes" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ success: true, notes: updatedNotes }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("update-grace-notes error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
