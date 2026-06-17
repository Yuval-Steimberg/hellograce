import { GoogleGenerativeAI, type Part } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Logger } from 'pino';
import type { MessageMedia } from '@grace/shared';

const TWILIO_FETCH_TIMEOUT_MS = 8_000;

/** True for "model not found / unavailable" — mirrors the GeminiProvider check
 *  so the multimodal path can fall back instead of silently returning null when
 *  the primary model (e.g. a Gemini 3 id) isn't enabled on the active key. */
function isModelNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ((err as { status?: number }).status === 404) return true;
  const message = (err as { message?: string }).message ?? '';
  return /404|not found|no longer available|is not supported|not exist/i.test(message);
}

/** Run generateContent on the primary model; if it 404s (model unavailable on
 *  this key), retry once on the known-good fallback model. Mirrors callGemini's
 *  fast-fallback so switching GEMINI_MODEL to Gemini 3 never dark-fails photos. */
async function generateContentWithFallback(
  client: GoogleGenerativeAI,
  models: { primary: string; fallback?: string },
  parts: Array<string | Part>,
  logger: Logger,
): ReturnType<ReturnType<GoogleGenerativeAI['getGenerativeModel']>['generateContent']> {
  try {
    return await client.getGenerativeModel({ model: models.primary }).generateContent(parts);
  } catch (err) {
    if (models.fallback && models.fallback !== models.primary && isModelNotFound(err)) {
      logger.warn({ from: models.primary, to: models.fallback }, 'multimodal.model_not_found.fallback');
      return await client.getGenerativeModel({ model: models.fallback }).generateContent(parts);
    }
    throw err;
  }
}

export async function analyzeMedia(
  media: MessageMedia[],
  opts: { apiKey: string; model: string; fallbackModel?: string; logger: Logger; twilio?: { sid: string; token: string } },
): Promise<string | null> {
  if (media.length === 0) return null;
  const first = media[0]!;
  const models = { primary: opts.model, fallback: opts.fallbackModel };

  try {
    const buf = await fetchMedia(first.url, opts.twilio);
    const client = new GoogleGenerativeAI(opts.apiKey);
    // Strip codec/charset parameters from MIME type (e.g. "image/jpeg; name=foo" → "image/jpeg")
    // Gemini inline data only accepts the base MIME type without parameters.
    const cleanMime = first.contentType.split(';')[0]!.trim();
    const inlineData = { data: buf.toString('base64'), mimeType: cleanMime };

    if (first.kind === 'image') {
      // Pass 1: classify the image and — for food — produce a detailed visual
      // identification of items + quantities (NO macro calculation yet).
      // Body and Other analyses are fully resolved in this single pass.
      const r1 = await generateContentWithFallback(client, models, [
        { inlineData },
        { text: IMAGE_CLASSIFY_AND_IDENTIFY_PROMPT },
      ], opts.logger);
      const pass1 = r1.response.text().trim();

      // Pass 2 (food only): scientific macro calculation from the Pass 1
      // identification using the embedded USDA reference table.
      // Body and Other use Pass 1 output directly — no change in their path.
      if (pass1.includes('IMAGE_TYPE: food')) {
        try {
          const r2 = await generateContentWithFallback(client, models, [
            { text: buildFoodMacroCalculationPrompt(pass1) },
          ], opts.logger);
          const pass2 = r2.response.text().trim();
          // Validate that Pass 2 returned the required format; fall back to Pass 1 if not.
          if (pass2.includes('IMAGE_TYPE: food') && pass2.includes('TOTAL:')) {
            return pass2;
          }
        } catch {
          // If Pass 2 fails for any reason, fall through to return Pass 1 result.
        }
      }

      return pass1;
    }

    if (first.kind === 'audio') {
      return await transcribeAudioViaFileApi(buf, first.contentType, opts.apiKey, models, opts.logger);
    }

    return null;
  } catch (err) {
    opts.logger.error(
      {
        err,
        mediaKind: first.kind,
        contentType: first.contentType,
        hasTwilioAuth: !!opts.twilio,
        urlHost: (() => { try { return new URL(first.url).host; } catch { return 'unknown'; } })(),
      },
      'multimodal.analyze.failed',
    );
    return null;
  }
}

