# Grace — User Guide

Everything you need to know about using Grace on WhatsApp.

---

## What is Grace?

Grace is a personal AI companion for people on GLP-1 medications
(Ozempic, Wegovy, Mounjaro, Zepbound, and compounded versions).

You chat with Grace entirely over **WhatsApp** — no app to download, no account
to log in to. Grace sends you proactive daily check-ins and you can message
Grace any time with questions, food logs, or how you're feeling.

---

## How to get started

### Step 1 — Sign up

Go to the onboarding page (link from your invitation or grace.com/start).

You'll enter:
- Your first name
- Your WhatsApp phone number (including country code, e.g. +1 for US)
- Your GLP-1 medication and injection day
- Your wake time and sleep time (so Grace knows when to message you)
- Your current weight and goal weight (optional)
- Foods you dislike (optional — Grace won't suggest these)
- Your goals (e.g. "Lose weight", "Eat enough protein", "Stay hydrated")
- Your timezone

### Step 2 — Subscribe

After filling in your profile you'll be taken to the payment step.
You get a **3-day free trial** — no charge until day 4.
Cancel any time before then and you won't be charged anything.

### Step 3 — Wait for the welcome message

Within a few seconds of completing signup, Grace will send you a WhatsApp message.
That's it — you're set up.

---

## What to expect each day

Grace sends messages proactively based on your schedule. You don't have to do anything
to trigger these — they arrive automatically.

| Time | What Grace sends |
|---|---|
| Your wake time (every day) | Morning check-in — how are you feeling, ready for the day |
| 11am–2pm Mon / Wed / Fri | Midday nutrition nudge — protein check, hydration reminder |
| 90 min before sleep Tue / Thu / Sun | Evening wind-down — mood check, reflection |
| Your injection day morning | Injection reminder — "Time for your weekly injection" |
| After you confirm injection | Follow-up — any side effects? |
| Day after injection | How did it go? any nausea or tiredness? |

**Grace adapts to you over time:**
- If you never reply to midday messages, Grace stops sending them
- If your mood scores trend low, Grace becomes gentler and more supportive
- The more you chat, the more personalized the responses become

---

## Talking to Grace

You can message Grace any time, about anything related to your GLP-1 journey.
There's no command syntax — just talk naturally.

### Logging food

Just describe what you ate. Grace estimates protein and calories automatically.

```
You:   I just had grilled chicken with a side salad and olive oil
Grace: Logged! That's roughly 42g protein and 520 calories.
       You've hit 68g protein today — 12g short of your 80g goal.
       Great choice for a GLP-1 day 💪
```

```
You:   Had a protein shake — Fairlife, chocolate, 230ml
Grace: Logged! 30g protein, 150 calories.
       You've hit your protein goal for today — nice work!
```

### Logging your weight

```
You:   I weighed 196 lbs this morning
Grace: Logged! That's down 2 lbs from last week.
       You're making steady progress — 11 lbs to go.
```

### Logging your mood

```
You:   Feeling a bit off today, maybe 5/10
Grace: Thanks for sharing. GLP-1 medications can sometimes affect mood,
       especially in the first few weeks. How's your hydration been?
```

### Asking questions

```
You:   Why do I feel so tired the day after my injection?
Grace: That's very common with semaglutide. The fatigue usually peaks
       24–36 hours after injection and fades by day 2–3...
```

```
You:   What should I eat on injection day to avoid nausea?
Grace: On injection day, smaller portions work better than large meals.
       Bland, low-fat foods like rice, toast, or plain chicken are easiest
       to tolerate. Avoid high-fat or spicy food for the first 12 hours...
```

```
You:   I'm not losing weight anymore, been stuck for 3 weeks
Grace: Plateaus are normal and frustrating. Let me look at your recent data...
       [checks your food logs and weight history]
       Your protein has been low this week (avg 52g vs your 80g goal).
       Hitting protein helps preserve muscle and can break a plateau.
       Want me to suggest some easy high-protein meals?
```

### Reporting side effects

```
You:   I've been feeling really nauseous since my injection yesterday
Grace: Sorry you're dealing with that — nausea is the most common side effect
       with Ozempic, especially in the first months or after a dose increase.
       [practical tips]
       I'll check in with you in a few hours to see how you're feeling.
```

Grace will automatically follow up 4 hours later.

### Confirming your injection

On your injection day, Grace sends a morning reminder. After you inject:

```
You:   Done
Grace: Great — logged your injection! Any side effects so far?
```

Grace understands: `done`, `done!`, `injected`, or any natural confirmation.

---

## Subscription and billing

| Plan | Cost | What you get |
|---|---|---|
| Free trial | Free for 3 days | Full access to everything |
| Standard | Monthly subscription | Full AI responses + all daily check-ins |
| Pro | Monthly subscription | Same as Standard + priority support |

**How billing works:**
- You enter your card at signup
- No charge for 3 days
- On day 4, the subscription activates and your card is charged
- You can cancel any time — go to your email receipt from Stripe and click "Manage subscription"

**If your trial expires without subscribing:**
Grace will send you one message letting you know your trial ended and how to subscribe.
She won't send proactive messages or respond to new messages until you subscribe.

---

## Privacy — your data

**What Grace stores:**
- Your profile (name, phone, medication, goals, weight)
- Your message history with Grace
- Food logs, weight logs, mood scores, side effect reports

**What Grace never does:**
- Share your data with third parties
- Use your data to train external AI models
- Store payment information (Stripe handles that separately)

**To delete all your data:**

Text Grace: `DELETE MY DATA`

Or call the deletion endpoint directly:
```
DELETE https://api.grace.com/users/+1YOURNUMBER/data
```

Everything is permanently deleted — messages, logs, profile, embeddings. This cannot be undone.

---

## Tips for getting the most out of Grace

**Log food right after eating.** The more you log, the better Grace can spot patterns.
Even approximate descriptions work — "a bowl of pasta" is fine.

**Reply to the check-ins.** Even a one-word reply helps Grace understand how you're doing.
Silence isn't counted as a negative, but engagement improves personalization.

**Be honest about how you feel.** Grace isn't judging you. If you ate something off-plan
or skipped your injection, just say so — Grace responds supportively, not critically.

**Ask follow-up questions.** If a response isn't quite right, ask Grace to clarify or
go deeper. Grace remembers the full conversation.

**Use natural language.** You don't need to type commands. "I weighed myself, 189 lbs"
works just as well as "log weight 189".

---

## If Grace says something wrong

If a response is inaccurate or unhelpful, just tell Grace:

```
You:   That advice doesn't seem right — my doctor said I should be eating more fat
Grace: You're right to check with your doctor — they know your full picture.
       GLP-1 guidelines around fat can vary. What has your doctor recommended?
```

Grace will adjust. For medical decisions, always defer to your doctor or pharmacist —
Grace is a support tool, not a replacement for professional medical advice.

---

## Common questions

**Why haven't I received a morning message yet?**
Check that your wake time and timezone were set correctly during onboarding.
Grace sends the morning check-in at your wake time. If you signed up after your wake
time today, the first one comes tomorrow.

**I missed a check-in — can I catch up?**
You can message Grace any time and she'll respond. There's no "catch up" for
missed proactive messages — they don't stack up.

**Can I change my injection day?**
Yes — message Grace: "My injection day changed to Thursday" and she'll update your profile.
Or ask your operator to update it in the admin dashboard.

**Can I pause messages while I'm traveling?**
Message Grace: "I'm traveling for a week, please pause check-ins" — Grace will note it.
For a hard pause, ask your operator to pause your account in the dashboard.

**Does Grace work in languages other than English?**
Grace is optimized for English. She can understand and respond in other languages
to some degree, but accuracy is best in English.

**How do I cancel?**
Go to the Stripe receipt email you received at signup → "Manage subscription" → Cancel.
Your access continues until the end of the billing period.

---

## Emergency and crisis situations

If you're in crisis or having a medical emergency, **contact emergency services or
your doctor immediately** (call 911 or your local emergency number).

Grace will not delay that message — she recognizes crisis language and immediately
provides emergency resources without asking follow-up questions.

Grace is not a crisis service and cannot call for help on your behalf.
