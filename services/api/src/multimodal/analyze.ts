import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Logger } from 'pino';
import type { MessageMedia } from '@grace/shared';

const TWILIO_FETCH_TIMEOUT_MS = 8_000;

type ImageCategory = 'food' | 'body' | 'other';

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
    const inlineData = { data: buf.toString('base64'), mimeType: first.contentType };

    if (first.kind === 'image') {
      const category = await classifyImage(model, inlineData);
      opts.logger.info({ category }, 'multimodal.image.classified');

      if (category === 'food') return await analyzeFoodImage(model, inlineData);
      if (category === 'body') return await analyzeBodyImage(model, inlineData);
      // 'other' — let Grace handle it gracefully with context
      return 'IMAGE_TYPE: other — the user sent an image that is not food or a body photo.';
    }

    if (first.kind === 'audio') {
      return await transcribeAudioViaFileApi(buf, first.contentType, opts.apiKey, opts.model, opts.logger);
    }

    return null;
  } catch (err) {
    opts.logger.warn({ err }, 'multimodal.analyze.failed');
    return null;
  }
}

async function classifyImage(
  model: ReturnType<InstanceType<typeof GoogleGenerativeAI>['getGenerativeModel']>,
  inlineData: { data: string; mimeType: string },
): Promise<ImageCategory> {
  const r = await model.generateContent([
    { inlineData },
    {
      text: 'Classify this image into exactly one category. Reply with only one word:\n' +
        '- "food" if the image shows food, a meal, drinks, snacks, or anything edible\n' +
        '- "body" if the image shows a person\'s body, a selfie, a progress photo, or any human body part\n' +
        '- "other" for anything else',
    },
  ]);
  const raw = r.response.text().trim().toLowerCase();
  if (raw.includes('food')) return 'food';
  if (raw.includes('body')) return 'body';
  return 'other';
}

async function analyzeFoodImage(
  model: ReturnType<InstanceType<typeof GoogleGenerativeAI>['getGenerativeModel']>,
  inlineData: { data: string; mimeType: string },
): Promise<string> {
  const r = await model.generateContent([
    { inlineData },
    {
      text: `You are a precise food nutritionist analyzing a meal photo for someone on a GLP-1 medication tracking protein and calories.

Examine the image carefully:

1. Identify EVERY food item visible. Be specific (e.g. "green Granny Smith apples" not just "fruit"). Count individual pieces. Estimate weight/portion using visual cues: plate/bowl diameter, stacking, density.

2. For each item state:
   - Name + quantity (e.g. "4 medium green apples ≈ 300g")
   - Protein (g), Carbs (g), Fat (g), Calories (kcal) — use USDA values

3. Provide grand totals.

Output exactly in this format:
IMAGE_TYPE: food
ITEMS: [comma-separated list with quantities]
BREAKDOWN:
- [item with qty]: protein Xg, carbs Xg, fat Xg, cal Xkcal
TOTAL: protein Xg | carbs Xg | fat Xg | calories Xkcal
NOTES: [protein adequacy — e.g. "Low protein snack — 80g daily target not met"]`,
    },
  ]);
  return r.response.text().trim();
}

async function analyzeBodyImage(
  model: ReturnType<InstanceType<typeof GoogleGenerativeAI>['getGenerativeModel']>,
  inlineData: { data: string; mimeType: string },
): Promise<string> {
  const r = await model.generateContent([
    { inlineData },
    {
      text: `You are a compassionate health coach analyzing a body progress photo for someone on a GLP-1 medication (Ozempic/Wegovy/Mounjaro/Zepbound).

Provide a warm, encouraging, and honest analysis. Focus on:

1. VISIBLE CHANGES: Note any visible changes in body composition you can observe — midsection, face, arms, overall silhouette. Be specific but kind.

2. MUSCLE & TONE: Comment on visible muscle preservation or definition (important for GLP-1 users who risk muscle loss).

3. POSTURE & CONFIDENCE: Note posture, how they're standing, any confidence cues.

4. ENCOURAGEMENT: Acknowledge the courage it takes to share a progress photo and reinforce their journey.

Important rules:
- Never give medical diagnoses or body fat percentage estimates
- Be warm and supportive, not clinical
- Focus on health and strength, not aesthetics
- If this appears to be a before/after comparison, acknowledge the progress explicitly

Output exactly in this format:
IMAGE_TYPE: body
OBSERVATIONS: [2-3 specific, positive, honest observations]
MUSCLE_NOTE: [1 sentence on muscle tone/preservation — critical for GLP-1 users]
ENCOURAGEMENT: [1-2 warm, personal sentences]`,
    },
  ]);
  return r.response.text().trim();
}

async function transcribeAudioViaFileApi(
  buf: Buffer,
  contentType: string,
  apiKey: string,
  modelName: string,
  logger: Logger,
): Promise<string | null> {
  const ext = contentType.includes('ogg') ? 'ogg' : contentType.includes('mp4') ? 'mp4' : contentType.includes('webm') ? 'webm' : 'mp3';
  const tempPath = join(tmpdir(), `grace-audio-${Date.now()}.${ext}`);

  try {
    writeFileSync(tempPath, buf);

    const fileManager = new GoogleAIFileManager(apiKey);
    const upload = await fileManager.uploadFile(tempPath, {
      mimeType: contentType,
      displayName: 'voice-note',
    });

    const client = new GoogleGenerativeAI(apiKey);
    const model = client.getGenerativeModel({ model: modelName });
    const r = await model.generateContent([
      { fileData: { mimeType: contentType, fileUri: upload.file.uri } },
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
