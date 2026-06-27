# iMessage channel (multi-channel delivery)

Grace runs on **WhatsApp/SMS (Twilio)** and **iMessage** at the same time. The AI
pipeline is transport-agnostic; a per-user `channel` decides how proactive
messages go out, and inbound replies always go back on the channel the message
arrived on.

## Architecture

```
Inbound
  WhatsApp/SMS → POST /webhook/twilio   → normalizeTwilio   ─┐
  iMessage     → POST /webhook/imessage → normalizeImessage ─┤→ processInboundMessage()  (shared)
                                                              └→ AIService → reply

Outbound (every send goes through one MessageSender)
  ChannelRouter.send(msg)
     msg.channel === 'imessage' → ImessageSender (LoopMessage relay)
     msg.channel === 'whatsapp'|'sms' → TwilioSender
     (imessage requested but unconfigured → falls back to Twilio WhatsApp, never silent)
```

Key files:
- `src/imessage/sender.ts` — `ImessageSender` (LoopMessage send contract; reuses the
  same `sanitizeOutbound` + `rewriteCanonicalLinks` as Twilio).
- `src/imessage/normalize.ts` — maps the relay's inbound payload → canonical `InboundMessage`.
- `src/imessage/signature.ts` — verifies the inbound webhook (shared-secret header or HMAC).
- `src/channel-router.ts` — `ChannelRouter` dispatches by `msg.channel`.
- `src/routes/webhook.ts` — `processInboundMessage()` (shared by both webhooks) + `/webhook/imessage`.
- `users.channel` column (migration `20260617000001_user_channel.sql`) — drives proactive sends.

## Providers: LoopMessage (default) or Sendblue

Grace's iMessage channel can run on **either** relay; pick one with
`IMESSAGE_PROVIDER` (`loopmessage` default, or `sendblue`). The two have
different API contracts, so each has its own sender + inbound normalizer:

| | LoopMessage (`loopmessage`) | Sendblue (`sendblue`) |
|---|---|---|
| Send URL | `server.loopmessage.com/api/v1/message/send/` | `api.sendblue.co/api/send-message` |
| Auth headers | `Authorization` + `Loop-Secret-Key` | `sb-api-key-id` + `sb-api-secret-key` |
| Send body | `{recipient, text, sender_name}` | `{number, content}` |
| Send id field | `message_id` | `message_handle` |
| Inbound fields | `recipient`, `text`, `attachments[]`, `alert_type` | `number`, `content`, `media_url`, `is_outbound` |
| Sender name | required | not used (sends from a provisioned line) |

`IMESSAGE_AUTH_KEY` / `IMESSAGE_SECRET_KEY` map to each provider's key pair.
Sendblue files: `src/imessage/sendblue-sender.ts`, `src/imessage/sendblue-normalize.ts`.
Both providers share `processInboundMessage`, the outbound sanitizer, and link rewriting.

## Free Sendblue sandbox — quickest way to test ($0)

Sendblue offers a **free API sandbox** (no card). Use it to validate the whole
inbound→reply→scheduled-send loop before paying for any sender:

1. Sign up at `docs.sendblue.com`, create a **sandbox API key** → note the
   `sb-api-key-id` and `sb-api-secret-key`.
2. Point the sandbox **inbound webhook** at `…/webhook/imessage` (your tunnel
   URL locally, or `https://grace-api.fly.dev/webhook/imessage`).
3. Set:
   ```bash
   IMESSAGE_PROVIDER=sendblue
   IMESSAGE_AUTH_KEY=<sb-api-key-id>
   IMESSAGE_SECRET_KEY=<sb-api-secret-key>
   # optional sandbox override; defaults to the production Sendblue send URL:
   # IMESSAGE_API_URL=https://api.sendblue.co/api/send-message
   ```
   (No `IMESSAGE_SENDER_NAME` needed for Sendblue.) Look for
   `imessage.channel.enabled` with `provider: "sendblue"` in the logs.
4. **Local test without an account** — inbound signature verification is only
   enforced when `NODE_ENV=production`, so you can POST a simulated Sendblue
   payload straight at the route:
   ```bash
   curl -X POST http://localhost:3001/webhook/imessage \
     -H 'Content-Type: application/json' \
     -d '{"number":"+15551234567","content":"had eggs for breakfast","message_handle":"sb-test-1"}'
   ```
   Watch Grace generate + "send" a reply end-to-end (the send hits the Sendblue
   sandbox when keys are set, or the Twilio fallback when iMessage is off).

## Why a relay (LoopMessage / Sendblue)

Apple has **no official iMessage send API**. A relay provider hosts a dedicated
iMessage sender and exposes a REST endpoint + inbound webhook. This is against
Apple's ToS and accounts can be throttled — treat iMessage as an *optional channel
layered on top of* WhatsApp/SMS, not a replacement. The router fails over to
WhatsApp if iMessage is unconfigured.

## Setup steps

1. **Create a LoopMessage (or Sendblue) account** and complete sender provisioning.
   Note your **auth key**, **secret key**, **dedicated sender name**, and the **send URL**.
2. **Point the provider's inbound webhook** at `https://grace-api.fly.dev/webhook/imessage`.
   Set a webhook secret in the provider dashboard.
3. **Set the Fly secrets:**
   ```bash
   fly secrets set --app grace-api \
     IMESSAGE_AUTH_KEY="<auth key>" \
     IMESSAGE_SECRET_KEY="<secret key>" \
     IMESSAGE_SENDER_NAME="<dedicated sender>" \
     IMESSAGE_WEBHOOK_SECRET="<inbound webhook secret>"
   # optional, defaults to LoopMessage's send URL:
   # IMESSAGE_API_URL="https://server.loopmessage.com/api/v1/message/send/"
   ```
   iMessage stays **OFF** until `IMESSAGE_AUTH_KEY` + `IMESSAGE_SECRET_KEY` +
   `IMESSAGE_SENDER_NAME` are all present (look for `imessage.channel.enabled` in logs).
4. **Apply the migration** in Supabase:
   ```sql
   ALTER TABLE public.users ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';
   ```
5. **Move a user to iMessage** (any of):
   - They simply text the iMessage relay → inbound aligns `channel='imessage'` automatically.
   - Admin dashboard → user → set Channel.
   - `PUT /admin/users/:phone` with `{ "channel": "imessage" }`.
6. **Test:** send an inbound iMessage, confirm Grace replies, then confirm a scheduled
   check-in fires on iMessage.

## Notes / limits

- **Inbound signature:** shared-secret header (LoopMessage default) is verified exactly;
  HMAC is verified against `JSON.stringify(body)` (best-effort — prefer the shared secret).
- **Verification is enforced only when `NODE_ENV=production`** (local testing accepts unsigned).
- **Media:** image/audio attachments are passed to the existing multimodal pipeline.
- WhatsApp/SMS behavior is **unchanged** when iMessage is off.
