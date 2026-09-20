import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import sharp from 'sharp';
import { toFile } from 'openai/uploads';
 
/* ==================================================
   CONFIG
================================================== */
 
const {
  OPENAI_API_KEY,
  PORT = 3000,
  CORS_ORIGINS = '',              // comma separated, empty = allow all
  CHAT_MODEL = 'gpt-4o-mini',
  IMAGE_MODEL = 'gpt-image-2',
  IMAGE_SIZE = '1024x1024',
  IMAGE_QUALITY = 'medium'
} = process.env;
 
if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set. Exiting.');
  process.exit(1);
}
 
const MAX_PROMPT_CHARS = 4000;
const MAX_HISTORY = 20;
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];
 
const SYSTEM_PROMPT =
  'You are Nastivee AI Bot, a helpful, friendly and intelligent personal AI assistant.';
 
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  timeout: 120_000,
  maxRetries: 2
});
 
/* ==================================================
   APP
================================================== */
 
const app = express();
 
app.disable('x-powered-by');
 
const allowedOrigins = CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
app.use(cors(allowedOrigins.length ? { origin: allowedOrigins } : undefined));
 
app.use(express.json({ limit: '25mb' }));
 
/* ==================================================
   HELPERS
================================================== */
 
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
 
// Wraps async handlers so any thrown error goes to the error middleware.
const route = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
 
const pick = list => list[Math.floor(Math.random() * list.length)];
 
const isTrue = value => value === true || value === 'true';
 
function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `${label} is required.`);
  }
  const text = value.trim();
  if (text.length > MAX_PROMPT_CHARS) {
    throw new HttpError(400, `${label} must be ${MAX_PROMPT_CHARS} characters or fewer.`);
  }
  return text;
}
 
function parseDataUrl(image) {
  if (typeof image !== 'string') {
    throw new HttpError(400, 'An image is required.');
  }
  const match = image.match(/^data:([\w/+.-]+);base64,(.+)$/s);
  if (!match) {
    throw new HttpError(400, 'Image must be a base64 data URL.');
  }
  const [, mime, data] = match;
  if (!ALLOWED_IMAGE_TYPES.includes(mime.toLowerCase())) {
    throw new HttpError(415, `Unsupported image type: ${mime}.`);
  }
  const buffer = Buffer.from(data, 'base64');
  if (!buffer.length) {
    throw new HttpError(400, 'Image data is empty.');
  }
  return buffer;
}
 
async function normaliseImage(buffer) {
  try {
    return await sharp(buffer, { limitInputPixels: 50_000_000 })
      .rotate()
      .resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 95, mozjpeg: true })
      .toBuffer();
  } catch {
    throw new HttpError(400, 'The uploaded image could not be read.');
  }
}
 
function imageFromResponse(response) {
  const item = response.data?.[0];
  if (item?.b64_json) {
    const format = response.output_format || 'png';
    return `data:image/${format};base64,${item.b64_json}`;
  }
  if (item?.url) return item.url;
  throw new Error('OpenAI returned no usable image.');
}
 
// Keeps only well formed { role, content } turns from the client.
function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(m =>
      m &&
      (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string' &&
      m.content.trim()
    )
    .slice(-MAX_HISTORY)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_PROMPT_CHARS) }));
}
 
/* ==================================================
   PROMPTS
================================================== */
 
const GENERATE_VARIATIONS = [
  'Create a fresh interpretation of the request. Use a different composition, camera angle, framing and lighting while keeping the original subject and requested details accurate. Do not simply reproduce the previous image.',
  'Create another distinct version of the request. Change the perspective, framing, lighting and arrangement of the scene while preserving the original subject and important details.',
  'Create a noticeably different composition. Change the camera position, subject placement, background arrangement and lighting, while keeping the original request accurate.',
  'Reimagine the requested scene from a different viewpoint with different framing, lighting and visual arrangement. Keep the original concept and requested details intact.'
];
 
const EDIT_VARIATIONS = [
  'Make a subtle alternative interpretation of the requested edit. Only slightly vary the scene, positioning, lighting, environment or styling.',
  'Create another version of the requested edit with modest changes, such as slightly different lighting, positioning, background details or atmosphere.',
  'Create a fresh but subtle variation of the edit. Only vary the requested edit slightly.',
  'Produce another version of the same edit with a small creative variation in the scene, lighting, composition or environment.',
  'Create a slightly different interpretation of the requested edit. Make changes only where appropriate to the edit.'
];
 
const IDENTITY_RULES = `
Preserve the person's identity and likeness. Keep consistent:
- facial structure, face shape, eyes, nose, mouth and jaw
- hairstyle and hair colour
- skin tone and body proportions
- distinctive facial features and overall appearance
 
Do not replace the person with a different person.
Do not alter the person's face beyond what the edit requires.`.trim();
 
