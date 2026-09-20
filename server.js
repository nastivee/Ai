import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import sharp from 'sharp';
import { toFile } from 'openai/uploads';

const app = express();

app.use(cors());

app.use(
  express.json({
    limit: '25mb'
  })
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const PORT = process.env.PORT || 3000;


/* =========================================================
   CHAT
========================================================= */

app.post('/api/chat', async (req, res) => {
  try {

    const {
      message,
      history = [],
      memory = {}
    } = req.body;


    if (
      !message ||
      typeof message !== 'string' ||
      !message.trim()
    ) {
      return res.status(400).json({
        error: 'Message is required.'
      });
    }


    /* -----------------------------------------------------
       CLEAN HISTORY
    ----------------------------------------------------- */

    const safeHistory =
      Array.isArray(history)
        ? history
            .filter(item =>
              item &&
              (
                item.role === 'user' ||
                item.role === 'assistant'
              ) &&
              typeof item.content === 'string' &&
              item.content.trim()
            )
            .slice(-100)
        : [];


    /* -----------------------------------------------------
       CLEAN MEMORY
    ----------------------------------------------------- */

    const safeMemory =
      memory &&
      typeof memory === 'object' &&
      !Array.isArray(memory)
        ? memory
        : {};


    const memoryText =
      Object.entries(safeMemory)
        .filter(([key, value]) =>
          key &&
          value !== undefined &&
          value !== null &&
          String(value).trim()
        )
        .map(([key, value]) =>
          `${key}: ${value}`
        )
        .join('\n');


    /* -----------------------------------------------------
       SYSTEM PERSONALITY
    ----------------------------------------------------- */

    const systemPrompt = `

You are Nastivee AI.

You are a friendly, confident, natural AI companion.

DEFAULT PERSONALITY:
- Friendly
- Helpful
- Natural
- Funny when appropriate
- Relaxed
- Warm
- Playful when the user is playful

IMPORTANT:

Do NOT constantly flirt.

Do NOT randomly become sexual.

Do NOT randomly use horny, seductive or sexual language.

Do NOT turn normal conversations into sexual conversations.

Only become flirty, cheeky or suggestive when the user clearly
starts that type of conversation or specifically asks for it.

If the user changes back to a normal subject, immediately return
to a normal conversational tone.

MEMORY:

You have a separate long-term memory supplied below.

These are facts the user has previously told Nastivee.

You MUST use these facts when relevant.

If the memory says:

Dog's name: Rune

and the user asks:

"What is my dog's name?"

answer Rune.

DO NOT say the user has never told you if the information is
present in the memory.

Do not claim to remember something that isn't present.

You also have recent conversation history below. Use both the
long-term memory and recent conversation naturally.

LONG-TERM MEMORY:
${memoryText || 'No saved long-term facts yet.'}

Do not mention the technical memory system to the user unless
they ask about it.

Do not constantly remind the user that you are an AI.

Match the user's tone.

Keep normal answers reasonably concise.

`;


    /* -----------------------------------------------------
       OPENAI REQUEST
    ----------------------------------------------------- */

    const messages = [

      {
        role: 'system',
        content: systemPrompt
      },

      ...safeHistory,

      {
        role: 'user',
        content: message.trim()
      }

    ];


    console.log(
      'CHAT:',
      message.trim()
    );

    console.log(
      'HISTORY:',
      safeHistory.length,
      'messages'
    );

    console.log(
      'MEMORY:',
      Object.keys(safeMemory).length,
      'facts'
    );


    const response =
      await openai.chat.completions.create({

        model: 'gpt-4o-mini',

        messages,

        temperature: 0.8

      });


    const reply =
      response?.choices?.[0]?.message?.content?.trim();


    if (!reply) {

      throw new Error(
        'No response was generated.'
      );

    }


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
        'Chat request failed.'

    });

  }

});


/* =========================================================
   IMAGE GENERATION
========================================================= */

