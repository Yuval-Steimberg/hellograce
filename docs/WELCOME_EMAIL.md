# Welcome Email Template

Send this immediately after a user completes onboarding and payment.
Personalize the `{{FIRST_NAME}}`, `{{MEDICATION}}`, and `{{INJECTION_DAY}}` fields.

---

## Subject line options (A/B test these)

- `Grace is ready — here's what happens next`
- `Welcome to Grace, {{FIRST_NAME}} 👋`
- `Your GLP-1 companion just sent you a message`
- `You're all set — Grace will text you at {{WAKE_TIME}}`

---

## Email body

---

**From:** Grace `<hello@grace.com>`
**Subject:** Grace is ready — here's what happens next

---

Hi {{FIRST_NAME}},

You're in. Grace just sent you a welcome message on WhatsApp — check your phone.

Here's what to expect over the next few days.

---

**Today**

You should have already received a welcome message on WhatsApp. If you haven't, make sure you've saved Grace's number (+1 415 523 8886) to your contacts — WhatsApp sometimes filters messages from unsaved numbers.

Tomorrow morning at {{WAKE_TIME}}, Grace will send your first daily check-in. That's when your routine officially begins.

---

**Every day from here**

Grace will reach out on a schedule built around your life:

- **Morning** — a daily check-in to start your day right
- **Midday** (Mon, Wed, Fri) — a protein and hydration nudge
- **Evening** (Tue, Thu, Sun) — a gentle wind-down and mood check
- **{{INJECTION_DAY}}** — injection day flow: reminder, confirmation, next-day follow-up

You don't have to respond to every message. But the more you do, the more Grace personalizes everything for you.

---

**What you can text Grace any time**

You're not limited to the scheduled check-ins. Message Grace whenever you want:

- `"I just had grilled chicken and rice"` → Grace logs your food and tracks protein
- `"Feeling nauseous after my injection"` → Grace gives practical tips and follows up in 4 hours
- `"I weighed 192 lbs this morning"` → Grace logs it and shows your trend
- `"Why am I so tired after my injection?"` → Grace explains and reassures
- `"Done"` after injecting → Grace confirms and marks it in your profile

Just talk naturally. No commands to memorize.

---

**Your 3-day free trial**

Your trial runs until {{TRIAL_END_DATE}}. You won't be charged until then.

If you decide Grace isn't for you, cancel before {{TRIAL_END_DATE}} and you'll owe nothing. Just go to your Stripe receipt email and click "Manage subscription."

After the trial, your subscription continues automatically and you'll have full access to everything — all daily check-ins, unlimited chat, and your complete history.

---

**A few things worth knowing**

Grace is a support tool, not a replacement for your doctor or pharmacist. She's here to help you track, stay motivated, and learn — but always follow your prescriber's guidance for medical decisions.

If you ever want to delete your data entirely, just text Grace: `DELETE MY DATA`. Everything is wiped immediately.

---

Questions? Just reply to this email or text Grace directly on WhatsApp.

Here for you,
**The Grace Team**

---

*You're receiving this because you signed up at grace.com.
To unsubscribe from email updates, [click here](#). Grace will still message you on WhatsApp unless you text STOP.*

---

## Plain text version (for email clients that don't render HTML)

```
Hi {{FIRST_NAME}},

You're in. Grace just sent you a welcome message on WhatsApp.

WHAT HAPPENS NEXT

Tomorrow morning at {{WAKE_TIME}}, Grace sends your first daily check-in.
After that, you'll get:

- A morning check-in every day
- Midday nudges on Mon/Wed/Fri
- Evening wind-downs on Tue/Thu/Sun
- Your full injection day flow every {{INJECTION_DAY}}

TEXT GRACE ANY TIME

You're not limited to the scheduled messages. Just talk naturally:
- "I had grilled chicken and rice" → logs food, tracks protein
- "Feeling nauseous after my injection" → tips + 4hr follow-up
- "I weighed 192 lbs" → logged, trend shown
- "Done" after injecting → confirms your injection

YOUR FREE TRIAL

Your trial ends {{TRIAL_END_DATE}}. No charge until then.
To cancel: find your Stripe receipt email → "Manage subscription."

Questions? Reply to this email or text Grace on WhatsApp.

- The Grace Team

---
You signed up at grace.com. To unsubscribe: [link]
```

---

## Notes for implementation

- Send via your email provider (Postmark, Resend, or SendGrid recommended)
- Trigger: immediately on successful `POST /users/onboard` response
- Personalization fields: `FIRST_NAME`, `MEDICATION`, `INJECTION_DAY`, `WAKE_TIME`, `TRIAL_END_DATE`
- `TRIAL_END_DATE` = `trial_start + 3 days`, formatted as "Monday, May 12"
- Grace's WhatsApp number in the email should match `TWILIO_WHATSAPP_FROM` in your .env
- If using the Twilio sandbox number during testing, update the number in the email for production
