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


/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(cors());

app.use(
  express.json({
    limit: '25mb'
  })
);


/* =========================================================
   BASIC ROUTE
========================================================= */

app.get('/', (req, res) => {
  res.send('Nastivee AI Bot is online.');
});


/* =========================================================
   CHAT
========================================================= */

app.post('/api/chat', async (req, res) => {

  try {

    const { message } = req.body;

    if (!message || !message.trim()) {

      return res.status(400).json({
        error: 'Message is required.'
      });

    }

    console.log('CHAT:', message);


    const response =
      await openai.chat.completions.create({

        model: 'gpt-4o-mini',

        messages: [

          {
            role: 'system',

            content: `
You are Nastivee AI, a fun, confident, playful AI companion.

Your personality is:

- Friendly and natural
- Funny and able to joke around
- Playful and cheeky when the user is being playful
- Flirty when the conversation is flirty
- Comfortable discussing attraction, romance and sexual topics in a mature, non-judgmental way
- Warm and conversational rather than robotic
- Able to tease and banter naturally
- Match the user's energy and tone

Do not constantly remind the user that you are an AI.

Do not sound overly formal or corporate.

Do not turn playful conversations into lectures.

If the user jokes, joke back.

If the user flirts, respond playfully and naturally.

If the user is being cheeky, you can be cheeky back.

Keep responses conversational and human-sounding while still being helpful when the user asks a serious question.

The user should feel like they are chatting with a personality, not a generic customer-service bot.
`
          },

          {
            role: 'user',
            content: message
          }

        ]

      });


    const reply =
      response.choices?.[0]?.message?.content ||
      'Sorry, I could not generate a response.';


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
      regenerate
    } = req.body;


    if (!prompt || !prompt.trim()) {

      return res.status(400).json({
        error: 'Image prompt is required.'
      });

    }


    console.log('========================================');

    console.log(
      regenerate
        ? 'IMAGE REGENERATION'
        : 'IMAGE GENERATION'
    );

    console.log(
      'PROMPT:',
      prompt
    );


    let finalPrompt = prompt.trim();


    /* =====================================================
       TEXT-ONLY IMAGE REGENERATION
    ===================================================== */

    if (regenerate === true) {

      const variations = [

        `
Create another version of the requested image.

Keep the original idea, subject and overall concept,
but make a subtle creative variation in composition,
lighting, camera angle, positioning or environment.
`,

        `
Generate a fresh alternative interpretation of the
requested image.

Keep the same subject and concept while making
modest changes to composition, lighting and details.
`,

        `
Create another version of this image concept.

Keep the important elements from the original request,
but slightly change the composition, perspective,
lighting or surrounding details.
`,

        `
Produce a new variation of the requested image.

Maintain the same core subject and idea but introduce
small creative differences in framing, atmosphere,
lighting or positioning.
`

      ];


      const variation =
        variations[
          Math.floor(
            Math.random() *
            variations.length
          )
        ];


      finalPrompt = `

${prompt.trim()}

${variation}

`;

    }


    console.log(
      'FINAL IMAGE PROMPT:',
      finalPrompt
    );


    /* =====================================================
       OPENAI IMAGE GENERATION
    ===================================================== */

    const response =
      await openai.images.generate({

        model: 'gpt-image-2',

        prompt: finalPrompt,

        size: '1024x1024',

        quality: 'medium',

        n: 1

      });


    console.log(
      'IMAGE GENERATED SUCCESSFULLY'
    );


    const imageData =
      response.data?.[0];


    if (!imageData) {

      throw new Error(
        'No image returned from OpenAI.'
      );

    }


    /* =====================================================
       BASE64 IMAGE
    ===================================================== */

    if (imageData.b64_json) {

      return res.json({

        image:
          `data:image/png;base64,${imageData.b64_json}`

      });

    }


    /* =====================================================
       IMAGE URL FALLBACK
    ===================================================== */

    if (imageData.url) {

      return res.json({

        image:
          imageData.url

      });

    }


    throw new Error(
      'Image response contained no usable image.'
    );


  } catch (error) {

    console.error(
      'IMAGE GENERATION ERROR:',
      error
    );


    res.status(500).json({

      error:
        error?.error?.message ||
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
      regenerate
    } = req.body;


    /* =====================================================
       VALIDATION
    ===================================================== */

    if (!prompt || !prompt.trim()) {

      return res.status(400).json({

        error:
          'Image edit prompt is required.'

      });

    }


    if (!image) {

      return res.status(400).json({

        error:
          'An image is required.'

      });

    }


    console.log('========================================');

    console.log(

      regenerate
        ? 'IMAGE EDIT REGENERATION'
        : 'IMAGE EDIT'

    );

    console.log(
      'PROMPT:',
      prompt
    );


    /* =====================================================
       CONVERT DATA URL TO BUFFER
    ===================================================== */

    let originalBuffer;


    if (

      typeof image === 'string' &&
      image.startsWith('data:')

    ) {

      const parts =
        image.split(',');


      if (parts.length < 2) {

        throw new Error(
          'Invalid image data.'
        );

      }


      const base64Data =
        parts[1];


      originalBuffer =
        Buffer.from(
          base64Data,
          'base64'
        );

    } else {

      throw new Error(
        'Unsupported image format.'
      );

    }


    console.log(

      'ORIGINAL UPLOADED PHOTO:',
      originalBuffer.length,
      'bytes'

    );


    /* =====================================================
       NORMALISE ORIGINAL PHOTO

       Handles:
       - Phone rotation
       - Large images
       - Transparency
       - Unsupported formats
       - HEIC-style uploads after browser conversion
       - JPEG compatibility
    ===================================================== */

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

      'NORMALISED ORIGINAL:',
      normalizedBuffer.length,
      'bytes'

    );


    /* =====================================================
       CREATE OPENAI FILE
    ===================================================== */

    const imageFile =
      await toFile(

        normalizedBuffer,

        'original-upload.jpg',

        {
          type: 'image/jpeg'
        }

      );


    /* =====================================================
       FIRST EDIT
    ===================================================== */

    let finalPrompt;


    if (!regenerate) {

      finalPrompt = `

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

${prompt.trim()}

Make the requested edit while keeping the original
person clearly recognisable and faithful to the
uploaded photograph.

Do not change unrelated parts of the image unless
necessary to complete the requested edit.

`;

    }


    /* =====================================================
       REGENERATION
       
       IMPORTANT:
       The ORIGINAL uploaded photograph is sent again.

       The previous AI-generated result is NOT used
       as the reference.
    ===================================================== */

    if (regenerate === true) {

      const regenerationVariations = [

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


      const variation =
        regenerationVariations[

          Math.floor(

            Math.random() *
            regenerationVariations.length

          )

        ];


      finalPrompt = `

THE UPLOADED PHOTOGRAPH IS THE ORIGINAL SOURCE IMAGE.

Use the uploaded photograph as the PRIMARY and
AUTHORITATIVE reference for the person.

USER'S ORIGINAL EDIT REQUEST:

${prompt.trim()}

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

${variation}

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


    /* =====================================================
       SEND ORIGINAL PHOTO TO OPENAI
    ===================================================== */

    console.log(
      'SENDING ORIGINAL PHOTO TO OPENAI...'
    );

    console.log(
      'REGENERATION:',
      regenerate === true
    );

    console.log(
      'SENDING EDIT REQUEST...'
    );


    const response =
      await openai.images.edit({

        model: 'gpt-image-2',

        image: imageFile,

        prompt: finalPrompt,

        size: '1024x1024',

        quality: 'medium',

        input_fidelity: 'high',

        n: 1

      });


    console.log(

      regenerate
        ? 'IMAGE EDIT REGENERATED SUCCESSFULLY'
        : 'IMAGE EDITED SUCCESSFULLY'

    );


    const imageData =
      response.data?.[0];


    if (!imageData) {

      throw new Error(
        'No edited image returned from OpenAI.'
      );

    }


    /* =====================================================
       RETURN BASE64 IMAGE
    ===================================================== */

    if (imageData.b64_json) {

      return res.json({

        image:
          `data:image/png;base64,${imageData.b64_json}`

      });

    }


    /* =====================================================
       RETURN URL IF PROVIDED
    ===================================================== */

    if (imageData.url) {

      return res.json({

        image:
          imageData.url

      });

    }


    throw new Error(

      'Edited image response contained no usable image.'

    );


  } catch (error) {

    console.error(
      'IMAGE EDIT ERROR:',
      error
    );


    res.status(500).json({

      error:
        error?.error?.message ||
        error?.message ||
        'Image editing failed.'

    });

  }

});


/* =========================================================
   START SERVER
========================================================= */

app.listen(

  PORT,

  () => {

    console.log(
      `Nastivee AI Bot running on port ${PORT}`
    );

  }

);
