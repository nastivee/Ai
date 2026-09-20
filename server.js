import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import sharp from 'sharp';
import { toFile } from 'openai/uploads';

const app = express();

const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.use(cors());
app.use(express.json({ limit: '25mb' }));

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'Nastivee AI',
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY)
  });
});

// --------------------------------------------------
// CHAT
// --------------------------------------------------

app.post('/api/chat', async (req, res) => {
  try {
    const {
      message,
      history = [],
      memory = {}
    } = req.body || {};

    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        error: 'No message was provided.'
      });
    }

    console.log('CHAT:', message);

    const safeHistory = Array.isArray(history)
      ? history
          .filter(item =>
            item &&
            (item.role === 'user' || item.role === 'assistant') &&
            typeof item.content === 'string'
          )
          .slice(-100)
      : [];

    const safeMemory =
      memory &&
      typeof memory === 'object' &&
      !Array.isArray(memory)
        ? memory
        : {};

    const memoryEntries = Object.entries(safeMemory);

    const memoryText = memoryEntries.length
      ? memoryEntries
          .map(([key, value]) => `${key}: ${String(value)}`)
          .join('\n')
      : 'No long-term memory has been saved yet.';

    const systemPrompt = `
You are Nastivee AI.

You are a friendly, natural, confident AI assistant.

IMPORTANT PERSONALITY RULES:

- Be normal, conversational and helpful by default.
- Do NOT constantly flirt with the user.
- Do NOT randomly become sexual, horny, seductive or suggestive.
- Only become flirty, cheeky or suggestive if the user clearly starts that kind of conversation or explicitly asks you to.
- If the user changes back to a normal subject, immediately return to a normal conversational tone.
- Do not force jokes or flirting into unrelated answers.
- Speak naturally rather than sounding like a corporate assistant.
- You can be playful when the conversation is genuinely playful.
- Never claim that the user told you something if you do not actually have it in your available memory/history.

LONG-TERM MEMORY:

The following information has been deliberately saved by the user/browser:

${memoryText}

Use this information naturally when relevant.

If the memory contains something such as:

Dog's name: Rune

then you KNOW the dog's name is Rune.

Do NOT say that the user never told you their dog's name when the memory contains it.

RECENT CONVERSATION:

Use the supplied conversation history to maintain continuity.

Do not pretend that you remember conversations that are not included in either the memory or the supplied history.

The user's current message is the latest message in the conversation.
`;

    const messages = [
      {
        role: 'system',
        content: systemPrompt
      },
      ...safeHistory,
      {
        role: 'user',
        content: message
      }
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.8
    });

    const reply =
      completion.choices?.[0]?.message?.content ||
      "Sorry, I couldn't generate a response.";

    console.log('CHAT SUCCESS');

    res.json({
      reply
    });

  } catch (error) {
    console.error('CHAT ERROR:', error);

    res.status(500).json({
      error:
        error?.message ||
        'Something went wrong while talking to Nastivee.'
    });
  }
});

// --------------------------------------------------
// IMAGE GENERATION
// --------------------------------------------------

app.post('/api/image', async (req, res) => {
  try {
    const {
      prompt,
      regenerate = false
    } = req.body || {};

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({
        error: 'No image prompt was provided.'
      });
    }

    console.log(
      'IMAGE GENERATION:',
      regenerate ? 'Regenerating' : prompt
    );

    const finalPrompt = regenerate
      ? `
Create another variation of this image request:

${prompt}

Make it visually different from the previous result while keeping the same subject, concept and requested details.
`
      : prompt;

    const result = await openai.images.generate({
      model: 'gpt-image-2',
      prompt: finalPrompt,
      size: '1024x1024',
      quality: 'medium',
      n: 1
    });

    const image = result.data?.[0];

    if (!image) {
      throw new Error('OpenAI did not return an image.');
    }

    console.log('IMAGE GENERATED SUCCESSFULLY');

    res.json({
      image:
        image.b64_json
          ? `data:image/png;base64,${image.b64_json}`
          : image.url
    });

  } catch (error) {
    console.error('IMAGE GENERATION ERROR:', error);

    res.status(500).json({
      error:
        error?.message ||
        'Something went wrong while generating the image.'
    });
  }
});

