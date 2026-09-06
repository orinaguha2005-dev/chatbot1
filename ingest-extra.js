/**
 * ingest-extra.js
 * ----------------
 * Reads records from YOUR MongoDB database and adds them into the same
 * index.json that crawler.js builds from your website — so the chatbot
 * answers from BOTH the website AND your database, together.
 *
 * WHERE TO PUT YOUR DETAILS: all in your .env file (see .env.example) —
 * MONGO_URI, MONGO_DB_NAME, MONGO_COLLECTION. Nothing to edit here for
 * the connection itself.
 *
 * YOU MAY need to edit the buildTextFromRecord() function below if your
 * MongoDB documents use different field names than name/bio/expertise/url
 * (see comments inside that function).
 *
 * Run: node ingest-extra.js   (or: npm run crawl:extra)
 */

require("dotenv").config();
const fs = require("fs");
const { MongoClient } = require("mongodb");
const { OpenAI } = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const INDEX_FILE = "./index.json";

// ---------------------------------------------------------------------------
// EDIT THIS if your MongoDB documents use different field names.
// Turns one MongoDB document into { url, title, text } for the chatbot.
// ---------------------------------------------------------------------------
function buildTextFromRecord(doc) {
  // Common field name guesses — change the doc.xxx parts to match YOUR
  // actual MongoDB field names (check one document in Atlas/Compass first).
  const name = doc.name || doc.fullName || "Untitled";
  const bio = doc.bio || doc.description || "";
  const expertise = doc.expertise || doc.sector || doc.role || "";
  const url = doc.profileUrl || doc.url || doc.link || null;

  return {
    url,
    title: name,
    text: `${name}${expertise ? " — " + expertise : ""}. ${bio}`.trim(),
  };
}

function chunkText(text, maxLen = 800) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = "";
  for (const s of sentences) {
    if ((current + " " + s).length > maxLen && current) {
      chunks.push(current.trim());
      current = s;
    } else {
      current += " " + s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function embed(text) {
  const res = await openai.embeddings.create({ model: "text-embedding-3-small", input: text });
  return res.data[0].embedding;
}

async function run() {
  if (!process.env.MONGO_URI) {
    console.log("MONGO_URI not set in .env — skipping MongoDB ingest.");
    return;
  }

  console.log("Connecting to MongoDB...");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db(process.env.MONGO_DB_NAME);
  const collection = db.collection(process.env.MONGO_COLLECTION);

  const docs = await collection.find({}).toArray();
  console.log(`Found ${docs.length} documents in ${process.env.MONGO_COLLECTION}.`);
  await client.close();

  // Load existing index (built by crawler.js) so we ADD to it, not overwrite it
  let index = [];
  if (fs.existsSync(INDEX_FILE)) index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));

  // Remove previous MongoDB entries so re-running this script updates them
  // instead of duplicating them endlessly
  index = index.filter((item) => item.source !== "mongodb");

  for (const doc of docs) {
    const record = buildTextFromRecord(doc);
    if (!record.text || record.text.length < 10) continue;

    const chunks = chunkText(record.text);
    for (const chunk of chunks) {
      const embedding = await embed(chunk);
      index.push({ url: record.url, title: record.title, text: chunk, embedding, source: "mongodb" });
    }
  }

  fs.writeFileSync(INDEX_FILE, JSON.stringify(index));
  console.log(`Done. MongoDB records added. Total chunks in index now: ${index.length}`);
}

run().catch((err) => {
  console.error("MongoDB ingest failed:", err.message);
  process.exit(1);
});
