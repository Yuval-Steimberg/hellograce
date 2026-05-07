import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BATCH_SIZE = 20;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const OPENAI_API_KEY = Deno.env.get("Grace_Knowledg");
    if (!OPENAI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "Missing OpenAI API key (Grace_Knowledg)" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Fetch all rows missing embeddings
    const { data: rows, error: fetchErr } = await supabase
      .from("grace_knowledge")
      .select("id, user_message")
      .is("embedding", null);

    if (fetchErr) throw fetchErr;

    const total = rows?.length ?? 0;
    console.log(`Found ${total} rows needing embeddings`);

    if (total === 0) {
      return new Response(
        JSON.stringify({ success: true, processed: 0, total: 0, message: "Nothing to do" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let processed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = rows!.slice(i, i + BATCH_SIZE);
      const inputs = batch.map((r) => r.user_message);

      const resp = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: inputs,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`OpenAI error (batch starting ${i}):`, resp.status, errText);
        failed += batch.length;
        errors.push(`Batch ${i}: ${resp.status} ${errText.slice(0, 200)}`);
        continue;
      }

      const json = await resp.json();
      const embeddings: number[][] = json.data.map((d: any) => d.embedding);

      // Update each row with its embedding
      await Promise.all(
        batch.map(async (row, idx) => {
          const { error: updErr } = await supabase
            .from("grace_knowledge")
            .update({ embedding: embeddings[idx] as any })
            .eq("id", row.id);
          if (updErr) {
            console.error(`Update failed for ${row.id}:`, updErr.message);
            failed += 1;
            errors.push(`Row ${row.id}: ${updErr.message}`);
          } else {
            processed += 1;
          }
        })
      );

      console.log(`Processed ${processed}/${total} rows`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        total,
        processed,
        failed,
        errors: errors.slice(0, 10),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("generate_embeddings error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
