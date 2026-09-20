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
      history = []
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


    /*
      Clean and validate the conversation history
    */

    const safeHistory =
      Array.isArray(history)
        ? history
            .filter(item => {
              return (
                item &&
                (
                  item.role === 'user' ||
                  item.role === 'assistant'
                ) &&
                typeof item.content === 'string' &&
                item.content.trim()
              );
            })
            .slice(-100)
        : [];


    /*
      Nastivee's personality.

      IMPORTANT:
      - Normal by default
      - Does not randomly become sexual/flirty
      - Uses previous conversation
      - Remembers facts mentioned earlier in the supplied history
    */

    const systemPrompt = `
You are Nastivee AI, a friendly, confident and natural AI companion.

Your default personality:
- Friendly
- Helpful
- Conversational
- Funny when appropriate
- Relaxed
- Warm
- Playful when the user is playful

IMPORTANT PERSONALITY RULE:

Do NOT constantly talk sexually or flirt.

Do NOT randomly make normal conversations sexual, horny,
seductive or romantic.

Only become flirty, cheeky or suggestive when the user
clearly starts that type of conversation or explicitly asks
you to.

If the user changes back to a normal subject, immediately
return to a normal conversational tone.

Never turn an ordinary question into a sexual or romantic
conversation.

MEMORY:

You have access to the user's previous conversation in the
messages below.

You MUST use that previous conversation when answering.

If the user previously told you a personal fact, preference,
name, pet name, family detail, project detail, or something
similar, use it when it is relevant.

For example, if the user previously told you their dog's name,
you should remember the dog's name and should NOT say:

"You haven't told me your dog's name."

Instead, look through the previous conversation and use the
information that was already provided.

Do not pretend you remember something if it genuinely is not
present in the conversation history.

The conversation history may contain older messages followed
by the user's newest message. Treat the older messages as
real previous conversation context.

Do not constantly remind the user that you are an AI.

Speak naturally and avoid sounding overly formal or corporate.

Match the user's tone.

Keep answers reasonably concise unless the user asks for
more detail.
`;


    /*
      Build the OpenAI conversation.

      The previous history is placed BEFORE the new message,
      so the model can actually remember what was said.
    */

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
      'MEMORY MESSAGES:',
      safeHistory.length
    );


    const response =
      await openai.chat.completions.create({

        model: 'gpt-4o-mini',

        messages,

        temperature: 0.8

      });


    const reply =
      response
        ?.choices?.[0]
        ?.message
        ?.content
        ?.trim();


    if (!reply) {

      return res.status(500).json({
        error: 'No response was generated.'
      });

    }


    console.log(
      'REPLY:',
      reply
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


    /*
      Small variation when regenerating so the result
      isn't unnecessarily identical.
    */

    if (regenerate) {

      const variations = [

        'Create a fresh variation of the requested image while keeping the same overall concept.',

        'Generate another distinct interpretation of the requested image with subtle visual differences.',

        'Create a new version of the requested image with natural variation in composition, lighting and details.',

        'Regenerate the requested image as a slightly different creative interpretation.'

      ];


      const variation =
        variations[
          Math.floor(
            Math.random() *
            variations.length
          )
        ];


      finalPrompt +=
        `\n\n${variation}`;

    }


    console.log(
      'IMAGE GENERATION:',
      prompt
    );


    const response =
      await openai.images.generate({

        model: 'gpt-image-2',

        prompt: finalPrompt,

        size: '1024x1024',

        quality: 'medium',

        n: 1

      });


    const image =
      response?.data?.[0]?.b64_json;


    if (!image) {

      throw new Error(
        'No image was returned by OpenAI.'
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
        error: 'An image is required for editing.'
      });

    }


    console.log(
      'IMAGE EDIT:',
      prompt
    );


    /*
      Convert the browser data URL into a Buffer.
    */

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


    /*
      Normalize the uploaded image.

      This avoids the image-format problems that were
      happening with image editing.
    */

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
          type:
            'image/jpeg'
        }

      );


    /*
      Tell the image model that the uploaded image is the
      authoritative source.

      This is particularly important when regenerating.
    */

    let finalPrompt;


    if (regenerate) {

      finalPrompt = `

The uploaded image is the authoritative original image.

Create a fresh variation of the requested edit.

IMPORTANT:
- Preserve the person's identity and facial likeness.
- Preserve the person's overall appearance.
- Preserve important physical characteristics.
- Do not replace the person with a different person.
- Do not use a previous AI-generated result as the source.
- Work directly from the uploaded original photograph.
- Keep the requested edit while making a natural visual variation.

Requested edit:
${prompt.trim()}

Generate a new variation with subtle differences in
composition, lighting, positioning or details while
preserving the original person's identity.
`;

    } else {

      finalPrompt = `

Edit the uploaded photograph according to the request below.

IMPORTANT:
- Preserve the person's identity and facial likeness.
- Preserve their natural facial features.
- Preserve their overall appearance unless the requested
  edit specifically changes it.
- Do not replace the person with a different person.
- Keep the photograph realistic.
- Make the requested change clearly visible.

Requested edit:
${prompt.trim()}
`;

    }


    console.log(
      'SENDING IMAGE TO OPENAI...'
    );


    /*
      IMPORTANT:
      gpt-image-2 does NOT support input_fidelity.

      Therefore we deliberately do NOT send input_fidelity.
    */

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
        'No edited image was returned by OpenAI.'
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

        <meta
          name="viewport"
          content="width=device-width, initial-scale=1"
        >

      </head>

      <body>

        <h1>Nastivee AI</h1>

        <p>Server is running.</p>

      </body>

    </html>
  `);

});


/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      `Nastivee AI server running on port ${PORT}`
    );

  }
);
