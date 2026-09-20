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

  res.send(
    'Nastivee AI Bot backend is running.'
  );

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


    console.log(
      'CHAT:',
      message
    );


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

            content:
              message
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
   IMAGE VARIATION INSTRUCTIONS
================================================== */

const variationInstructions = [

  `
Create a completely different composition from the
previous version.

Change the camera angle, subject positioning,
framing and visual arrangement.

Keep the original subject and all important
requested details accurate.

Do NOT simply reproduce the previous image.
`,

  `
Create a fresh visual interpretation of the request.

Use a noticeably different camera angle, framing,
lighting setup and composition.

Keep the main subject and requested details the same,
but make the overall image clearly different.
`,

  `
Make this version substantially different.

Change the perspective, lighting, subject placement,
background arrangement and overall composition.

Preserve the original request and important details.
Avoid repeating the previous image.
`,

  `
Reimagine the scene from a completely different
viewpoint.

Use different framing, camera position, lighting,
depth and subject placement.

The original request remains the priority, but the
result must look like a new image.
`,

  `
Create an alternative interpretation.

Use a new composition, different perspective,
different lighting and different arrangement of
the visual elements.

Do not copy the previous composition.
`,

  `
Create a distinctly different version.

Change the camera position, lens perspective,
lighting, subject positioning and background
arrangement.

Keep the requested subject accurate.
`,

  `
Create a fresh cinematic interpretation.

Use a substantially different composition,
perspective, lighting design and scene arrangement.

Keep the original concept intact.
`,

  `
Create another unique version of the image.

Do not repeat the previous composition.

Experiment with a different viewpoint, framing,
lighting, depth and arrangement while keeping
the original prompt accurate.
`

];


function getRandomVariation() {

  return variationInstructions[
    Math.floor(
      Math.random() *
      variationInstructions.length
    )
  ];

}


/* ==================================================
   IMAGE GENERATION
================================================== */

app.post('/api/image', async (req, res) => {

  try {

    const {
      prompt,
      regenerate
    } = req.body;


    if (
      !prompt ||
      !prompt.trim()
    ) {

      return res.status(400).json({

        error:
          'Image prompt is required.'

      });

    }


    let finalPrompt =
      prompt.trim();


    /*
     * NORMAL IMAGE
     */

    if (!regenerate) {

      console.log(
        'IMAGE GENERATION:',
        finalPrompt
      );

    }


    /*
     * REGENERATED IMAGE
     *
     * Add a completely different
     * variation instruction.
     */

    if (regenerate === true) {

      const variation =
        getRandomVariation();


      finalPrompt = `

${prompt.trim()}


IMPORTANT IMAGE REGENERATION INSTRUCTION:

${variation}

This is a regeneration.

The result must be visibly different from the
previous image.

Do not merely recreate the previous composition.

Keep the user's original request, subject,
important objects and requested details accurate.

Create a genuinely new visual interpretation.

`;


      console.log(
        'IMAGE REGENERATION:',
        finalPrompt
      );

    }


    /*
     * GENERATE
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
     * BASE64 IMAGE
     */

    if (imageData.b64_json) {

      return res.json({

        image:
          `data:image/png;base64,${imageData.b64_json}`

      });

    }


    /*
     * IMAGE URL
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


    if (
      !prompt ||
      !prompt.trim()
    ) {

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
      regenerate
        ? 'IMAGE EDIT REGENERATION:'
        : 'IMAGE EDIT:',
      prompt
    );


    /* ==================================================
       CONVERT BASE64 IMAGE
    ================================================== */

    let originalBuffer;


    if (
      typeof image === 'string' &&
      image.startsWith('data:')
    ) {

      const base64Data =
        image.split(',')[1];


      if (!base64Data) {

        throw new Error(
          'Invalid image data.'
        );

      }


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
      'ORIGINAL IMAGE:',
      originalBuffer.length,
      'bytes'
    );


    /* ==================================================
       NORMALISE IMAGE
    ================================================== */

    const normalizedBuffer =
      await sharp(
        originalBuffer
      )

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
            90,

          mozjpeg:
            true

        })

        .toBuffer();


    console.log(
      'IMAGE CONVERTED:',
      normalizedBuffer.length,
      'bytes'
    );


    /* ==================================================
       CREATE OPENAI FILE
    ================================================== */

    const imageFile =
      await toFile(

        normalizedBuffer,

        'uploaded-image.jpg',

        {
          type:
            'image/jpeg'
        }

      );


    /* ==================================================
       CREATE EDIT PROMPT
    ================================================== */

    let finalPrompt =
      prompt.trim();


    /*
     * NORMAL EDIT
     */

    if (!regenerate) {

      console.log(
        'SENDING IMAGE TO OPENAI...'
      );

    }


    /*
     * REGENERATED EDIT
     */

    if (regenerate === true) {

      const variation =
        getRandomVariation();


      finalPrompt = `

${prompt.trim()}


IMPORTANT IMAGE EDIT REGENERATION INSTRUCTION:

${variation}

This is a regeneration of a previous edited image.

Create a noticeably different result from the
previous edit.

Keep the original uploaded subject recognisable
and preserve the user's requested changes.

Do not simply reproduce the previous result.

`;

      console.log(
        'REGENERATING IMAGE EDIT...'
      );

    }


    /* ==================================================
       SEND TO OPENAI
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
       RESULT
    ================================================== */

    const imageData =
      response.data?.[0];


    if (!imageData) {

      throw new Error(
        'No edited image returned from OpenAI.'
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
