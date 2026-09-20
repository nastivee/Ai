import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '20mb' }));

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  return new OpenAI({
    apiKey,
    timeout: 120000
  });
}

// ==================================================
// CHAT
// ==================================================

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
      completion.choices?.[0]?.message?.content || 'No response';

    res.json({
      answer
    });

  } catch (error) {
    console.error('CHAT ERROR:', error);

    res.status(error?.status || 500).json({
      error: error?.message || 'Chat service error'
    });
  }
});


// ==================================================
// IMAGE GENERATION
// ==================================================

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

    console.log('========================================');
    console.log('IMAGE REQUEST');
    console.log('Prompt:', prompt);
    console.log('Model: gpt-image-2.5-flare');
    console.log('========================================');

    const response = await openai.images.generate({
      model: 'gpt-image-2.5-flare',

      prompt: prompt,

      size: '1024x1024',

      quality: 'high',

      n: 1
    });

    const image = response?.data?.[0];

    if (!image) {
      console.error('No image returned from OpenAI.');

      return res.status(500).json({
        error: 'OpenAI returned no image.'
      });
    }

    // ==============================================
    // BASE64 IMAGE
    // ==============================================

    if (image.b64_json) {

      console.log('Image generated successfully.');
      console.log('Returning base64 image to frontend.');

      return res.json({
        imageUrl: `data:image/png;base64,${image.b64_json}`
      });
    }

    // ==============================================
    // URL IMAGE
    // ==============================================

    if (image.url) {

      console.log('Image generated successfully.');
      console.log('Returning image URL to frontend.');

      return res.json({
        imageUrl: image.url
      });
    }

    // ==============================================
    // NOTHING USABLE
    // ==============================================

    console.error(
      'OpenAI returned an unexpected image response:',
      response
    );

    return res.status(500).json({
      error: 'OpenAI returned an image in an unsupported format.'
    });

  } catch (error) {

    console.error('========================================');
    console.error('OPENAI IMAGE ERROR');
    console.error('Status:', error?.status);
    console.error('Code:', error?.code);
    console.error('Type:', error?.type);
    console.error('Message:', error?.message);
    console.error('========================================');

    return res.status(error?.status || 500).json({
      error:
        error?.message ||
        'Image generation failed.'
    });
  }
});


// ==================================================
// SERVER
// ==================================================

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
