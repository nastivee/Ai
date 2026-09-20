import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// This connects directly to your OpenAI API account using your key
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Chat Route (GPT-4o Mini)
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

// DALL-E 3 Image Route
app.post('/api/image', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    // Sends the request to OpenAI's DALL-E 3 model
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: prompt + ", realistic photograph, highly detailed, 8k resolution, natural lighting",
      n: 1,
      size: "1024x1024",
      quality: "standard"
    });

    if (response.data && response.data[0]?.url) {
      return res.json({ imageUrl: response.data[0].url });
    } else {
      return res.status(500).json({ error: 'No image URL returned by OpenAI' });
    }
  } catch (error) {
    console.error('OpenAI DALL-E 3 Error:', error);
    // Returns the exact OpenAI error message to your chat window if it fails
    return res.status(500).json({ error: error.message || 'DALL-E 3 generation failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