function buildGeneratePrompt(prompt, regenerate) {
  if (!regenerate) return prompt;
  return `${prompt}
 
REGENERATION INSTRUCTION:
${pick(GENERATE_VARIATIONS)}
 
The original user request remains the priority.`;
}
 
function buildEditPrompt(prompt, regenerate) {
  const base = `Use the uploaded photograph as the primary and authoritative reference for the person.
 
${IDENTITY_RULES}
 
USER'S EDIT REQUEST:
${prompt}`;
 
  if (!regenerate) {
    return `${base}
 
Make the requested edit while keeping the person clearly recognisable and faithful to the uploaded photograph.`;
  }
 
  return `${base}
 
REGENERATION:
${pick(EDIT_VARIATIONS)}
 
This is a regeneration of the same edit. The requested edit should stay essentially the same, with only a modest visual variation, and the person must remain recognisable from the uploaded photograph.`;
}
 
/* ==================================================
   ROUTES
================================================== */
 
app.get('/', (req, res) => {
  res.send('Nastivee AI Bot backend is running.');
});
 
app.get('/health', (req, res) => {
  res.json({ ok: true });
});
 
/*
 * CHAT
 * Body: { message: string, history?: [{ role: 'user'|'assistant', content: string }] }
 * History is optional, so existing clients keep working.
 */
app.post('/api/chat', route(async (req, res) => {
  const message = requireText(req.body?.message, 'Message');
  const history = cleanHistory(req.body?.history);
 
  console.log(`CHAT (${message.length} chars, ${history.length} history turns)`);
 
  const response = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: message }
    ]
  });
 
  const reply =
    response.choices?.[0]?.message?.content ||
    'Sorry, I could not generate a response.';
 
  res.json({ reply });
}));
 
/*
 * IMAGE GENERATION
 * Body: { prompt: string, regenerate?: boolean }
 */
app.post('/api/image', route(async (req, res) => {
  const prompt = requireText(req.body?.prompt, 'Image prompt');
  const regenerate = isTrue(req.body?.regenerate);
 
  console.log(regenerate ? 'IMAGE REGENERATION' : 'IMAGE GENERATION');
 
  const response = await openai.images.generate({
    model: IMAGE_MODEL,
    prompt: buildGeneratePrompt(prompt, regenerate),
    size: IMAGE_SIZE,
    quality: IMAGE_QUALITY,
    n: 1
  });
 
  res.json({ image: imageFromResponse(response) });
}));
 
/*
 * IMAGE EDITING
 * Body: { prompt: string, image: dataURL, regenerate?: boolean }
 * The client must always send the ORIGINAL uploaded photo,
 * never a previous AI result, so likeness does not drift.
 */
app.post('/api/image/edit', route(async (req, res) => {
  const prompt = requireText(req.body?.prompt, 'Image edit prompt');
  const regenerate = isTrue(req.body?.regenerate);
  const original = parseDataUrl(req.body?.image);
  const normalised = await normaliseImage(original);
 
  console.log(
    `${regenerate ? 'IMAGE EDIT REGENERATION' : 'IMAGE EDIT'}: ` +
    `${original.length} bytes in, ${normalised.length} bytes normalised`
  );
 
  const imageFile = await toFile(normalised, 'original-upload.jpg', { type: 'image/jpeg' });
 
  const response = await openai.images.edit({
    model: IMAGE_MODEL,
    image: imageFile,
    prompt: buildEditPrompt(prompt, regenerate),
    size: IMAGE_SIZE,
    quality: IMAGE_QUALITY,
    n: 1
  });
 
  res.json({ image: imageFromResponse(response) });
}));
 
/* ==================================================
   ERRORS
================================================== */
 
app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});
 
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Body too large or bad JSON from express.json()
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request is too large.' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
 
  // Our own validation errors
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
 
  // OpenAI API errors (moderation blocks, rate limits, bad params)
  if (err instanceof OpenAI.APIError) {
    console.error(`OPENAI ERROR ${err.status}:`, err.message);
    const status = err.status && err.status < 500 ? err.status : 502;
    const message =
      status === 429 ? 'The service is busy, please try again shortly.' :
      status === 400 ? err.message :
      'The AI service failed to respond.';
    return res.status(status).json({ error: message });
  }
 
  console.error('SERVER ERROR:', err);
  res.status(500).json({ error: 'Something went wrong.' });
});
 
/* ==================================================
   START
================================================== */
 
const server = app.listen(PORT, () => {
  console.log(`Nastivee AI Bot running on port ${PORT}`);
});
 
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down.`);
    server.close(() => process.exit(0));
  });
}
