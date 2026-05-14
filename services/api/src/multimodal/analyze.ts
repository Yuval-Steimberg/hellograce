import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Logger } from 'pino';
import type { MessageMedia } from '@grace/shared';

const TWILIO_FETCH_TIMEOUT_MS = 8_000;

export async function analyzeMedia(
  media: MessageMedia[],
  opts: { apiKey: string; model: string; logger: Logger; twilio?: { sid: string; token: string } },
): Promise<string | null> {
  if (media.length === 0) return null;
  const first = media[0]!;

  try {
    const buf = await fetchMedia(first.url, opts.twilio);
    const client = new GoogleGenerativeAI(opts.apiKey);
    const model = client.getGenerativeModel({ model: opts.model });
    // Strip codec/charset parameters from MIME type (e.g. "image/jpeg; name=foo" → "image/jpeg")
    // Gemini inline data only accepts the base MIME type without parameters.
    const cleanMime = first.contentType.split(';')[0]!.trim();
    const inlineData = { data: buf.toString('base64'), mimeType: cleanMime };

    if (first.kind === 'image') {
      // Single Gemini call that both classifies and analyzes — saves a round-trip.
      const r = await model.generateContent([
        { inlineData },
        {
          text: `Examine this image. Decide if it shows FOOD, a BODY (person/selfie/progress photo), or OTHER, then produce the matching analysis below.

If FOOD: output exactly this structure for a GLP-1 user tracking protein/calories.
IMAGE_TYPE: food
ITEMS: [comma-separated list, each with specific name + quantity, e.g. "4 medium green apples ≈ 300g"]
BREAKDOWN:
- [item with qty]: protein Xg, carbs Xg, fat Xg, cal Xkcal
TOTAL: protein Xg | carbs Xg | fat Xg | calories Xkcal
CONFIDENCE: [high | medium | low] — be HONEST. High = clear items, visible portions, standard foods. Medium = decent estimate but portion size unclear or mixed dishes. Low = blurry/dark image, hard-to-identify food, or hidden ingredients.
CONFIDENCE_REASON: [one short phrase explaining why, e.g. "clear plate, easy to count" or "portion size hard to gauge from angle" or "mixed dish, ingredients hidden"]
NOTES: [protein adequacy note — e.g. "Solid protein hit" or "Light on protein, could pair with yogurt later"]

If BODY: provide a warm, encouraging GLP-1-aware analysis.
IMAGE_TYPE: body
OBSERVATIONS: [2-3 specific kind, honest observations about VISIBLE POSITIVE CHANGES only — midsection, face, arms, posture, silhouette. Do NOT mention pain, injuries, posture problems, discomfort, or any medical conditions. Do NOT invent anything you cannot clearly see.]
MUSCLE_NOTE: [1 sentence on visible muscle tone/preservation — critical for GLP-1 users. Never comment on medical concerns.]
ENCOURAGEMENT: [1-2 warm personal sentences acknowledging their weight-loss journey and progress.]

If OTHER:
IMAGE_TYPE: other
DESCRIPTION: [1 short sentence describing what the image shows]

Rules:
- For FOOD: count individual pieces, estimate weight from visual cues (plate/bowl size, density), use USDA values. Never invent food items not visible.
- For BODY: be kind and supportive, focus ONLY on visible weight-loss progress and muscle preservation. NEVER diagnose pain, injury, posture problems, or any medical condition. NEVER invent symptoms. NEVER mention body fat percentage. If the photo shows a person from the back, simply describe midsection/silhouette changes positively.
- For OTHER: describe only what you can clearly see, no speculation.`,
        },
      ]);
      return r.response.text().trim();
    }

    if (first.kind === 'audio') {
      return await transcribeAudioViaFileApi(buf, first.contentType, opts.apiKey, opts.model, opts.logger);
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
  modelName: string,
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
    const model = client.getGenerativeModel({ model: modelName });
    const r = await model.generateContent([
      { fileData: { mimeType: baseMime, fileUri: upload.file.uri } },
      { text: 'Transcribe this voice note exactly as spoken. Output only the spoken words, no preamble, no quotes.' },
    ]);

    void fileManager.deleteFile(upload.file.name).catch((e) => logger.warn({ e }, 'gemini.file.delete.failed'));

    return r.response.text().trim();
  } finally {
    try { unlinkSync(tempPath); } catch { /* ignore */ }
  }
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
