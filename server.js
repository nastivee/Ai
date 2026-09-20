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


/* ==================================================
   HOME
================================================== */

app.get('/', (req, res) => {
  res.send('Nastivee AI Bot backend is running.');
});


/* ==================================================
   CHAT
================================================== */

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
            content:
              'You are Nastivee AI Bot, a helpful, friendly and intelligent personal AI assistant.'
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


/* ==================================================
   IMAGE GENERATION
================================================== */

app.post('/api/image', async (req, res) => {

  try {

    const {
      prompt,
      regenerate
    } = req.body;


    if (!prompt || !prompt.trim()) {

      return res.status(400).json({

        error:
          'Image prompt is required.'

      });

    }


    let finalPrompt = prompt.trim();


    /*
     * NORMAL GENERATION
     */

    if (!regenerate) {

      console.log(
        'IMAGE GENERATION:',
        finalPrompt
      );

    }


    /*
     * REGENERATION
     *
     * For images that were generated from text only,
     * create a different visual interpretation.
     */

    if (regenerate === true) {

      const variations = [

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


      const variation =
        variations[
          Math.floor(
            Math.random() *
            variations.length
          )
        ];


      finalPrompt = `

${prompt.trim()}

IMPORTANT REGENERATION INSTRUCTION:

${variation}

The original user request remains the priority.

`;


      console.log(
        'IMAGE REGENERATION:',
        finalPrompt
      );

    }


    /*
     * GENERATE IMAGE
     */

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


    console.log(
      regenerate
        ? 'IMAGE REGENERATED SUCCESSFULLY'
        : 'IMAGE GENERATED SUCCESSFULLY'
    );


    const imageData =
      response.data?.[0];


    if (!imageData) {

      throw new Error(
        'No image returned from OpenAI.'
      );

    }


    /*
     * BASE64
     */

    if (imageData.b64_json) {

      return res.json({

        image:
          `data:image/png;base64,${imageData.b64_json}`

      });

    }


    /*
     * URL
     */

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


/* ==================================================
   IMAGE EDITING
================================================== */

app.post('/api/image/edit', async (req, res) => {

  try {

    const {
      prompt,
      image,
      regenerate
    } = req.body;


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


    console.log(
      '========================================'
    );

    console.log(
      regenerate
        ? 'IMAGE EDIT REGENERATION'
        : 'IMAGE EDIT'
    );

    console.log(
      'PROMPT:',
      prompt
    );


    /* ==================================================
       ORIGINAL UPLOADED PHOTO
       
       THIS MUST ALWAYS BE THE ORIGINAL PHOTO.
       
       We never use the previous AI-generated result
       as the reference for regeneration.
    ================================================== */

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


    /* ==================================================
       NORMALISE ORIGINAL PHOTO
    ================================================== */

    const normalizedBuffer =
      await sharp(originalBuffer)

        .rotate()

        .resize({

          width:
            1536,

          height:
            1536,

          fit:
            'inside',

          withoutEnlargement:
            true

        })

        .flatten({

          background:
            '#ffffff'

        })

        .jpeg({

          quality:
            95,

          mozjpeg:
            true

        })

        .toBuffer();


    console.log(
      'NORMALISED ORIGINAL:',
      normalizedBuffer.length,
      'bytes'
    );


    /* ==================================================
       CREATE OPENAI IMAGE FILE
    ================================================== */

    const imageFile =
      await toFile(

        normalizedBuffer,

        'original-upload.jpg',

        {
          type:
            'image/jpeg'
        }

      );


    /* ==================================================
       BUILD EDIT PROMPT
    ================================================== */

    let finalPrompt;


    /*
     * FIRST EDIT
     */

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

`;


    }


    /*
     * REGENERATION OF AN EDIT
     */

    if (regenerate === true) {

      /*
       * IMPORTANT:
       *
       * The uploaded photo is still the source image.
       *
       * We are NOT sending the previous generated
       * image back into the model.
       */

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


    /* ==================================================
       OPENAI IMAGE EDIT
    ================================================== */

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


    console.log(
      regenerate
        ? 'IMAGE EDIT REGENERATED SUCCESSFULLY'
        : 'IMAGE EDITED SUCCESSFULLY'
    );


    /* ==================================================
       GET RESULT
    ================================================== */

    const imageData =
      response.data?.[0];


    if (!imageData) {

      throw new Error(
        'No edited image returned from OpenAI.'
      );

    }


    /*
     * BASE64 RESULT
     */

    if (imageData.b64_json) {

      return res.json({

        image:
          `data:image/png;base64,${imageData.b64_json}`

      });

    }


    /*
     * URL RESULT
     */

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


/* ==================================================
   START SERVER
================================================== */

app.listen(
  PORT,
  () => {

    console.log(
      `Nastivee AI Bot running on port ${PORT}`
    );

  }
);
