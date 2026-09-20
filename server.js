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

app.use(express.json({
  limit: '25mb'
}));

// ==================================================
// HEALTH CHECK
// ==================================================

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'Nastivee AI',
    openaiConfigured: Boolean(
      process.env.OPENAI_API_KEY
    )
  });
});

// ==================================================
// CHAT
// ==================================================

app.post('/api/chat', async (req, res) => {
  try {

    const {
      message,
      history = [],
      memory = {}
    } = req.body || {};

    if (
      !message ||
      typeof message !== 'string'
    ) {
      return res.status(400).json({
        error: 'No message was provided.'
      });
    }

    console.log(
      'CHAT:',
      message
    );

    const safeHistory =
      Array.isArray(history)
        ? history
            .filter(item =>
              item &&
              (
                item.role === 'user' ||
                item.role === 'assistant'
              ) &&
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

    const memoryEntries =
      Object.entries(safeMemory);

    const memoryText =
      memoryEntries.length
        ? memoryEntries
            .map(
              ([key, value]) =>
                `${key}: ${String(value)}`
            )
            .join('\n')
        : 'No long-term memory has been saved yet.';

    const systemPrompt = `
You are Nastivee AI.

You are friendly, natural, confident and conversational.

PERSONALITY:

- Be normal, friendly and helpful by default.
- Do not constantly flirt.
- Do not randomly become sexual, horny, seductive or suggestive.
- Only become flirty or cheeky when the user clearly starts that kind of conversation or explicitly asks for it.
- If the user returns to a normal subject, immediately return to a normal tone.
- Do not force flirting into unrelated conversations.
- Be playful when the conversation naturally calls for it.
- Do not sound overly corporate or robotic.
- Do not repeatedly remind the user that you are an AI.

LONG-TERM MEMORY:

The following information has been deliberately saved:

${memoryText}

Use this information naturally when relevant.

IMPORTANT:

If the memory says:

Dog's name: Rune

then the dog's name is Rune.

Never tell the user that they have not told you their dog's name if the memory contains the dog's name.

Do not invent memories.

RECENT CONVERSATION:

Use the supplied conversation history to maintain continuity.

Do not claim to remember conversations that are not contained in the supplied history or memory.

Always answer the user's latest message naturally.
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

    const completion =
      await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.8
      });

    const reply =
      completion
        .choices?.[0]
        ?.message
        ?.content ||
      'Sorry, I could not generate a response.';

    console.log(
      'CHAT SUCCESS'
    );

    res.json({
      reply
    });

  } catch (error) {

    console.error(
      'CHAT ERROR:',
      error
    );

    res.status(500).json({
      error:
        error?.message ||
        'Something went wrong while talking to Nastivee.'
    });
  }
});

// ==================================================
// IMAGE GENERATION
// ==================================================

app.post('/api/image', async (req, res) => {
  try {

    const {
      prompt,
      regenerate = false
    } = req.body || {};

    if (
      !prompt ||
      typeof prompt !== 'string'
    ) {
      return res.status(400).json({
        error: 'No image prompt was provided.'
      });
    }

    console.log(
      'IMAGE GENERATION:',
      prompt
    );

    const finalPrompt =
      regenerate
        ? `
Create another variation of this image request:

${prompt}

Make the new result visually different while preserving the same main subject and requested details.
`
        : prompt;

    const result =
      await openai.images.generate({
        model: 'gpt-image-2',
        prompt: finalPrompt,
        size: '1024x1024',
        quality: 'medium',
        n: 1
      });

    const image =
      result.data?.[0];

    if (!image) {
      throw new Error(
        'OpenAI did not return an image.'
      );
    }

    console.log(
      'IMAGE GENERATED SUCCESSFULLY'
    );

    res.json({
      image:
        image.b64_json
          ? `data:image/png;base64,${image.b64_json}`
          : image.url
    });

  } catch (error) {

    console.error(
      'IMAGE GENERATION ERROR:',
      error
    );

    res.status(500).json({
      error:
        error?.message ||
        'Something went wrong while generating the image.'
    });
  }
});

// ==================================================
// IMAGE EDITING
// ==================================================

app.post('/api/image/edit', async (req, res) => {
  try {

    const {
      prompt,
      image,
      regenerate = false
    } = req.body || {};

    if (!prompt) {
      return res.status(400).json({
        error:
          'No image edit instruction was provided.'
      });
    }

    if (!image) {
      return res.status(400).json({
        error:
          'No image was uploaded.'
      });
    }

    console.log(
      'IMAGE EDIT:',
      prompt
    );

    let base64Data =
      image;

    if (
      base64Data.includes(',')
    ) {
      base64Data =
        base64Data.split(',')[1];
    }

    const originalBuffer =
      Buffer.from(
        base64Data,
        'base64'
      );

    console.log(
      'ORIGINAL IMAGE:',
      originalBuffer.length,
      'bytes'
    );

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

    const imageFile =
      await toFile(
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
- Preserve the person's identity and facial appearance when a person is present.
- Preserve the original subject's important characteristics.
- Do not unnecessarily change the composition.
- Only make the requested changes.
- Make the result photorealistic unless another style is requested.

${
  regenerate
    ? 'Create a fresh variation of the requested edit while keeping the same subject and requested modification.'
    : ''
}
`;

    console.log(
      'SENDING IMAGE TO OPENAI...'
    );

    const result =
      await openai.images.edit({
        model: 'gpt-image-2',
        image: imageFile,
        prompt: finalPrompt,
        size: '1024x1024',
        quality: 'medium',
        n: 1
      });

    const outputImage =
      result.data?.[0];

    if (!outputImage) {
      throw new Error(
        'OpenAI did not return an edited image.'
      );
    }

    console.log(
      'IMAGE EDITED SUCCESSFULLY'
    );

    res.json({
      image:
        outputImage.b64_json
          ? `data:image/png;base64,${outputImage.b64_json}`
          : outputImage.url
    });

  } catch (error) {

    console.error(
      'IMAGE EDIT ERROR:',
      error
    );

    res.status(500).json({
      error:
        error?.message ||
        'Something went wrong while editing the image.'
    });
  }
});

// ==================================================
// HOME
// ==================================================

app.get('/', (req, res) => {

  res.send(`
    <!DOCTYPE html>

    <html>

      <head>
        <title>Nastivee AI</title>
      </head>

      <body
        style="
          background:#12001f;
          color:white;
          font-family:Arial;
          text-align:center;
          padding:50px;
        "
      >

        <h1>Nastivee AI</h1>

        <p>
          Nastivee AI server is running.
        </p>

      </body>

    </html>
  `);

});

// ==================================================
// START SERVER
// ==================================================

if (
  !process.env.OPENAI_API_KEY
) {

  console.warn(
    'WARNING: OPENAI_API_KEY is not configured.'
  );

}

app.listen(
  PORT,
  () => {

    console.log(
      `Nastivee AI server running on port ${PORT}`
    );

  }
);