app.post('/api/image', async (req, res) => {

  try {

    const {
      prompt,
      regenerate = false
    } = req.body;


    if (
      !prompt ||
      typeof prompt !== 'string' ||
      !prompt.trim()
    ) {

      return res.status(400).json({
        error: 'Image prompt is required.'
      });

    }


    let finalPrompt =
      prompt.trim();


    if (regenerate) {

      const variations = [

        'Create a fresh variation while keeping the same overall concept.',

        'Create another distinct interpretation with subtle visual differences.',

        'Create a new version with natural variation in composition, lighting and details.',

        'Regenerate this as a slightly different creative interpretation.'

      ];


      finalPrompt +=
        '\n\n' +
        variations[
          Math.floor(
            Math.random() *
            variations.length
          )
        ];

    }


    console.log(
      'IMAGE GENERATION:',
      prompt
    );


    const response =
      await openai.images.generate({

        model:
          'gpt-image-2',

        prompt:
          finalPrompt,

        size:
          '1024x1024',

        quality:
          'medium',

        n:
          1

      });


    const image =
      response?.data?.[0]?.b64_json;


    if (!image) {

      throw new Error(
        'No image was returned.'
      );

    }


    console.log(
      'IMAGE GENERATED SUCCESSFULLY'
    );


    res.json({

      image:
        `data:image/png;base64,${image}`

    });


  } catch (error) {

    console.error(
      'IMAGE GENERATION ERROR:',
      error
    );


    res.status(500).json({

      error:
        error?.message ||
        'Image generation failed.'

    });

  }

});


/* =========================================================
   IMAGE EDITING
========================================================= */

app.post('/api/image/edit', async (req, res) => {

  try {

    const {
      prompt,
      image,
      regenerate = false
    } = req.body;


    if (
      !prompt ||
      typeof prompt !== 'string' ||
      !prompt.trim()
    ) {

      return res.status(400).json({
        error: 'Image edit prompt is required.'
      });

    }


    if (
      !image ||
      typeof image !== 'string'
    ) {

      return res.status(400).json({
        error: 'An image is required.'
      });

    }


    console.log(
      'IMAGE EDIT:',
      prompt
    );


    let base64Data =
      image;


    if (
      image.startsWith('data:')
    ) {

      base64Data =
        image.split(',')[1];

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

          background:
            '#ffffff'

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
          type:
            'image/jpeg'
        }

      );


    let finalPrompt;


    if (regenerate) {

      finalPrompt = `

The uploaded image is the authoritative original photograph.

Create a fresh variation of the requested edit.

IMPORTANT:
- Preserve the person's identity.
- Preserve facial likeness.
- Preserve natural facial features.
- Preserve important physical characteristics.
- Do not replace the person with another person.
- Do not use a previous AI-generated image as the source.
- Work directly from the uploaded original photograph.
- Keep the requested edit realistic.

Requested edit:

${prompt.trim()}

Create a fresh variation with subtle differences while
preserving the original person's identity.

`;

    } else {

      finalPrompt = `

Edit the uploaded photograph according to this request.

IMPORTANT:
- Preserve the person's identity.
- Preserve facial likeness.
- Preserve natural facial features.
- Do not replace the person with another person.
- Keep the result realistic.
- Clearly perform the requested edit.

Requested edit:

${prompt.trim()}

`;

    }


    console.log(
      'SENDING IMAGE TO OPENAI...'
    );


    const response =
      await openai.images.edit({

        model:
          'gpt-image-2',

        image:
          imageFile,

        prompt:
          finalPrompt,

        size:
          '1024x1024',

        quality:
          'medium',

        n:
          1

      });


    const imageResult =
      response?.data?.[0]?.b64_json;


    if (!imageResult) {

      throw new Error(
        'No edited image was returned.'
      );

    }


    console.log(
      'IMAGE EDITED SUCCESSFULLY'
    );


    res.json({

      image:
        `data:image/png;base64,${imageResult}`

    });


  } catch (error) {

    console.error(
      'IMAGE EDIT ERROR:',
      error
    );


    res.status(500).json({

      error:
        error?.message ||
        'Image editing failed.'

    });

  }

});


/* =========================================================
   HOME
========================================================= */

app.get('/', (req, res) => {

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Nastivee AI</title>
      </head>

      <body>
        <h1>Nastivee AI</h1>
        <p>Server is running.</p>
      </body>
    </html>
  `);

});


/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      `Nastivee AI server running on port ${PORT}`
    );

  }
);
