import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Helper function to safely load OpenAI only when called
function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({ apiKey });
}

// Chat Route
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const openai = getOpenAIClient();
    if (!openai) {
      return res.status(500).json({ error: 'OPENAI_API_KEY environment variable is missing on Render.' });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: message }],
    });

    const answer = completion.choices[0]?.message?.content || 'No response';
    return res.json({ answer });
  } catch (error) {
    console.error('Chat error:', error);
    return res.status(500).json({ error: error.message || 'Chat service error' });
  }
});

// Image Route
app.post('/api/image', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

  const openai = getOpenAIClient();

  // 1. Try DALL-E 3 if API Key exists
  if (openai) {
    try {
      console.log('Attempting DALL-E 3 generation...');
      const response = await openai.images.generate({
        model: "dall-e-3",
        prompt: prompt + ", realistic photograph, highly detailed, 8k resolution",
        n: 1,
        size: "1024x1024",
        quality: "standard"
      });

      if (response.data && response.data[0]?.url) {
        return res.json({ imageUrl: response.data[0].url });
      }
    } catch (dalleError) {
      console.warn('DALL-E 3 request failed, using backup engine:', dalleError.message);
    }
  } else {
    console.warn('OPENAI_API_KEY missing, using backup engine directly...');
  }

  // 2. High-speed Backup Engine (Always returns an image even without key)
  try {
    const safePrompt = encodeURIComponent(prompt.replace(/[^a-zA-Z0-9 ]/g, "").trim() + ', realistic photo');
    const seed = Date.now();
    const backupUrl = `https://image.pollinations.ai/prompt/${safePrompt}?width=768&height=768&nologo=true&seed=${seed}&model=flux`;

    return res.json({ imageUrl: backupUrl });
  } catch (fallbackError) {
    console.error('All image paths failed:', fallbackError);
    return res.status(500).json({ error: 'Failed to generate image' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
