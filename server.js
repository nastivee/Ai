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

app.use(
  express.json({
    limit: '25mb'
  })
);


// =====================================================
// HEALTH CHECK
// =====================================================

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'Nastivee AI',
    status: 'online'
  });
});


// =====================================================
// CHAT
// =====================================================

app.post('/api/chat', async (req, res) => {

  try {

    const {
      messages = [],
      memory = {}
    } = req.body;

    const systemPrompt = `
You are Nastivee AI.

You are a friendly, intelligent personal AI assistant.

PERSONALITY:

- Speak naturally and conversationally.
- Be helpful, warm and direct.
- Do not constantly flirt.
- Do not constantly make sexual or suggestive comments.
- Only become flirty, cheeky or sexual if the user clearly starts that type of conversation or directly asks for it.
- If the subject changes, return naturally to a normal helpful tone.
- Do not randomly turn ordinary conversations sexual.

MEMORY:

The user may provide saved memory.

Use saved memory naturally when relevant.

If a fact exists in the supplied memory, treat it as something the user previously told you.

Do not claim the user never told you something if it exists in memory.

USER MEMORY:

${JSON.stringify(memory, null, 2)}
`;

    const cleanMessages =
      Array.isArray(messages)
        ? messages.slice(-30)
        : [];

    const response =
      await openai.chat.completions.create({

        model: 'gpt-4o-mini',

        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          ...cleanMessages
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
      error: 'Chat request failed',
      details:
        error?.message ||
        'Unknown error'
    });

  }

});


// =====================================================
// IMAGE GENERATION
// =====================================================

app.post('/api/image', async (req, res) => {

  try {

    const {
      prompt,
      regenerate = false
    } = req.body;

    if (!prompt || !prompt.trim()) {

      return res.status(400).json({
        error: 'Image prompt is required'
      });

    }

    console.log(
      regenerate
        ? `IMAGE RE-RENDER: ${prompt}`
        : `IMAGE GENERATION: ${prompt}`
    );


    /*
      NORMAL IMAGE
    */

    let finalPrompt = `
Create an image according to this user request:

${prompt}

Follow the user's requested subject, appearance,
environment and style closely.

Make the result visually polished,
detailed and coherent.

Make the result realistic unless
the user specifically requests another style.
`;


    /*
      RE-RENDER

      The user wants a new version of the
      same idea rather than a duplicate.
    */

    if (regenerate) {

      finalPrompt = `
Create a fresh new variation of the image
requested below.

ORIGINAL USER REQUEST:

${prompt}


RE-RENDER INSTRUCTIONS:

Keep the user's original request and
intended subject.

Do not remove or contradict anything
specifically requested.

Create a genuinely fresh variation
rather than simply repeating the previous
composition.

You may subtly vary:

- composition
- camera angle
- framing
- lighting
- background
- pose
- atmosphere
- visual arrangement

Keep the same overall concept.

Do not turn the image into a completely
different scene.

Make the result polished, realistic and
visually coherent unless the user
requested another style.
`;

    }


    console.log(
      regenerate
        ? 'SENDING RE-RENDER TO OPENAI...'
        : 'SENDING IMAGE TO OPENAI...'
    );


    const result =
      await openai.images.generate({

        model: 'gpt-image-2',

        prompt: finalPrompt,

        size: '1024x1024',

        quality: 'medium',

        n: 1

      });


    const imageData =
      result?.data?.[0]?.b64_json;


    if (!imageData) {

      throw new Error(
        'OpenAI returned no image data.'
      );

    }


    console.log(
      regenerate
        ? 'IMAGE RE-RENDER SUCCESSFUL'
        : 'IMAGE GENERATED SUCCESSFULLY'
    );


    res.json({
      image:
        `data:image/png;base64,${imageData}`
    });


  } catch (error) {

    console.error(
      'IMAGE GENERATION ERROR:',
      error
    );

    res.status(500).json({

      error:
        'Image generation failed',

      details:
        error?.message ||
        'Unknown error'

    });

  }

});


// =====================================================
// IMAGE EDIT / IMAGE RE-RENDER
// =====================================================

