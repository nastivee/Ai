const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const sharp = require('sharp');
const { toFile } = require('openai/uploads');

const app = express();

app.use(cors());
app.use(express.json({ limit: '25mb' }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const PORT = process.env.PORT || 3000;

// --------------------------------------------------
// BASIC ROUTE
// --------------------------------------------------

app.get('/', (req, res) => {
  res.send('Nastivee AI Bot backend is running.');
});

// --------------------------------------------------
// CHAT
// --------------------------------------------------

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        error: 'Message is required.'
      });
    }

    const response = await openai.chat.completions.create({
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

    res.json({ reply });

  } catch (error) {
    console.error('CHAT ERROR:', error);

    res.status(500).json({
      error: 'Chat request failed.'
    });
  }
});

// --------------------------------------------------
// IMAGE VARIATIONS
// --------------------------------------------------

const variationInstructions = [
  'Create a completely different composition from the previous version. Change the camera angle, subject positioning and visual arrangement while keeping the core subject and requested details accurate.',

  'Create a fresh visual interpretation. Use a different camera angle, different framing, different lighting and a noticeably different composition. Do not simply reproduce the previous image.',

  'Make this version substantially different from the previous result. Change the perspective, environment details, lighting, subject placement and overall visual arrangement while preserving the original request.',

  'Create an alternative version with a new composition and visual concept. Use a different perspective, depth, lighting setup and arrangement. Avoid repeating the previous image.',

  'Reimagine the scene from a completely different viewpoint. Change the framing, camera position, lighting, background arrangement and subject placement while maintaining the original prompt.',

  'Produce a distinctly different interpretation of the prompt. Use an unexpected but appropriate composition, different perspective, different lighting and different environmental details.',

  'Create another unique version. Do not copy the previous composition. Change the camera angle, lens perspective, lighting, subject position and background arrangement.',

  'Create a fresh cinematic interpretation of the request. Use a substantially different composition, perspective, lighting design and scene arrangement from the previous result.'
];

function getRandomVariation() {
  return variationInstructions[
    Math.floor(Math.random() * variationInstructions.length)
  ];
}

// --------------------------------------------------
// IMAGE GENERATION
// --------------------------------------------------

app.post('/api/image', async (req, res) => {
  try {
    const { prompt, regenerate } = req.body;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({
        error: 'Image prompt is required.'
      });
    }

    let finalPrompt = prompt.trim();

    // When Regenerate is pressed, automatically force
    // the image model to create a substantially different version.
    if (regenerate === true) {
      const variation = getRandomVariation();

      finalPrompt = `${finalPrompt}

IMPORTANT VARIATION INSTRUCTION:
${variation}

The original request is the priority. Keep all important requested subjects, objects, text and details accurate, but make the resulting image clearly different from the previous generation.`;
    }

    console.log('IMAGE GENERATION:', finalPrompt);

    const response = await openai.images.generate({
      model: 'gpt-image-2',
      prompt: finalPrompt,
      size: '1024x1024',
      quality: 'medium',
      n: 1
    });

    console.log('IMAGE GENERATED SUCCESSFULLY');

    const imageData = response.data?.[0];

    if (!imageData) {
      throw new Error('No image returned from OpenAI.');
    }

    if (imageData.b64_json) {
      return res.json({
        image: `data:image/png;base64,${imageData.b64_json}`
      });
    }

    if (imageData.url) {
      return res.json({
        image: imageData.url
      });
    }

    throw new Error('Image response contained no usable image.');

  } catch (error) {
    console.error('IMAGE GENERATION ERROR:', error);

    res.status(500).json({
      error:
        error?.error?.message ||
        error?.message ||
        'Image generation failed.'
    });
  }
});

// --------------------------------------------------
// IMAGE EDITING
// --------------------------------------------------

app.post('/api/image/edit', async (req, res) => {
  try {
    const { prompt, image, regenerate } = req.body;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({
        error: 'Image edit prompt is required.'
      });
    }

    if (!image) {
      return res.status(400).json({
        error: 'An image is required.'
      });
    }

    console.log('IMAGE EDIT:', prompt);

    // ------------------------------------------------
    // Convert incoming image to a clean JPEG.
    // This prevents "Invalid image file or mode" errors.
    // ------------------------------------------------

    let originalBuffer;

    if (typeof image === 'string' && image.startsWith('data:')) {
      const base64Data = image.split(',')[1];

      if (!base64Data) {
        throw new Error('Invalid image data.');
      }

      originalBuffer = Buffer.from(base64Data, 'base64');
    } else {
      throw new Error('Unsupported image format.');
    }

    console.log(
      'ORIGINAL IMAGE:',
      originalBuffer.length,
      'bytes'
    );

    const normalizedBuffer = await sharp(originalBuffer)
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
        quality: 90,
        mozjpeg: true
      })
      .toBuffer();

    console.log(
      'IMAGE CONVERTED:',
      normalizedBuffer.length,
      'bytes'
    );

    const imageFile = await toFile(
      normalizedBuffer,
      'uploaded-image.jpg',
      {
        type: 'image/jpeg'
      }
    );

    let finalPrompt = prompt.trim();

    // Make regenerated edits visibly different.
    if (regenerate === true) {
      const variation = getRandomVariation();

      finalPrompt = `${finalPrompt}

IMPORTANT VARIATION INSTRUCTION:
${variation}

Keep the requested edit accurate, but create a noticeably different interpretation from the previous result.`;
    }

    console.log('SENDING IMAGE TO OPENAI...');

    const response = await openai.images.edit({
      model: 'gpt-image-2',
      image: imageFile,
      prompt: finalPrompt,
      size: '1024x1024',
      quality: 'medium',
      n: 1
    });

    console.log('IMAGE EDITED SUCCESSFULLY');

    const imageData = response.data?.[0];

    if (!imageData) {
      throw new Error('No edited image returned from OpenAI.');
    }

    if (imageData.b64_json) {
      return res.json({
        image: `data:image/png;base64,${imageData.b64_json}`
      });
    }

    if (imageData.url) {
      return res.json({
        image: imageData.url
      });
    }

    throw new Error(
      'Edited image response contained no usable image.'
    );

  } catch (error) {
    console.error('IMAGE EDIT ERROR:', error);

    res.status(500).json({
      error:
        error?.error?.message ||
        error?.message ||
        'Image editing failed.'
    });
  }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`Nastivee AI Bot running on port ${PORT}`);
});
