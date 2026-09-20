import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  return new OpenAI({
    apiKey,
    timeout: 60000
  });
}

// ===============================
// CHAT ROUTE
// ===============================

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

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: message
        }
      ]
    });

    const answer =
      completion.choices[0]?.message?.content || 'No response';

    return res.json({
      answer
    });

  } catch (error) {
    console.error('Chat error:', error);

    return res.status(500).json({
      error: error.message || 'Chat service error'
    });
  }
});


// ===============================
// IMAGE GENERATION ROUTE
// ===============================

app.post('/api/image', async (req, res) => {
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

  try {
    console.log('Attempting OpenAI image generation...');

    const response = await openai.images.generate({
      model: 'gpt-image-1',
      prompt: `${prompt}, realistic photograph, highly detailed`,
      size: '1024x1024'
    });

    const image = response?.data?.[0];

    // OpenAI returned base64 image data
    if (image?.b64_json) {
      console.log('OpenAI image generated successfully as base64.');

      return res.json({
        imageUrl: `data:image/png;base64,${image.b64_json}`
      });
    }

    // OpenAI returned an image URL
    if (image?.url) {
      console.log('OpenAI image generated successfully via URL.');

      return res.json({
        imageUrl: image.url
      });
    }

    console.error(
      'OpenAI returned no usable image:',
      response
    );

    return res.status(500).json({
      error: 'OpenAI generated no usable image.'
    });

  } catch (error) {

    console.error('OPENAI IMAGE ERROR:', {
      status: error?.status,
      message: error?.message,
      code: error?.code,
      type: error?.type
    });

    return res.status(error?.status || 500).json({
      error:
        error?.message ||
        'OpenAI image generation failed'
    });
  }
});


// ===============================
// START SERVER
// ===============================

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
