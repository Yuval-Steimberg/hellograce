import { GoogleGenerativeAI } from '@google/generative-ai';
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

    const inlineData = { data: buf.toString('base64'), mimeType: first.contentType };

    if (first.kind === 'image') {
      const prompt = 'You are analyzing a meal photo for a GLP-1 user. In ONE sentence: identify the foods and estimate total grams of protein and total kcal. Be conservative.';
      const r = await model.generateContent([{ inlineData }, { text: prompt }]);
      return r.response.text().trim();
    }
    if (first.kind === 'audio') {
      const prompt = 'Transcribe this short voice note. Output only the transcription, no preamble.';
      const r = await model.generateContent([{ inlineData }, { text: prompt }]);
      return `voice transcript: ${r.response.text().trim()}`;
    }
    return null;
  } catch (err) {
    opts.logger.warn({ err }, 'multimodal.analyze.failed');
    return null;
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
    if (!resp.ok) throw new Error(`media fetch failed: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}
