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

    const {
      message,
      history = []
    } = req.body;


    if (!message || !message.trim()) {

      return res.status(400).json({
        error: 'Message is required.'
      });

    }


    console.log('========================================');
    console.log('CHAT MESSAGE:', message);
    console.log(
      'HISTORY MESSAGES:',
      Array.isArray(history) ? history.length : 0
    );


    /* =====================================================
       SAFELY PREPARE MEMORY

       We only accept normal user/assistant messages.
       This prevents the browser from being able to inject
       its own system instructions.
    ===================================================== */

    let conversationHistory = [];

    if (Array.isArray(history)) {

      conversationHistory = history
        .filter(item => {

          return (
            item &&
            typeof item === 'object' &&
            (item.role === 'user' ||
             item.role === 'assistant') &&
            typeof item.content === 'string' &&
            item.content.trim()
          );

        })
        .slice(-80)
        .map(item => ({

          role: item.role,

          content:
            item.content.trim()

        }));

    }


    /* =====================================================
       SYSTEM PERSONALITY

       IMPORTANT:
       FLIRTING IS NOT THE DEFAULT.
    ===================================================== */

    const systemPrompt = `

You are Nastivee AI.

You are a friendly, intelligent, natural AI companion.

Your default personality is:

- Friendly
- Natural
- Funny when appropriate
- Helpful
- Warm
- Conversational
- Playful when the situation calls for it

IMPORTANT PERSONALITY RULE:

Do NOT constantly flirt with the user.

Do NOT make sexual comments when the user is having
a normal conversation.

Do NOT introduce sexual topics yourself.

Do NOT turn ordinary questions into flirting.

Flirting should ONLY happen when the user clearly
initiates or strongly steers the conversation toward
flirting, attraction, romance or sexual topics.

If the user is talking normally, respond normally.

If the user asks a serious question, take it seriously.

If the user jokes, you can joke back.

If the user is playful, you can be playful.

If the user clearly flirts with you, you may respond
with natural, playful flirting.

If the user stops flirting or changes the subject,
immediately return to normal conversation.

Never force flirting into unrelated conversations.

Do not repeatedly mention that you are an AI unless
there is a reason to do so.

Do not sound like a corporate customer-service bot.

Keep replies natural and conversational.

=========================================================
CONVERSATION MEMORY
=========================================================

You will receive previous messages from this conversation.

Use them as conversation memory.

Remember:

- Things the user has told you
- Questions the user has already asked
- Answers you have already given
- Names mentioned in the conversation
- Details about people, pets and situations mentioned
- Preferences the user has mentioned
- Previous jokes and context
- The current subject
- What you previously said

Do NOT pretend to remember information that is not
present in the supplied conversation history.

Do NOT ask the user to repeat something when the answer
is already present in the conversation history.

Continue the conversation naturally.

If the user refers to something they said earlier,
look through the conversation history and use it.

If the user asks "what did I say earlier?", use the
conversation history to answer.

=========================================================
RESPONSE STYLE
=========================================================

Be natural.

Do not unnecessarily repeat the user's question.

Do not give huge answers to simple questions.

Match the user's tone.

If the user wants a short answer, keep it short.

If the user wants detail, give detail.

If the user is joking, don't respond like a textbook.

If the user is upset, be supportive and human.

If the user is excited, match their energy.

`;


    /* =====================================================
       BUILD FULL MESSAGE HISTORY
    ===================================================== */

    const messages = [

      {
        role: 'system',
        content: systemPrompt
      },

      ...conversationHistory,

      {
        role: 'user',
        content: message.trim()
      }

    ];


    /* =====================================================
       OPENAI CHAT
    ===================================================== */

    const response =
      await openai.chat.completions.create({

        model: 'gpt-4o-mini',

        messages,

        max_tokens: 1200

      });


    const reply =
      response.choices?.[0]?.message?.content ||
      'Sorry, I could not generate a response.';


    console.log(
      'CHAT RESPONSE:',
      reply
    );


    res.json({

      reply,

      memoryMessages: messages.length

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

        error:
          'Image prompt is required.'

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


    let finalPrompt =
      prompt.trim();


    /* =====================================================
       IMAGE REGENERATION VARIATIONS
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
       BASE64
    ===================================================== */

    if (imageData.b64_json) {

      return res.json({

        image:
          `data:image/png;base64,${imageData.b64_json}`

      });

    }


    /* =====================================================
       URL FALLBACK
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

       ORIGINAL UPLOADED PHOTO IS USED AGAIN.
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
       SEND IMAGE TO OPENAI

       IMPORTANT:
       NO input_fidelity PARAMETER.
    ===================================================== */

    console.log(
      'SENDING ORIGINAL PHOTO TO OPENAI...'
    );

    console.log(
      'REGENERATION:',
      regenerate === true
    );


    const response =
      await openai.images.edit({

        model: 'gpt-image-2',

        image: imageFile,

        prompt: finalPrompt,

        size: '1024x1024',

        quality: 'medium',

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


    if (imageData.b64_json) {

      return res.json({

        image:
          `data:image/png;base64,${imageData.b64_json}`

      });

    }


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
