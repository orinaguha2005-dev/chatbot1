/**
 * server.js
 * ---------
 * The only thing the browser talks to. Keeps the OpenAI key private,
 * retrieves only the relevant page chunks for a question, and enforces
 * the "website content only, never the site's tech stack" rules.
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const { OpenAI } = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use(express.static("public")); // serves /widget.js and /demo.html

// Basic abuse protection — also protects your OpenAI bill
app.use(
  "/api/chat",
  rateLimit({ windowMs: 60 * 1000, max: 15, message: { error: "Too many requests, slow down." } })
);

// ---- load the content index built by crawler.js ------------------------

let INDEX = [];
function loadIndex() {
  if (!fs.existsSync("./index.json")) {
    console.warn("index.json not found — run `npm run crawl` first.");
    return;
  }
  INDEX = JSON.parse(fs.readFileSync("./index.json", "utf-8"));
  console.log(`Loaded ${INDEX.length} indexed chunks.`);
}
loadIndex();
// Re-load automatically if the crawler updates the file while the server runs
fs.watchFile("./index.json", { interval: 60000 }, loadIndex);

// ---- simple in-memory cache (cost saver for repeated questions) --------

const CACHE = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_TTL_MS) {
    CACHE.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key, value) {
  CACHE.set(key, { value, time: Date.now() });
}

// ---- retrieval: cosine similarity over the local index ------------------

function cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function retrieveRelevantChunks(question, topK = 3) {
  const embedRes = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: question,
  });
  const qVec = embedRes.data[0].embedding;

  const scored = INDEX.map((item) => ({
    ...item,
    score: cosineSim(qVec, item.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ---- the guardrail system prompt ----------------------------------------

const SYSTEM_PROMPT = `You are the website assistant for this company. Answer visitor questions ONLY using the "CONTEXT" provided below, which comes from the live website.

Rules you must always follow:
- Only use facts present in the CONTEXT. If the answer isn't in the CONTEXT, say you don't have that information — never guess or invent details.
- If asked about how this website was built, its technology, code, hosting, or any technical implementation, politely decline and steer back to helping with services/team/content. Example: "I can help with information about our services and team, not the site's technical setup."
- When a specific page or person from the CONTEXT is clearly the answer, end your reply on a new line with:
  [[LINK: <exact url from context> | <short button label like "View Profile" or "Connect">]]
  Never invent a URL that isn't in the CONTEXT.
- Keep answers short (2-4 sentences) and conversational.`;

// ---- the chat endpoint ----------------------------------------------------

app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing 'message'." });
    }

    const cacheKey = message.trim().toLowerCase();
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    const topChunks = await retrieveRelevantChunks(message);
    const context = topChunks
      .map((c, i) => `[${i + 1}] Source: ${c.url}\n${c.text}`)
      .join("\n\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // cheap + fast, plenty capable for this
      max_tokens: 300,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `CONTEXT:\n${context}\n\nQUESTION: ${message}` },
      ],
    });

    const raw = completion.choices[0].message.content;

    // Pull out the [[LINK: url | label]] marker, if present
    const linkMatch = raw.match(/\[\[LINK:\s*(.*?)\s*\|\s*(.*?)\]\]/);
    const reply = raw.replace(/\[\[LINK:.*?\]\]/, "").trim();
    const link = linkMatch ? { url: linkMatch[1], label: linkMatch[2] } : null;

    const payload = { reply, link };
    cacheSet(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong." });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true, indexedChunks: INDEX.length }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Chatbot backend running on port ${PORT}`));