// --------------------------------------------------
// IMAGE EDITING
// --------------------------------------------------

app.post('/api/image/edit', async (req, res) => {
  try {
    const {
      prompt,
      image,
      regenerate = false
    } = req.body || {};

    if (!prompt) {
      return res.status(400).json({
        error: 'No image edit instruction was provided.'
      });
    }

    if (!image) {
      return res.status(400).json({
        error: 'No image was uploaded.'
      });
    }

    console.log(
      'IMAGE EDIT:',
      regenerate ? 'Regenerating edit' : prompt
    );

    let base64Data = image;

    if (base64Data.includes(',')) {
      base64Data = base64Data.split(',')[1];
    }

    const originalBuffer = Buffer.from(
      base64Data,
      'base64'
    );

    console.log(
      'ORIGINAL IMAGE:',
      originalBuffer.length,
      'bytes'
    );

    // Normalize the uploaded image into a safe JPEG.
    const normalizedBuffer =
      await sharp(originalBuffer)
        .rotate()
        .resize({
          width: 1536,
          height: 1536,
          fit: 'inside',
          withoutEnlargement: true
        })
        .flatten({
          background: '#ffffff'
        })
        .jpeg({
          quality: 95,
          mozjpeg: true
        })
        .toBuffer();

    console.log(
      'IMAGE CONVERTED:',
      normalizedBuffer.length,
      'bytes'
    );

    const imageFile = await toFile(
      normalizedBuffer,
      'original-upload.jpg',
      {
        type: 'image/jpeg'
      }
    );

    const finalPrompt = `
Edit the uploaded image according to this instruction:

${prompt}

IMPORTANT:

- The uploaded image is the authoritative source.
- Preserve the original person's identity and facial appearance when a person is present.
- Preserve the original subject's important characteristics.
- Do not unnecessarily change the composition.
- Only make the requested changes.
- Make the result photorealistic unless the user specifically asks for another style.

${regenerate
  ? 'Create a fresh variation of the requested edit while keeping the same subject and requested modification.'
  : ''}
`;

    console.log('SENDING IMAGE TO OPENAI...');

    const result = await openai.images.edit({
      model: 'gpt-image-2',
      image: imageFile,
      prompt: finalPrompt,
      size: '1024x1024',
      quality: 'medium',
      n: 1
    });

    const outputImage = result.data?.[0];

    if (!outputImage) {
      throw new Error(
        'OpenAI did not return an edited image.'
      );
    }

    console.log('IMAGE EDITED SUCCESSFULLY');

    res.json({
      image:
        outputImage.b64_json
          ? `data:image/png;base64,${outputImage.b64_json}`
          : outputImage.url
    });

  } catch (error) {
    console.error('IMAGE EDIT ERROR:', error);

    res.status(500).json({
      error:
        error?.message ||
        'Something went wrong while editing the image.'
    });
  }
});

// --------------------------------------------------
// HOME
// --------------------------------------------------

app.get('/', (req, res) => {
  res.send(`
    <!doctype html>
    <html>
      <head>
        <title>Nastivee AI</title>
      </head>
      <body style="
        background:#12001f;
        color:white;
        font-family:Arial,sans-serif;
        text-align:center;
        padding:50px;
      ">
        <h1>Nastivee AI</h1>
        <p>Server is running.</p>
      </body>
    </html>
  `);
});

// --------------------------------------------------
// START
// --------------------------------------------------

if (!process.env.OPENAI_API_KEY) {
  console.warn(
    'WARNING: OPENAI_API_KEY is not configured.'
  );
}

app.listen(PORT, () => {
  console.log(
    `Nastivee AI server running on port ${PORT}`
  );
});
