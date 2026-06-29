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
    const fetched = await fetchMedia(first.url, opts.twilio);
    const buf = fetched.buf;
    const client = new GoogleGenerativeAI(opts.apiKey);
    // Resolve the effective MIME type. Strip codec/charset params (e.g.
    // "image/jpeg; name=foo" → "image/jpeg"). Prefer the webhook-declared type,
    // then the HTTP response's content-type header, then a magic-byte sniff —
    // so iMessage media with NO declared content-type still gets a valid MIME
    // (Gemini rejects empty/octet-stream inline data, which dark-failed photos).
    const baseMime = (m: string): string => m.split(';')[0]!.trim().toLowerCase();
    const declared = baseMime(first.contentType);
    const httpMime = baseMime(fetched.contentType);
    const sniffed = sniffMimeFromBytes(buf);
    const usable = (m: string): boolean => m.length > 0 && m !== 'application/octet-stream' && m !== 'binary/octet-stream';
    const cleanMime = [declared, httpMime, sniffed].find(usable) ?? sniffed ?? '';

    // Resolve the effective kind. The normalizer guesses kind from the URL
    // extension; a signed/extensionless iMessage URL yields 'other', which would
    // skip analysis entirely. The resolved MIME (declared/header/sniffed) is
    // authoritative — trust it over the extension guess so the media is analyzed
    // as what it actually IS (image vs audio), not what the URL implied.
    let kind = first.kind;
    if (cleanMime.startsWith('image/')) kind = 'image';
    else if (cleanMime.startsWith('audio/')) kind = 'audio';

    // Final MIME fallback by kind when sniffing failed (e.g. an image we know is
    // an image but couldn't fingerprint) — JPEG is the safe default Gemini takes.
    const effectiveMime = cleanMime || (kind === 'image' ? 'image/jpeg' : kind === 'audio' ? 'audio/mpeg' : '');
    const inlineData = { data: buf.toString('base64'), mimeType: effectiveMime };

    if (kind === 'image') {
      // SINGLE vision pass: classify the image and, for food, identify items +
      // estimate protein + judge whether it's an eaten meal (vs. ambiguous
      // produce/groceries) in one call. The inline anchors keep the estimate
      // realistic (the old split pass over-counted, e.g. a fruit bowl → 22g).
      const r1 = await generateContentWithFallback(client, models, [
        { inlineData },
        { text: IMAGE_CLASSIFY_AND_IDENTIFY_PROMPT },
      ], opts.logger);
      return r1.response.text().trim();
    }

    if (kind === 'audio') {
      return await transcribeAudioViaFileApi(buf, effectiveMime, opts.apiKey, models, opts.logger);
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
 * Single-pass image analysis prompt — classifies the image and fully resolves it.
 *
 * FOOD path: identifies items, estimates protein from inline USDA anchors, judges
 *   MEAL_STATUS (eaten_meal vs. ambiguous), and emits an ASK question for the
 *   ambiguous case so the reply path can confirm before logging.
 * BODY and OTHER paths: rubric-based analysis, fully resolved here.
 */
const IMAGE_CLASSIFY_AND_IDENTIFY_PROMPT = `Examine this image carefully. Decide if it shows FOOD, a BODY (person/selfie/progress photo), or OTHER.

═══════════════════════════════════
If FOOD — identify the items, estimate protein, and judge whether it's an eaten meal. Output EXACTLY this format (a downstream parser depends on it):
IMAGE_TYPE: food
MEAL_STATUS: [eaten_meal | ambiguous]
ITEMS: [comma-separated items with estimated as-eaten weight, e.g. "grilled chicken breast 140g, brown rice 180g, steamed broccoli 80g". For loose produce, give a sensible single serving, e.g. "banana 1 medium 120g".]
TOTAL: protein Xg | calories Xkcal
CONFIDENCE: [high | medium | low]
ASK: [ONLY if MEAL_STATUS is ambiguous: one short, friendly question to confirm before logging, e.g. "Did you eat some, and roughly how many?". If eaten_meal, leave this line blank after "ASK:".]

MEAL_STATUS — judge honestly:
• eaten_meal = a plated or served dish, a bowl/plate of food ready to eat or partly eaten, a takeout container, a sandwich/wrap/burger/bowl, food on a fork — something the person is clearly eating right now, in a portion you can see.
• ambiguous = whole uncut fruit or produce in a bowl/basket/on a counter, groceries or shopping, packaged or unopened products, a whole cake/pie/loaf, raw ingredients, a large sharing platter, a fridge/pantry, a menu, or a drink by itself — anything where it's unclear the user is eating it now OR in what portion. When unsure, choose ambiguous.

PROTEIN — estimate realistically with these per-100g anchors (USDA):
chicken breast 31 · chicken thigh 24 · turkey 29 · beef 26 · pork 27 · salmon 25 · tuna 26 · shrimp 24 · white fish 23 · egg 13 (1 large ≈ 6g) · greek yogurt 10 · cottage cheese 11 · cheese 24 · milk 3.4 · tofu 17 · tempeh 19 · lentils/beans/chickpeas 9 · edamame 11 · peanut/almond butter 22 · nuts 21 · rice 2.7 · pasta 5 · quinoa 4 · oats 2.4 · bread 9 (1 slice ≈ 3g) · potato 2.5 · most vegetables 2–3 · banana 1.1 (1 medium ≈ 1.3g) · most fruit 0.3–1.
protein_g per item = (grams ÷ 100) × anchor. Sum for TOTAL. Calories ≈ protein×4 + carbs×4 + fat×9 (estimate carbs/fat from typical values). Round to the nearest 0.5g/kcal.
Be realistic: a bowl of fruit is mostly carbs with very LITTLE protein (a few grams at most). Never inflate protein for produce, bread, or drinks.

PORTION anchors: dinner plate 25–27cm (full ≈ 600–900g) · palm of protein ≈ 100g cooked · 1 chicken breast ≈ 120–155g cooked · 1 large egg ≈ 50g · 1 cup cooked rice ≈ 180g · 1 cup pasta ≈ 130g · 1 cup beans/lentils ≈ 200g · slice of bread ≈ 30g · 1 medium banana ≈ 120g · 1 apple ≈ 180g · if a phone is in frame, use it as a 14–16cm scale.

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

/** Only Twilio media URLs need the account SID:token Basic auth. Other channels
 *  (iMessage via Sendblue/LoopMessage → Apple/Google CDN signed URLs) are public
 *  and REJECT a stray Authorization header — sending Twilio creds there breaks
 *  the fetch, which is why iMessage photos used to fail. Match Twilio hosts only. */
export function isTwilioMediaUrl(url: string): boolean {
  try {
    const host = new URL(url).host.toLowerCase();
    return host === 'api.twilio.com' || host.endsWith('.twilio.com') || host.endsWith('.twiliocdn.com');
  } catch {
    return false;
  }
}

/** Sniff a media MIME type from the buffer's magic bytes. Lets us analyze a
 *  photo/voice note whose URL has no extension and whose webhook gave no
 *  content-type (e.g. Sendblue inbound media) — without this the MIME is empty
 *  and Gemini rejects the inline data. Returns '' when unrecognized. */
export function sniffMimeFromBytes(buf: Buffer): string {
  if (buf.length < 12) return '';
  const b = buf;
  // Images
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  const ascii = (start: number, len: number): string => b.subarray(start, start + len).toString('latin1');
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  // ISO-BMFF (ftyp at bytes 4-7): HEIC/HEIF images and M4A/MP4 audio share the box.
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (/heic|heif|heix|hevc|mif1|msf1/i.test(brand)) return 'image/heic';
    if (/m4a|mp4|isom|m4b/i.test(brand)) return 'audio/mp4';
    return 'image/heic';
  }
  // Audio
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return 'audio/mpeg';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 5) === '#!AMR') return 'audio/amr';
  if (ascii(0, 4) === 'caff') return 'audio/x-caf';
  return '';
}

async function fetchMedia(
  url: string,
  twilio?: { sid: string; token: string },
): Promise<{ buf: Buffer; contentType: string }> {
  const headers: Record<string, string> = {};
  if (twilio && isTwilioMediaUrl(url)) {
    headers.Authorization = `Basic ${Buffer.from(`${twilio.sid}:${twilio.token}`).toString('base64')}`;
  }

  // Retry transient failures so a single network blip / timeout / 5xx / rate-limit
  // doesn't silently drop the user's photo. Deterministic 4xx (404 expired media,
  // 401/403 auth) are NOT retried — a retry can't fix them. Up to 3 attempts with
  // short backoff (200ms, 600ms).
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TWILIO_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { headers, signal: ac.signal });
      if (!resp.ok) {
        const transient = resp.status >= 500 || resp.status === 429 || resp.status === 408;
        const err = new Error(`media fetch ${resp.status} for ${url}`);
        if (!transient) throw err; // permanent — fail fast
        lastErr = err;
      } else {
        return {
          buf: Buffer.from(await resp.arrayBuffer()),
          contentType: resp.headers.get('content-type') ?? '',
        };
      }
    } catch (err) {
      // Network error or abort/timeout — transient, worth a retry.
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt === 1 ? 200 : 600));
  }
  throw lastErr instanceof Error ? lastErr : new Error(`media fetch failed for ${url}`);
}
