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
      prompt
    } = req.body;

    if (!prompt || !prompt.trim()) {

      return res.status(400).json({
        error: 'Image prompt is required'
      });

    }

    console.log(
      `IMAGE GENERATION: ${prompt}`
    );


    /*
      FREE REIN

      Text to image is the user's own idea, so their words
      go to the model as they wrote them. No house style,
      no extra subject rules, nothing added that they did
      not ask for.
    */

    const finalPrompt = prompt;


    console.log(
      'SENDING IMAGE TO OPENAI...'
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
      'IMAGE GENERATED SUCCESSFULLY'
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
// IMAGE EDIT / RE-RENDER
// =====================================================

app.post('/api/image/edit', async (req, res) => {

  try {

    const {
      prompt,
      image,
      regenerate = false,

      /*
        true when the source is a photograph the user
        uploaded, which is when likeness must be locked.
      */
      fromUpload = false
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
        ? `IMAGE RE-RENDER: ${prompt}`
        : `IMAGE EDIT: ${prompt}`
    );


    // =================================================
    // GET IMAGE DATA
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
      `SOURCE IMAGE: ${originalBuffer.length} bytes`
    );


    if (!originalBuffer.length) {

      throw new Error(
        'The supplied image could not be decoded.'
      );

    }


    // =================================================
    // NORMALISE IMAGE
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

        'source-image.jpg',

        {
          type: 'image/jpeg'
        }

      );


    // =================================================
    // NORMAL EDIT
    // =================================================

    let finalPrompt = `
${fromUpload
  ? `THIS IS A PHOTO EDIT, NOT A NEW IMAGE.

The supplied photograph is a real photograph
of a real person, and they must come out the
other side as the same person.`
  : `EDIT THE SUPPLIED IMAGE.

The supplied image is an existing picture.
Keep its subject and concept.`}

EDIT REQUESTED BY THE USER:

${prompt}


SOURCE IMAGE:

The supplied image is the authoritative
visual source. Copy the face from it.

Treat the face as fixed. Change only what
the requested edit needs.

Preserve the existing subject and identity.

Only make changes necessary to satisfy
the user's request.


PERSON PRESERVATION:

If a person is present, preserve their
likeness as closely as possible.

Preserve:

- facial structure
- face shape
- facial proportions
- eyes
- eyebrows
- nose
- mouth
- lips
- cheeks
- jawline
- ears
- skin tone
- hair
- hairline
- hairstyle
- distinctive facial characteristics
- visible body proportions

Do not replace the person.

Do not create a generic person.

Do not unnecessarily change their face.

Do not unnecessarily beautify them.

Do not unnecessarily age or de-age them.

Do not change their identity.


${fromUpload
  ? `LIKENESS IS THE FIRST PRIORITY:

If the requested edit and the person's
likeness ever pull against each other,
the likeness wins.

A result showing a different face is a
failed result, however good it looks.

Someone who knows this person must
recognise them instantly.`
  : ''}

IMPORTANT:

Make the requested change while keeping
the rest of the image as consistent as
reasonably possible.

Do not redesign the entire image.

Do not introduce unrelated changes.

Keep the result realistic unless the user
specifically requested another style.
`;


    // =================================================
    // RE-RENDER
    // =================================================

    if (regenerate) {

      finalPrompt = `
IMPROVE AND RE-RENDER THE SUPPLIED IMAGE.

This is an edit of the supplied image.

DO NOT create a completely unrelated new
image.

DO NOT restart the design from scratch.

The supplied image is the CURRENT VERSION
and must remain the primary visual source.


USER'S ORIGINAL CREATIVE REQUEST:

${prompt}


MAIN OBJECTIVE:

Improve and refine the current image while
preserving the same subject, same person,
same concept and same requested changes.


PERSON IDENTITY — EXTREMELY IMPORTANT:

If the image contains a person, preserve
their likeness as closely as possible.

Keep the same person.

Preserve:

- facial structure
- face shape
- forehead
- eyes
- eye shape
- eyebrows
- nose
- nose proportions
- cheeks
- cheek structure
- mouth
- lips
- chin
- jawline
- ears
- skin tone
- hair
- hairline
- hairstyle
- distinctive facial features
- visible body proportions

Do NOT replace the person.

Do NOT make them look like a different person.

Do NOT make their face generic.

Do NOT unnecessarily beautify their face.

Do NOT unnecessarily change their age.

Do NOT unnecessarily change their ethnicity.

Do NOT unnecessarily alter their facial
proportions.

Do NOT change their identity.


PRESERVE THE EXISTING IMAGE:

Keep the existing:

- subject
- person
- identity
- requested modification
- overall concept
- important composition
- clothing unless requested otherwise
- important objects
- environment unless requested otherwise
- overall visual intention


IMPROVEMENT:

Improve the image where appropriate by
enhancing:

- realism
- detail
- lighting
- shadows
- texture
- clarity
- depth
- natural skin detail
- photographic quality
- composition
- overall polish


DO NOT OVER-EDIT:

Do not make unnecessary changes.

Do not completely redesign the image.

Do not randomly change the person's face.

Do not remove a change the user requested.

Do not turn the image into a different
concept.


FRESHNESS:

The result should be a refined new version
of the CURRENT IMAGE.

It should be recognisably the same image
and the same person, but improved.

Do not simply reproduce the exact same image.

Make useful visual improvements while
maintaining continuity.


PRIORITY ORDER:

1. Preserve the person's identity.
2. Preserve the requested modification.
3. Preserve the existing image and concept.
4. Improve realism and quality.
5. Make only useful changes.
6. Avoid unnecessary redesign.
`;


    }


    console.log(
      regenerate
        ? 'SENDING CURRENT IMAGE FOR IMPROVEMENT...'
        : 'SENDING IMAGE FOR EDIT...'
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
