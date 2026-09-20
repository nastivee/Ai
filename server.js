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

// Multi-word Reliable Image Route
app.post('/api/image', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    // 1. Clean multi-word text into a safe string
    const safePrompt = prompt.replace(/[^a-zA-Z0-9 ]/g, "").trim();
    const encoded = encodeURIComponent(safePrompt + ' realistic photo highly detailed');
    const uniqueSeed = Date.now();

    // 2. Direct high-speed link optimized for multi-word phrases
    const imageUrl = `https://image.pollinations.ai/prompt/${encoded}?width=512&height=512&nologo=true&seed=${uniqueSeed}&model=flux`;

    return res.json({ imageUrl });
  } catch (error) {
    console.error('Image route error:', error);
    return res.status(500).json({ error: 'Failed to generate image' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
