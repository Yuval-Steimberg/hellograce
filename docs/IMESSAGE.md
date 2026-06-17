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