async function transcribeAudioViaFileApi(
  buf: Buffer,
  contentType: string,
  apiKey: string,
  models: { primary: string; fallback?: string },
  logger: Logger,
): Promise<string | null> {
  // Strip codec parameters (e.g. "audio/ogg; codecs=opus" → "audio/ogg") so
  // Gemini File API accepts the MIME type without error.
  const baseMime = contentType.split(';')[0]!.trim();
  const ext = baseMime.includes('ogg') ? 'ogg' : baseMime.includes('mp4') ? 'mp4' : baseMime.includes('webm') ? 'webm' : baseMime.includes('mpeg') ? 'mp3' : 'ogg';
  const tempPath = join(tmpdir(), `grace-audio-${Date.now()}.${ext}`);

  try {
    writeFileSync(tempPath, buf);

    const fileManager = new GoogleAIFileManager(apiKey);
    const upload = await fileManager.uploadFile(tempPath, {
      mimeType: baseMime,
      displayName: 'voice-note',
    });

    const client = new GoogleGenerativeAI(apiKey);
    const r = await generateContentWithFallback(client, models, [
      { fileData: { mimeType: baseMime, fileUri: upload.file.uri } },
      { text: 'Transcribe this voice note exactly as spoken. Output only the spoken words, no preamble, no quotes.' },
    ], logger);

    void fileManager.deleteFile(upload.file.name).catch((e) => logger.warn({ e }, 'gemini.file.delete.failed'));

    return r.response.text().trim();
  } finally {
    try { unlinkSync(tempPath); } catch { /* ignore */ }
  }
}

// ─── Image analysis prompts ───────────────────────────────────────────────────

/**
 * Pass 1 — classify the image and produce a detailed visual identification.
 *
 * FOOD path: lists every visible item with precise visual-anchor-based quantity
 *   estimates. Macro calculation is intentionally deferred to Pass 2 so the
 *   model can focus purely on visual recognition here.
 *
 * BODY and OTHER paths: fully resolved in this pass (unchanged behaviour).
 */
