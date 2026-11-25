/**
 * The simulator's small vendors: a Mailjet mailbox, the recording host, and the two AI
 * endpoints (an OpenAI-compatible chat completion for post-call analysis, Gemini for
 * transcription). Each answers the shape the server's client reads and records what it got.
 */
import type { ServerResponse } from 'node:http';

export interface SentMail {
  to: string[];
  subject: string;
  text: string;
  html: string;
  at: number;
}

export class Mailbox {
  readonly sent: SentMail[] = [];

  reset(): void {
    this.sent.length = 0;
  }

  /** `POST /mailjet/v3.1/send` (the preload redirects api.mailjet.com here). */
  handleSend(body: string, res: ServerResponse): void {
    let parsed: { Messages?: Array<{ To?: Array<{ Email?: string }>; Subject?: string; TextPart?: string; HTMLPart?: string }> } = {};
    try { parsed = JSON.parse(body); } catch { /* answered as an empty send */ }
    const results = (parsed.Messages ?? []).map((m) => {
      const to = (m.To ?? []).map((t) => String(t.Email ?? '').toLowerCase());
      this.sent.push({ to, subject: m.Subject ?? '', text: m.TextPart ?? '', html: m.HTMLPart ?? '', at: Date.now() });
      return { Status: 'success', To: to.map((Email, i) => ({ Email, MessageUUID: `e2e-${Date.now()}-${i}`, MessageID: Date.now() + i })) };
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Messages: results }));
  }

  to(email: string): SentMail[] {
    const key = email.toLowerCase();
    return this.sent.filter((m) => m.to.includes(key));
  }
}

/** A short 8 kHz mono WAV of a quiet tone: what a "recording" download returns. */
export function recordingWav(seconds = 12): Buffer {
  const rate = 8000;
  const n = rate * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The canned analysis every analysed call gets. */
export const CANNED_ANALYSIS = {
  summary: 'E2E simulated call: the customer asked about the offer and agreed to a follow-up.',
  sentiment: 'positive',
  outcome: 'interested',
  topics: ['offer', 'follow-up'],
};

/** `POST /openai/v1/chat/completions`. */
export function handleChatCompletion(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: `chatcmpl-e2e-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'e2e-sim',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(CANNED_ANALYSIS) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }));
}

/**
 * `/gemini/...`: the Files API upload (resumable start + upload), file get/delete, and
 * generateContent, answering a two-turn transcript.
 */
export function handleGemini(method: string, url: URL, simOrigin: string, res: ServerResponse): void {
  const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(payload));
  };
  const file = { name: 'files/e2e-recording', uri: `${simOrigin}/gemini/v1beta/files/e2e-recording`, mimeType: 'audio/wav', state: 'ACTIVE', sizeBytes: '1000' };
  if (url.pathname.includes('/upload/') && method === 'POST' && !url.searchParams.has('upload_id')) {
    json(200, {}, { 'x-goog-upload-url': `${simOrigin}/gemini/upload/v1beta/files?upload_id=e2e`, 'x-goog-upload-status': 'active' });
    return;
  }
  if (url.pathname.includes('/upload/')) {
    json(200, { file }, { 'x-goog-upload-status': 'final' });
    return;
  }
  if (url.pathname.includes('/files/')) {
    if (method === 'DELETE') return json(200, {});
    return json(200, file);
  }
  if (url.pathname.endsWith(':generateContent')) {
    const transcript = {
      turns: [
        { speaker: 'agent', text: 'Hello, this is the e2e agent calling about your offer.', start: 0, end: 3 },
        { speaker: 'customer', text: 'Yes, please call me back tomorrow.', start: 3, end: 6 },
      ],
    };
    json(200, {
      candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(transcript) }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 },
    });
    return;
  }
  json(404, { error: { code: 404, message: `e2e sim: no Gemini route ${url.pathname}` } });
}
