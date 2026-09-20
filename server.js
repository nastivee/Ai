import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Chat Route
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

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

// Bulletproof Image Route with Auto-Fallback
app.post('/api/image', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

  // 1. First Attempt: OpenAI DALL-E 3
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
  } catch (dalle3Error) {
    console.warn('DALL-E 3 failed/unauthorized, attempting DALL-E 2 fallback...', dalle3Error.message);
    
    // 2. Second Attempt: OpenAI DALL-E 2 (Works on all active API keys)
    try {
      const response2 = await openai.images.generate({
        model: "dall-e-2",
        prompt: prompt + ", realistic photograph, highly detailed",
        n: 1,
        size: "512x512"
      });

      if (response2.data && response2.data[0]?.url) {
        return res.json({ imageUrl: response2.data[0].url });
      }
    } catch (dalle2Error) {
      console.warn('DALL-E 2 failed, using high-reliability backup generator...', dalle2Error.message);
      
      // 3. Final Fail-Safe: Fast direct render so your app NEVER fails for the user
      const cleanPrompt = encodeURIComponent(prompt.replace(/[^a-zA-Z0-9 ]/g, "").trim() + ' realistic photo');
      const seed = Date.now();
      const backupUrl = `https://image.pollinations.ai/prompt/${cleanPrompt}?width=512&height=512&nologo=true&seed=${seed}`;
      
      return res.json({ imageUrl: backupUrl });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
