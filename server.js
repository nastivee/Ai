import express from 'express';
import cors from 'cors';
import OpenAI, { toFile } from 'openai';
import sharp from 'sharp';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

/*
  Large limit because the browser sends uploaded
  photos as base64 data.
*/
app.use(express.json({ limit: '50mb' }));


/* =========================================
   OPENAI
========================================= */

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  return new OpenAI({
    apiKey,
    timeout: 180000
  });
}


/* =========================================
   CHAT
========================================= */

app.post('/api/chat', async (req, res) => {

  try {

    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        error: 'Message is required.'
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

    res.json({
      answer
    });

  } catch (error) {

    console.error(
      'CHAT ERROR:',
      error?.status,
      error?.message || error
    );

    res.status(500).json({
      error:
        error?.message ||
        'Chat service error.'
    });

  }

});


/* =========================================
   CREATE NEW IMAGE
========================================= */

app.post('/api/image', async (req, res) => {

  try {

    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({
        error: 'Prompt is required.'
      });
    }

    const openai = getOpenAIClient();

    if (!openai) {
      return res.status(500).json({
        error: 'OPENAI_API_KEY is missing on Render.'
      });
    }

    console.log(
      'IMAGE GENERATION:',
      prompt
    );


    const response =
      await openai.images.generate({

        model: 'gpt-image-2',

        prompt,

        size: '1024x1024',

        quality: 'high',

        n: 1

      });


    const image = response?.data?.[0];


    if (image?.b64_json) {

      console.log(
        'IMAGE GENERATED SUCCESSFULLY'
      );

      return res.json({

        imageUrl:
          `data:image/png;base64,${image.b64_json}`

      });

    }


    if (image?.url) {

      return res.json({
        imageUrl: image.url
      });

    }


    throw new Error(
      'OpenAI returned no image.'
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


/* =========================================
   EDIT UPLOADED IMAGE
========================================= */

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
        error: 'No image was uploaded.'
      });

    }


    const openai = getOpenAIClient();

    if (!openai) {

      return res.status(500).json({
        error: 'OPENAI_API_KEY is missing on Render.'
      });

    }


    console.log(
      'IMAGE EDIT:',
      prompt
    );


    /*
      Browser sends:

      data:image/jpeg;base64,...

      or

      data:image/png;base64,...

      etc.
    */

    const match = image.match(
      /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/
    );


    if (!match) {

      return res.status(400).json({
        error:
          'Invalid uploaded image data.'
      });

    }


    const base64Data = match[1];


    const originalBuffer =
      Buffer.from(
        base64Data,
        'base64'
      );


    /*
      Convert the uploaded image into a
      standard PNG before sending it to OpenAI.

      This handles:
      JPEG
      PNG
      WebP
      HEIC/HEIF where Sharp supports it
      different colour modes
      EXIF rotation
    */

    const pngBuffer =
      await sharp(originalBuffer)
        .rotate()
        .flatten({
          background: '#ffffff'
        })
        .png()
        .toBuffer();


    console.log(
      'IMAGE CONVERTED TO PNG:',
      pngBuffer.length,
      'bytes'
    );


    /*
      Give OpenAI a real image file.
    */

    const imageFile =
      await toFile(
        pngBuffer,
        'uploaded-image.png',
        {
          type: 'image/png'
        }
      );


    /*
      Send the photo + editing instructions.
    */

    const response =
      await openai.images.edit({

        model: 'gpt-image-2',

        image: imageFile,

        prompt,

        size: '1024x1024',

        quality: 'high',

        n: 1

      });


    const result =
      response?.data?.[0];


    if (result?.b64_json) {

      console.log(
        'IMAGE EDITED SUCCESSFULLY'
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


/* =========================================
   SERVER STATUS
========================================= */

app.get('/', (req, res) => {

  res.json({

    status: 'online',

    service: 'Nastivee AI Bot',

    chat: true,

    imageGeneration: true,

    imageEditing: true

  });

});


/* =========================================
   START
========================================= */

app.listen(PORT, () => {

  console.log(
    `Server running on port ${PORT}`
  );

});
