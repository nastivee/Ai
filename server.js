import express from 'express';
import cors from 'cors';
import OpenAI, { toFile } from 'openai';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

/*
  Larger limit because uploaded photos are sent
  from the browser as base64.
*/
app.use(express.json({ limit: '50mb' }));


/* =========================
   OPENAI CLIENT
========================= */

function getOpenAIClient() {

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) return null;

  return new OpenAI({
    apiKey,
    timeout: 180000
  });

}


/* =========================
   CHAT
========================= */

app.post('/api/chat', async (req, res) => {

  try {

    const { message } = req.body;

    if (!message) {

      return res.status(400).json({
        error: 'Message is required'
      });

    }

    const openai = getOpenAIClient();

    if (!openai) {

      return res.status(500).json({
        error: 'OPENAI_API_KEY is missing on Render.'
      });

    }

    const completion =
      await openai.chat.completions.create({

        model: 'gpt-4o-mini',

        messages: [
          {
            role: 'user',
            content: message
          }
        ]

      });

    const answer =
      completion.choices?.[0]?.message?.content ||
      'No response received.';

    return res.json({
      answer
    });

  } catch (error) {

    console.error('Chat error:', error);

    return res.status(500).json({
      error:
        error?.message ||
        'Chat service error'
    });

  }

});


/* =========================
   NEW IMAGE
========================= */

app.post('/api/image', async (req, res) => {

  try {

    const { prompt } = req.body;

    if (!prompt) {

      return res.status(400).json({
        error: 'Prompt is required'
      });

    }

    const openai = getOpenAIClient();

    if (!openai) {

      return res.status(500).json({
        error: 'OPENAI_API_KEY is missing on Render.'
      });

    }

    console.log(
      'Generating new image:',
      prompt
    );


    const response =
      await openai.images.generate({

        model: 'gpt-image-2',

        prompt: prompt,

        size: '1024x1024',

        quality: 'high',

        n: 1

      });


    const image =
      response?.data?.[0];


    /*
      GPT image models normally return
      base64 image data.
    */

    if (image?.b64_json) {

      console.log(
        'Image generated successfully.'
      );

      return res.json({

        imageUrl:
          `data:image/png;base64,${image.b64_json}`

      });

    }


    /*
      Keep URL support in case the API
      returns one.
    */

    if (image?.url) {

      return res.json({

        imageUrl: image.url

      });

    }


    throw new Error(
      'OpenAI returned no image data.'
    );


  } catch (error) {

    console.error(
      'IMAGE GENERATION ERROR:',
      error?.status,
      error?.message || error
    );

    return res.status(500).json({

      error:
        error?.message ||
        'Image generation failed.'

    });

  }

});


/* =========================
   EDIT UPLOADED PHOTO
========================= */

app.post('/api/image/edit', async (req, res) => {

  try {

    const {
      prompt,
      image
    } = req.body;


    if (!prompt) {

      return res.status(400).json({
        error: 'Edit prompt is required.'
      });

    }


    if (!image) {

      return res.status(400).json({
        error: 'An image is required for editing.'
      });

    }


    const openai = getOpenAIClient();

    if (!openai) {

      return res.status(500).json({
        error: 'OPENAI_API_KEY is missing on Render.'
      });

    }


    console.log(
      'Editing uploaded image:',
      prompt
    );


    /*
      Convert the browser's data URL into
      an image buffer.
    */

    const match =
      image.match(
        /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/
      );


    if (!match) {

      return res.status(400).json({
        error: 'Invalid image format.'
      });

    }


    const mimeType = match[1];

    const base64Data = match[2];

    const imageBuffer =
      Buffer.from(
        base64Data,
        'base64'
      );


    /*
      Send the uploaded image to OpenAI.
    */

    const imageFile =
      await toFile(
        imageBuffer,
        'uploaded-image.png',
        {
          type: mimeType
        }
      );


    const response =
      await openai.images.edit({

        model: 'gpt-image-2',

        image: imageFile,

        prompt: prompt,

        size: '1024x1024',

        quality: 'high',

        n: 1

      });


    const result =
      response?.data?.[0];


    if (result?.b64_json) {

      console.log(
        'Image edited successfully.'
      );

      return res.json({

        imageUrl:
          `data:image/png;base64,${result.b64_json}`

      });

    }


    if (result?.url) {

      return res.json({

        imageUrl: result.url

      });

    }


    throw new Error(
      'OpenAI returned no edited image.'
    );


  } catch (error) {

    console.error(
      'IMAGE EDIT ERROR:',
      error?.status,
      error?.message || error
    );

    return res.status(500).json({

      error:
        error?.message ||
        'Image editing failed.'

    });

  }

});


/* =========================
   HEALTH CHECK
========================= */

app.get('/', (req, res) => {

  res.json({

    status: 'online',

    service: 'Nastivee AI Bot',

    imageGeneration: true,

    imageEditing: true

  });

});


/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {

  console.log(
    `Server running on port ${PORT}`
  );

});
