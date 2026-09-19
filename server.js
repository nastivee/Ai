import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Text Chat Route
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

// Guaranteed Image Route (Returns Base64 image data directly so Safari can't block it)
app.post('/api/image', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

  // 1. Try DALL-E 3 returning direct base64 image data
  try {
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: prompt + ", realistic photograph, highly detailed, 8k resolution",
      n: 1,
      size: "1024x1024",
      response_format: "b64_json"
    });

    if (response.data && response.data[0]?.b64_json) {
      const base64Image = `data:image/png;base64,${response.data[0].b64_json}`;
      return res.json({ imageUrl: base64Image });
    }
  } catch (error) {
    console.error('OpenAI image error, using reliable fallback:', error.message);
  }

  // 2. High-reliability fallback if OpenAI key lacks credits
  const encodedPrompt = encodeURIComponent(prompt + ', realistic photo, 8k');
  const backupUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true`;
  return res.json({ imageUrl: backupUrl });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
