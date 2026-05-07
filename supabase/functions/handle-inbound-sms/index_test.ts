// End-to-end tests for the WhatsApp/SMS inbound webhook.
//
// Simulates Twilio posting to the deployed `handle-inbound-sms` function
// using the exact form-encoded payload Twilio sends for WhatsApp sandbox
// messages, and asserts the TwiML reply is what we expect.
//
// Covers:
//   1. Unknown WhatsApp number → "I don't recognize this number" reply
//   2. Registered user sending STOP → unsubscribe confirmation
//   3. Registered user sending HELP → support info reply
//   4. SMS-channel parity (no `whatsapp:` prefix) still routes correctly
//
// The test inserts a temporary user row via the service role, runs the
// assertions, then cleans up.

import "https://deno.land/std@0.224.0/dotenv/load.ts";
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const FN_URL = `${SUPABASE_URL}/functions/v1/handle-inbound-sms`;
const TWILIO_SANDBOX_TO = "whatsapp:+14155238886";

// Random unregistered phone we expect the function to NOT find.
const UNKNOWN_PHONE = "+15550001111";
// Test-user phone that we'll insert before the STOP/HELP tests.
const TEST_PHONE = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;

async function postInbound(form: Record<string, string>): Promise<{ status: number; body: string }> {
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      apikey: SUPABASE_ANON_KEY,
    },
    body: new URLSearchParams(form).toString(),
  });
  const body = await res.text();
  return { status: res.status, body };
}

Deno.test("unknown WhatsApp sender gets 'don't recognize' reply", async () => {
  const { status, body } = await postInbound({
    From: `whatsapp:${UNKNOWN_PHONE}`,
    To: TWILIO_SANDBOX_TO,
    Body: "hello",
  });
  assertEquals(status, 200);
  assertStringIncludes(body, "<Response>");
  assertStringIncludes(body, "<Message>");
  assertStringIncludes(body.toLowerCase(), "don't recognize");
});

Deno.test("unknown SMS sender (no whatsapp prefix) gets same reply", async () => {
  const { status, body } = await postInbound({
    From: UNKNOWN_PHONE,
    To: "+14155238886",
    Body: "hi",
  });
  assertEquals(status, 200);
  assertStringIncludes(body.toLowerCase(), "don't recognize");
});

Deno.test({
  name: "registered user STOP → unsubscribe TwiML reply",
  ignore: !SERVICE_ROLE,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE!, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 0 } },
    });
    const { data: user, error } = await admin
      .from("users")
      .insert({
        first_name: "TestE2E",
        phone: TEST_PHONE,
        medication: "ozempic",
        injection_day: "monday",
        timezone: "America/New_York",
      })
      .select()
      .single();
    assert(!error, `seed insert failed: ${error?.message}`);

    try {
      const { status, body } = await postInbound({
        From: `whatsapp:${TEST_PHONE}`,
        To: TWILIO_SANDBOX_TO,
        Body: "STOP",
      });
      assertEquals(status, 200);
      assertStringIncludes(body, "<Response>");
      assertStringIncludes(body.toLowerCase(), "unsubscribed");
    } finally {
      // Clean up: delete check_ins then user row.
      await admin.from("check_ins").delete().eq("user_id", user!.id);
      await admin.from("users").delete().eq("id", user!.id);
    }
  },
});

Deno.test({
  name: "registered user HELP → support info TwiML reply",
  ignore: !SERVICE_ROLE,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE!, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 0 } },
    });
    const phone = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
    const { data: user, error } = await admin
      .from("users")
      .insert({
        first_name: "TestE2E2",
        phone,
        medication: "wegovy",
        injection_day: "friday",
        timezone: "America/New_York",
      })
      .select()
      .single();
    assert(!error, `seed insert failed: ${error?.message}`);

    try {
      const { status, body } = await postInbound({
        From: `whatsapp:${phone}`,
        To: TWILIO_SANDBOX_TO,
        Body: "HELP",
      });
      assertEquals(status, 200);
      assertStringIncludes(body.toLowerCase(), "support@graceglp.com");
      assertStringIncludes(body.toLowerCase(), "stop");
    } finally {
      await admin.from("check_ins").delete().eq("user_id", user!.id);
      await admin.from("users").delete().eq("id", user!.id);
    }
  },
});
