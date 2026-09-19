import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Initialize OpenAI using your API key from Render Environment Variables
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Chat route (uses gpt-4o-mini for text chat)
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

// Image route (uses standard DALL-E 3 for generating photos)
app.post('/api/image', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: prompt + ", high quality realistic photo, highly detailed, 8k resolution",
      n: 1,
      size: "1024x1024",
    });

    const imageUrl = response.data[0]?.url;
    return res.json({ imageUrl });
  } catch (error) {
    console.error('Image error:', error);
    return res.status(500).json({ error: error.message || 'Failed to generate image' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
