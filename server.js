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

// Chat route
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

// Image route (Bypasses text chat and sends directly to DALL-E 3)
app.post('/api/image', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    // Forces OpenAI to use its image generation engine
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: prompt + ", realistic photograph, highly detailed, 8k resolution",
      n: 1,
      size: "1024x1024",
    });

    const imageUrl = response.data[0]?.url;
    return res.json({ imageUrl });
  } catch (error) {
    console.error('Image route error:', error);
    return res.status(500).json({ error: error.message || 'Failed to generate image' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
