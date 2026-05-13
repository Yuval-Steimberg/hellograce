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

    if (first.kind === 'image') {
      const prompt = 'You are analyzing a meal photo for a GLP-1 user. In ONE sentence: identify the foods and estimate total grams of protein and total kcal. Be conservative.';
      const inlineData = { data: buf.toString('base64'), mimeType: first.contentType };
      const r = await model.generateContent([{ inlineData }, { text: prompt }]);
      return r.response.text().trim();
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

    // Clean up uploaded file (best-effort).
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
