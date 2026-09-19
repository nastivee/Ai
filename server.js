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

// Image Route - Always sends Base64 data so browsers cannot block it
app.post('/api/image', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

  // 1. Try DALL-E 3 with native base64 output
  try {
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: prompt + ", realistic photograph, highly detailed, 8k resolution",
      n: 1,
      size: "1024x1024",
      response_format: "b64_json"
    });

    if (response.data && response.data[0]?.b64_json) {
      return res.json({ imageUrl: `data:image/png;base64,${response.data[0].b64_json}` });
    }
  } catch (error) {
    console.error('OpenAI image error, switching to fallback converter:', error.message);
  }

  // 2. Fallback: Download image on backend and convert to base64
  try {
    const encodedPrompt = encodeURIComponent(prompt + ', realistic photo, 8k');
    const fallbackUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true`;
    
    const imgResponse = await fetch(fallbackUrl);
    const arrayBuffer = await imgResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64Img = `data:image/jpeg;base64,${buffer.toString('base64')}`;

    return res.json({ imageUrl: base64Img });
  } catch (err) {
    console.error('Fallback image fetch failed:', err);
    return res.status(500).json({ error: 'Failed to generate image.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
