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

// Multi-Subject Image Route
app.post('/api/image', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    // Clean text and build an explicit multi-subject composition prompt
    const cleanPrompt = prompt.replace(/[^a-zA-Z0-9 ]/g, "").trim();
    const compositionPrompt = `photograph showing ${cleanPrompt} together in one scene, full body, realistic lighting, hyperdetailed photo, 8k`;
    
    const encoded = encodeURIComponent(compositionPrompt);
    const uniqueSeed = Date.now() + Math.floor(Math.random() * 1000);

    // Uses model=turbo for fast multi-object spatial reasoning
    const imageUrl = `https://image.pollinations.ai/prompt/${encoded}?width=768&height=768&nologo=true&seed=${uniqueSeed}&model=turbo`;

    return res.json({ imageUrl });
  } catch (error) {
    console.error('Image route error:', error);
    return res.status(500).json({ error: 'Failed to generate image' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
