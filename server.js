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

const SYSTEM_PROMPT =
  'You are Nastivee AI Bot, a helpful, friendly and intelligent personal AI assistant.';

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
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
  return value.trim();
}

function parseDataUrl(image) {
  if (typeof image !== 'string') {
    throw new HttpError(400, 'An image is required.');
  }
  const comma = image.indexOf(',');
  if (!image.startsWith('data:') || comma === -1) {
    throw new HttpError(400, 'Image must be a data URL.');
  }
  const buffer = Buffer.from(image.slice(comma + 1), 'base64');
  if (!buffer.length) {
    throw new HttpError(400, 'Image data is empty.');
  }
  return buffer;
}

async function normaliseImage(buffer) {
  try {
    return await sharp(buffer)
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
    .map(m => ({ role: m.role, content: m.content }));
}

/* ==================================================
   PROMPTS
================================================== */

// Your original prompt text, kept word for word.

const GENERATE_VARIATIONS = [

  `
Create a fresh interpretation of the request.
Use a different composition, camera angle,
framing and lighting while keeping the original
subject and requested details accurate.
Do not simply reproduce the previous image.
`,

  `
Create another distinct version of the request.
Change the perspective, framing, lighting and
arrangement of the scene while preserving the
original subject and important details.
`,

  `
Create a noticeably different composition.
Change the camera position, subject placement,
background arrangement and lighting, while keeping
the original request accurate.
`,

  `
Reimagine the requested scene from a different
viewpoint with different framing, lighting and
visual arrangement. Keep the original concept
and requested details intact.
`

];

const EDIT_VARIATIONS = [

  `
Make a subtle alternative interpretation of the
requested edit.

Keep the exact same person and preserve their
identity and likeness.

Only slightly vary the requested scene, positioning,
lighting, environment or styling.

Do not substantially change the person's face.
`,

  `
Create another version of the requested edit.

Keep the uploaded person extremely consistent
with the original photograph.

Make only modest changes to the requested edit,
such as slightly different lighting, positioning,
background details or atmosphere.

Do not change the person's identity.
`,

  `
Create a fresh but subtle variation of the edit.

The uploaded photograph remains the authoritative
reference for the person's appearance.

Keep their face, facial structure, hairstyle,
skin tone and body proportions consistent.

Only vary the requested edit slightly.
`,

  `
Produce another version of the same edit.

Preserve the original person's likeness as closely
as possible.

Do not turn the person into someone else.

Make a small creative variation in the requested
scene, lighting, composition or environment.
`,

  `
Keep the person exactly recognisable from the
uploaded photograph.

Create a slightly different interpretation of
the user's requested edit.

Make changes only where appropriate to the edit.

Avoid unnecessary changes to the person's face,
body or identity.
`

];

function buildGeneratePrompt(prompt, regenerate) {

  if (!regenerate) return prompt;

  return `

${prompt}

IMPORTANT REGENERATION INSTRUCTION:

${pick(GENERATE_VARIATIONS)}

The original user request remains the priority.

`;

}

function buildEditPrompt(prompt, regenerate) {

  /*
   * FIRST EDIT
   */

  if (!regenerate) {

    return `

Use the uploaded photograph as the primary reference.

Edit the photograph according to the user's request.

PRESERVE THE PERSON'S IDENTITY AND LIKENESS.

Keep the person's:

- facial structure
- face shape
- eyes
- nose
- mouth
- jaw
- hairstyle
- hair colour
- skin tone
- body proportions
- distinctive facial characteristics
- overall appearance

Do not replace the person with another person.

Do not unnecessarily alter the person's face.

USER'S EDIT REQUEST:

${prompt}

Make the requested edit while keeping the original
person clearly recognisable and faithful to the
uploaded photograph.

`;

  }

  /*
   * REGENERATION OF AN EDIT
   *
   * The uploaded photo is still the source image.
   * We are NOT sending the previous generated
   * image back into the model.
   */

  return `

THE UPLOADED PHOTOGRAPH IS THE ORIGINAL SOURCE IMAGE.

Use the uploaded photograph as the PRIMARY and
AUTHORITATIVE reference for the person.

USER'S ORIGINAL EDIT REQUEST:

${prompt}


IDENTITY PRESERVATION:

Preserve the person's identity and likeness as
faithfully as possible.

Keep consistent:

- facial structure
- face shape
- eyes
- nose
- mouth
- jaw
- hairstyle
- hair colour
- skin tone
- body proportions
- distinctive facial features
- overall appearance

Do NOT replace the person with a different person.

Do NOT substantially alter their face.

Do NOT create a new person.

Do NOT use a different person as the reference.

REGENERATION:

${pick(EDIT_VARIATIONS)}

IMPORTANT:

This is a regeneration of the SAME EDIT using the
ORIGINAL UPLOADED PHOTOGRAPH.

Do not treat the previous AI-generated image as
the source.

The original uploaded photograph must remain the
reference for the person's likeness.

The requested edit should remain essentially the
same, with only a modest visual variation.

`;

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

  console.log('CHAT:', message);

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

  const finalPrompt = buildGeneratePrompt(prompt, regenerate);
  console.log(regenerate ? 'IMAGE REGENERATION:' : 'IMAGE GENERATION:', finalPrompt);

  const response = await openai.images.generate({
    model: IMAGE_MODEL,
    prompt: finalPrompt,
    size: IMAGE_SIZE,
    quality: IMAGE_QUALITY,
    n: 1
  });

  console.log(
    regenerate
      ? 'IMAGE REGENERATED SUCCESSFULLY'
      : 'IMAGE GENERATED SUCCESSFULLY'
  );

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

  console.log('========================================');
  console.log(regenerate ? 'IMAGE EDIT REGENERATION' : 'IMAGE EDIT');
  console.log('PROMPT:', prompt);

  // THIS MUST ALWAYS BE THE ORIGINAL PHOTO.
  // We never use the previous AI-generated result
  // as the reference for regeneration.
  const original = parseDataUrl(req.body?.image);
  console.log('ORIGINAL UPLOADED PHOTO:', original.length, 'bytes');

  const normalised = await normaliseImage(original);
  console.log('NORMALISED ORIGINAL:', normalised.length, 'bytes');

  const imageFile = await toFile(normalised, 'original-upload.jpg', { type: 'image/jpeg' });

  console.log('SENDING ORIGINAL PHOTO TO OPENAI...');
  console.log('REGENERATION:', regenerate);
  console.log('SENDING EDIT REQUEST...');

  const response = await openai.images.edit({
    model: IMAGE_MODEL,
    image: imageFile,
    prompt: buildEditPrompt(prompt, regenerate),
    size: IMAGE_SIZE,
    quality: IMAGE_QUALITY,
    n: 1
  });

  console.log(
    regenerate
      ? 'IMAGE EDIT REGENERATED SUCCESSFULLY'
      : 'IMAGE EDITED SUCCESSFULLY'
  );

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

  // OpenAI API errors: pass OpenAI's own status and message straight through
  if (err instanceof OpenAI.APIError) {
    console.error(`OPENAI ERROR ${err.status}:`, err.message);
    return res.status(err.status || 500).json({
      error: err.error?.message || err.message
    });
  }

  console.error('SERVER ERROR:', err);
  res.status(500).json({ error: err?.message || 'Request failed.' });
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