app.post('/api/image/edit', async (req, res) => {

  try {

    const {
      prompt,
      image,
      regenerate = false
    } = req.body;


    if (!prompt || !prompt.trim()) {

      return res.status(400).json({
        error:
          'Image edit prompt is required'
      });

    }


    if (!image) {

      return res.status(400).json({
        error:
          'Original image is required'
      });

    }


    console.log(
      regenerate
        ? `IMAGE EDIT RE-RENDER: ${prompt}`
        : `IMAGE EDIT: ${prompt}`
    );


    // =================================================
    // GET ORIGINAL IMAGE DATA
    // =================================================

    const match =
      image.match(
        /^data:image\/[^;]+;base64,(.+)$/s
      );


    const base64Data =
      match
        ? match[1]
        : image;


    const originalBuffer =
      Buffer.from(
        base64Data,
        'base64'
      );


    console.log(
      `ORIGINAL IMAGE: ${originalBuffer.length} bytes`
    );


    // =================================================
    // NORMALISE ORIGINAL IMAGE
    // =================================================

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
      `IMAGE CONVERTED: ${normalizedBuffer.length} bytes`
    );


    // =================================================
    // CREATE OPENAI FILE
    // =================================================

    const imageFile =
      await toFile(

        normalizedBuffer,

        'original-upload.jpg',

        {
          type: 'image/jpeg'
        }

      );


    // =================================================
    // NORMAL EDIT PROMPT
    // =================================================

    let finalPrompt = `
Edit the uploaded image according to this
user instruction:

${prompt}


IMPORTANT:

The uploaded image is the authoritative
source.

Preserve the person's identity and
facial appearance when a person is present.

Preserve:

- facial structure
- facial proportions
- eyes
- nose
- mouth
- jawline
- skin tone
- hairline
- hairstyle
- distinctive characteristics
- body proportions where visible

Do not replace the person with another person.

Do not unnecessarily change the composition.

Only make the requested changes.

Make the result photorealistic unless
another style is requested.
`;


    // =================================================
    // RE-RENDER PROMPT
    // =================================================

    if (regenerate) {

      finalPrompt = `
Create a fresh re-render of the
uploaded ORIGINAL photograph.

ORIGINAL USER REQUEST:

${prompt}


VERY IMPORTANT:

The uploaded original photograph is the
authoritative source for the person's
identity and appearance.

The previous generated image is NOT the
identity reference.

Use the uploaded original photograph as
the primary likeness reference.


PRESERVE THE PERSON'S LIKENESS:

- Preserve facial structure.
- Preserve facial proportions.
- Preserve the eyes and their shape.
- Preserve nose shape.
- Preserve mouth and lips.
- Preserve jawline.
- Preserve cheek structure.
- Preserve skin tone.
- Preserve hairline.
- Preserve hairstyle unless the user
  specifically requested a hairstyle change.
- Preserve distinctive facial features.
- Preserve visible body proportions.
- Do not replace the person with another person.
- Do not make the person look generic.
- Do not unnecessarily beautify the person.
- Do not unnecessarily age the person.
- Do not unnecessarily de-age the person.
- Do not change their identity.


KEEP THE USER'S REQUEST:

The requested edit must remain the same.

Do not remove the user's requested change.

Do not contradict the user's request.


CREATE A FRESH VARIATION:

Create a genuinely new version rather
than reproducing the previous generated
image.

Where appropriate, subtly vary:

- camera angle
- composition
- framing
- lighting
- background
- pose
- atmosphere
- visual arrangement

These variations must not change the
person's identity or remove the requested
edit.


IMPORTANT:

The uploaded ORIGINAL image is the source
of truth for the person's likeness.

Do NOT use the previous AI-generated
result as the likeness reference.

The final result should look like a fresh
photograph/render of the same person
with the requested modification.

Make it realistic and high quality unless
the user requested another style.
`;

    }


    console.log(
      regenerate
        ? 'SENDING ORIGINAL IMAGE FOR RE-RENDER...'
        : 'SENDING IMAGE TO OPENAI...'
    );


    // =================================================
    // OPENAI IMAGE EDIT
    // =================================================

    const result =
      await openai.images.edit({

        model: 'gpt-image-2',

        image: imageFile,

        prompt: finalPrompt,

        size: '1024x1024',

        quality: 'medium',

        n: 1

      });


    const imageData =
      result?.data?.[0]?.b64_json;


    if (!imageData) {

      throw new Error(
        'OpenAI returned no edited image data.'
      );

    }


    console.log(
      regenerate
        ? 'IMAGE RE-RENDER SUCCESSFUL'
        : 'IMAGE EDITED SUCCESSFULLY'
    );


    res.json({

      image:
        `data:image/png;base64,${imageData}`

    });


  } catch (error) {

    console.error(
      'IMAGE EDIT ERROR:',
      error
    );


    res.status(500).json({

      error:
        'Image edit failed',

      details:
        error?.message ||
        'Unknown error'

    });

  }

});


// =====================================================
// HOME
// =====================================================

app.get('/', (req, res) => {

  res.send(
    'Nastivee AI is running.'
  );

});


// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, () => {

  console.log(
    `Nastivee AI server running on port ${PORT}`
  );

});