const IMAGE_CLASSIFY_AND_IDENTIFY_PROMPT = `Examine this image carefully. Decide if it shows FOOD, a BODY (person/selfie/progress photo), or OTHER.

═══════════════════════════════════
If FOOD — produce a detailed visual identification ONLY (no macro numbers):
IMAGE_TYPE: food

For each distinct food item visible, output one ITEM block:
ITEM_NAME: [specific name — include preparation/cooking method, e.g. "grilled chicken breast, skin removed" not just "chicken"]
ITEM_QTY: [estimated cooked/as-eaten weight in grams, derived from the visual anchors below. Always state your reasoning in parentheses, e.g. "(palm-sized piece on 27cm plate ≈ 140g cooked)"]
ITEM_COOKING: [grilled | baked | fried | steamed | boiled | raw | stir-fried | unknown]
ITEM_DETAILS: [visible details that affect nutrition: sauce on top, skin on/off, bone-in/out, mixed dish vs. identifiable pieces, visible fat]

List EVERY food item separately. For mixed dishes (curry, soup, stir-fry): list the major components as separate items with estimated quantities.

VISUAL ANCHORS — use these to estimate portions:
• Standard dinner plate = 25–27 cm diameter. A flat full plate holds ~600–900 g total.
• Side/salad plate = 20 cm. Lunch plate = 22 cm.
• Standard cereal/pasta bowl = 300–500 mL = ~300–500 g liquid, ~200–350 g solid.
• Deep soup bowl = 400–600 mL.
• 1 chicken breast (restaurant-sized) = 150–200 g raw = ~115–155 g cooked.
• Palm-sized piece of protein = ~85–100 g cooked (standard single serving).
• Egg (large) = ~50 g whole | egg white only = ~30 g.
• 1 cup cooked rice (mound ~10 cm wide on plate) = ~180 g.
• 1 cup cooked pasta = ~130 g.
• 1 cup cooked lentils/beans = ~200 g.
• Slice of bread = ~28–35 g.
• If a smartphone is visible in frame, use it as a 14–16 cm scale reference.

After all items, output:
SCALE_REF: [what you used to estimate portion sizes, e.g. "standard dinner plate visible" or "no scale reference — estimated from food density and proportion"]
CONFIDENCE: [high | medium | low]
CONFIDENCE_REASON: [one clear phrase, e.g. "individual pieces easily countable, plate visible" or "stacked/hidden layers, no clear scale reference" or "blurry image"]

═══════════════════════════════════
If BODY — provide a richer, GLP-1-aware analysis. This is for a user on weight-loss medication, often sharing something vulnerable. The goal is specific, observant, kind. Never clinical, never numeric.

IMAGE_TYPE: body
PHOTO_KIND: [full_body_progress | mirror_selfie | face_or_portrait | partial_body (just legs/arms/midsection) | gym_or_workout | other_body]

QUALITY: [clear | dim | blurry | odd_angle | partially_obscured]
QUALITY_NOTE: [one short phrase only if quality is anything other than "clear", e.g. "lighting low, hard to see definition" or "angle hides midsection". Empty string if clear.]

VISIBLE_DETAILS: [3–5 SPECIFIC concrete things you actually see. Each must be observable in the photo — no invention. Examples of GOOD specifics:
  - "shoulders sitting square and relaxed"
  - "visible deltoid line on the right arm"
  - "jawline more defined than typical baseline"
  - "posture upright, weight evenly distributed"
  - "collarbone visible at the neckline"
  - "calf shape shows muscle preservation"
  - "face looks rested, eyes bright"
  - "stance confident, hand on hip"
  - "midsection silhouette has slimmed"
Examples of BAD vague observations (DO NOT use):
  - "you look great" (no specific anchor)
  - "looking healthy" (clinical-sounding, vague)
  - "good progress" (assumes progress without seeing baseline)]

MUSCLE_PRESERVATION: [1 sentence on what's visible re: muscle tone — critical for GLP-1 users who risk lean mass loss. Anchor to a specific visible body part if possible: arms, shoulders, calves, forearms, traps. If muscle definition isn't visible (e.g. fully clothed, distant shot), say so plainly: "muscle definition not visible in this photo".]

EMOTIONAL_TONE: [What kind of moment is this for the user? Pick ONE: celebrating_a_change | vulnerable_share | mid_journey_check | gym_or_effort | uncertain_about_self | casual_selfie. This guides Grace's warmth dial.]

ENCOURAGEMENT: [1–2 warm sentences that reference at least one specific item from VISIBLE_DETAILS. Acknowledge the act of sharing if EMOTIONAL_TONE = vulnerable_share. Never use the word "progress" unless there's an obvious before/after element visible.]

HARD GUARDRAILS for BODY analysis — non-negotiable:
✗ Never estimate body fat %, BMI, weight, or any number
✗ Never use clinical/medical terms: submental, malar, periocular, sub-zygomatic, subcutaneous, laxity, anthropometric, morphology
✗ Never diagnose pain, injury, posture problems, scoliosis, lordosis, swelling, edema
✗ Never compare to an "ideal" body type
✗ Never comment on "fat", "loose skin", "saggy", "gaunt", "thin", "skinny" — even positively
✗ Never invent a before/after if no baseline photo was provided
✗ Never speculate about facial fat loss ("Ozempic face") unless the user raised it
✗ Never recommend procedures, products, fillers, treatments, surgery
✗ Never comment on visible undergarments, body parts the user didn't show on purpose, or anything that reads as inappropriate
✓ DO acknowledge the vulnerability of sharing a body photo (one short line is enough)
✓ DO call out visible muscle preservation — it's one of the most important GLP-1 wins
✓ DO note posture/confidence cues if visible — they're real progress signals not tied to a scale

═══════════════════════════════════
If OTHER:
IMAGE_TYPE: other
DESCRIPTION: [1 short sentence describing what the image shows]

═══════════════════════════════════
RULES (all image types):
- FOOD: Never invent items not visible. Count individual pieces. Use visual anchors above for quantities.
- BODY: Follow the BODY rubric and HARD GUARDRAILS above. Every VISIBLE_DETAIL must be anchored to something actually in the photo — no invention. If muscle isn't visible, say so plainly. Quality flag honestly so Grace can offer a retake if needed.
- OTHER: Describe only what you clearly see, no speculation.`;

/**
 * USDA protein reference (g protein per 100 g of food, prepared/as-eaten).
 * Used in Pass 2 scientific macro calculation.
 * Source: USDA FoodData Central (FDC).
 */
