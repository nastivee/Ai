import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const dataDir = path.join(process.cwd(), "data");
const memoryFile = path.join(dataDir, "memory.json");

// Create the data folder automatically so Render does not crash on first save.
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let memory = [];
if (fs.existsSync(memoryFile)) {
  try {
    memory = JSON.parse(fs.readFileSync(memoryFile, "utf8"));
    if (!Array.isArray(memory)) memory = [];
  } catch {
    memory = [];
  }
}

function save() {
  fs.writeFileSync(memoryFile, JSON.stringify(memory, null, 2), "utf8");
}

const SYSTEM_PROMPT = `
You are AI Lab, an experimental personal AI assistant.

Goals:
- Be highly capable at reasoning, coding, planning and problem solving.
- Give direct, useful answers.
- Adapt to the user's preferred style.
- Learn from previous conversations.
- Identify mistakes and improve future responses.
- Ask questions only when genuinely necessary.
- Never pretend you completed an action you did not complete.

Self-improvement:
After important interactions, identify what worked, what was wrong, and what could improve next time.
You may improve reasoning strategies and response style, but do not modify security boundaries, access controls, or execute unapproved code on external systems.
`;

app.get("/", (req, res) => {
  res.send("AI Lab backend is running");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, memoryItems: memory.length });
});

app.post("/api/chat", async (req, res) => {
  try {
    const message = req.body?.message;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message required" });
    }

    const recentMemory = memory.slice(-20)
      .map(x => `${x.role}: ${x.content}`)
      .join("\n");

    const response = await client.responses.create({
      model: "gpt-5.6",
      instructions: SYSTEM_PROMPT,
      input: `Previous conversation memory:\n\n${recentMemory}\n\nUser:\n${message}`
    });

    const answer = response.output_text || "No response received.";

    memory.push(
      { role: "user", content: message },
      { role: "assistant", content: answer }
    );

    if (memory.length > 100) {
      memory.splice(0, memory.length - 100);
    }

    save();

    res.json({ answer });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "AI request failed" });
  }
});

// Image Generation Endpoint (using default OpenAI image generation model)
app.post("/api/image", async (req, res) => {
  try {
    const prompt = req.body?.prompt;
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Prompt required" });
    }

    const response = await client.images.generate({
      prompt: prompt,
      n: 1,
      size: "1024x1024",
    });

    const imageUrl = response.data[0].url;
    res.json({ imageUrl });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Image generation failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`AI Lab backend running on port ${port}`);
});
