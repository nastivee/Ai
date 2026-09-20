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

// Fast, Reliable Image Route
app.post('/api/image', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    const seed = Math.floor(Math.random() * 100000);
    // Optimized prompt & 512x512 size for 3x faster generation speeds
    const encodedPrompt = encodeURIComponent(prompt + ', realistic photo, detailed');
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=512&height=512&nologo=true&seed=${seed}`;

    // Download image with a safety controller to prevent browser timeouts
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const imageResponse = await fetch(imageUrl, { signal: controller.signal });
    clearTimeout(timeout);

    const arrayBuffer = await imageResponse.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString('base64');
    const dataUri = `data:image/jpeg;base64,${base64Data}`;

    return res.json({ imageUrl: dataUri });
  } catch (error) {
    console.error('Image generation error:', error);
    
    // Fast Direct URL Fallback if server fetch exceeds 12s
    const seed = Math.floor(Math.random() * 100000);
    const fallbackPrompt = encodeURIComponent(req.body.prompt || 'photo');
    const directUrl = `https://image.pollinations.ai/prompt/${fallbackPrompt}?width=512&height=512&nologo=true&seed=${seed}`;
    
    return res.json({ imageUrl: directUrl });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