const USDA_PROTEIN_TABLE = `
USDA PROTEIN REFERENCE — g protein per 100 g (prepared/as-eaten)

POULTRY & MEAT
Chicken breast, grilled/baked, no skin: 31g | Chicken breast, fried: 27g
Chicken thigh, cooked, no skin: 26g | Chicken thigh, cooked, with skin: 22g
Turkey breast, roasted: 29g | Ground beef 85% lean, cooked: 26g
Ground beef 90% lean, cooked: 28g | Beef sirloin, lean, cooked: 31g
Pork tenderloin, roasted: 29g | Pork chop, lean, cooked: 25g
Ham, cured, roasted: 22g | Bacon, cooked: 37g

SEAFOOD
Salmon, cooked: 25g | Tuna, canned in water (drained): 26g
Tuna, fresh, cooked: 30g | Shrimp, cooked: 24g
Tilapia, cooked: 26g | Cod, cooked: 23g
Sardines, canned in oil: 25g | Halibut, cooked: 27g

EGGS & DAIRY
Egg, whole hard-boiled: 13g (1 large egg ~50g = ~6.5g protein)
Egg white, cooked: 11g | Greek yogurt, plain non-fat: 10g
Greek yogurt, plain full-fat: 9g | Cottage cheese 2%: 11g
Cheddar cheese: 25g | Mozzarella: 22g | Ricotta, whole milk: 11g
Milk, whole: 3.4g | Milk, 2%: 3.3g

PLANT PROTEINS
Tofu, firm: 17g | Tofu, silken/soft: 8g | Tempeh: 19g
Edamame, shelled, boiled: 11g | Lentils, cooked: 9g
Chickpeas, cooked: 9g | Black beans, cooked: 9g
Kidney beans, cooked: 9g | Pinto beans, cooked: 9g
Peanut butter: 25g | Almond butter: 21g | Hummus: 8g
Hemp seeds: 32g | Pumpkin seeds, roasted: 30g | Almonds: 21g

GRAINS & STARCHES
White rice, cooked: 2.7g | Brown rice, cooked: 2.6g
Quinoa, cooked: 4g | Pasta (white), cooked: 5g
Pasta (whole wheat), cooked: 5.3g | Oatmeal, cooked: 2.4g
Bread, white: 8g | Bread, whole wheat: 13g
Tortilla, flour (25cm): ~5g per tortilla (~45g) = 2.3g/100g

VEGETABLES & FRUIT
Broccoli, cooked: 3g | Spinach, cooked: 3g | Peas, cooked: 5g
Corn, cooked: 3g | Potato, baked: 2.5g | Sweet potato, baked: 2g
Avocado: 2g | Banana: 1.1g | Apple: 0.3g

COOKING WEIGHT FACTORS (raw → cooked weight loss):
Chicken/turkey: cooked = ~73% of raw weight (200g raw → ~146g cooked)
Beef/pork: cooked = ~70–75% of raw weight
Fish/seafood: cooked = ~80% of raw weight
Eggs: minimal change (~95% weight retention)
Rice: cooked = ~3× raw (100g raw → ~300g cooked)
Pasta/lentils/beans: cooked = ~2–2.5× raw weight`;

/**
 * Build the Pass 2 prompt: takes Pass 1 visual identification and calculates
 * macros scientifically using the USDA reference table.
 * Text-only — no image needed in this pass.
 */
function buildFoodMacroCalculationPrompt(pass1Output: string): string {
  return `You are a registered dietitian calculating precise macros from a food identification report.
Use ONLY the provided USDA reference table — do not use other values.

${USDA_PROTEIN_TABLE}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VISUAL IDENTIFICATION REPORT (from image analysis):
${pass1Output}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CALCULATION METHODOLOGY — follow exactly:
1. For each ITEM_NAME + ITEM_QTY in the report above:
   a. Identify the closest match in the USDA table
   b. Calculate: protein_g = (weight_g ÷ 100) × protein_per_100g_from_table
   c. Estimate carbs and fat proportionally from standard USDA values
   d. Calculate calories: (protein_g × 4) + (carbs_g × 4) + (fat_g × 9)
   e. Round all values to nearest 0.5g / kcal
2. Sum all items for TOTAL
3. Cross-check: does the TOTAL protein seem reasonable for what was described? If not, explain in NOTES.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT — use EXACTLY this format (required by the downstream parser):
IMAGE_TYPE: food
ITEMS: [comma-separated list of all items with quantities, e.g. "grilled chicken breast 140g, brown rice 180g, steamed broccoli 80g"]
BREAKDOWN:
- [item name + qty]: protein Xg, carbs Xg, fat Xg, cal Xkcal  ← one line per item
TOTAL: protein Xg | carbs Xg | fat Xg | calories Xkcal
CONFIDENCE: [copy from identification report: high | medium | low]
CONFIDENCE_REASON: [copy from identification report]
NOTES: [protein adequacy note for a GLP-1 user, e.g. "Good protein hit — solid towards daily target" or "Light on protein — pairing with yogurt or cottage cheese later would help"]
CALCULATION_NOTES: [USDA matches used and any assumptions, e.g. "Chicken matched to 'grilled breast no skin 31g/100g', estimated 140g cooked from palm-size reference"]

Output NOTHING else. No markdown, no preamble, no explanation outside the format above.`;
}

async function fetchMedia(url: string, twilio?: { sid: string; token: string }): Promise<Buffer> {
  const headers: Record<string, string> = {};
  if (twilio) {
    headers.Authorization = `Basic ${Buffer.from(`${twilio.sid}:${twilio.token}`).toString('base64')}`;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TWILIO_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers, signal: ac.signal });
    if (!resp.ok) throw new Error(`media fetch ${resp.status} for ${url}`);
    return Buffer.from(await resp.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}
