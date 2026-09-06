require("dotenv").config();
const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const xml2js = require("xml2js");
const fetch = require("node-fetch");
const fs = require("fs");
const { OpenAI } = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SITEMAP_URL = process.env.SITE_SITEMAP_URL;
const OUTPUT_FILE = "./index.json";

const STRIP_SELECTORS = "script, style, noscript, nav, footer, header, svg, form";

async function getSitemapUrls(sitemapUrl) {
  const res = await fetch(sitemapUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
  const xml = await res.text();
  let parsed;
  try {
    parsed = await xml2js.parseStringPromise(xml);
  } catch (err) {
    console.error("Sitemap did not return valid XML. First 300 chars of response:");
    console.error(xml.slice(0, 300));
    throw err;
  }

  if (parsed.sitemapindex) {
    const subSitemaps = parsed.sitemapindex.sitemap.map((s) => s.loc[0]);
    let all = [];
    for (const sm of subSitemaps) all = all.concat(await getSitemapUrls(sm));
    return all;
  }
  return parsed.urlset.url.map((u) => u.loc[0]);
}

function extractPageText($) {
  $(STRIP_SELECTORS).remove();
  const title = $("title").text().trim();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  return { title, text };
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
  if (!SITEMAP_URL) throw new Error("Set SITE_SITEMAP_URL in .env");
  console.log("Reading sitemap:", SITEMAP_URL);
  const urls = await getSitemapUrls(SITEMAP_URL);
  console.log(`Found ${urls.length} pages.`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const index = [];

  for (const url of urls) {
    let page;
    try {
      page = await browser.newPage();
      await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise((r) => setTimeout(r, 800));

      const html = await page.content();
      const $ = cheerio.load(html);
      const { title, text } = extractPageText($);
      if (!text || text.length < 40) continue;

      const chunks = chunkText(text);
      for (const chunk of chunks) {
        const embedding = await embed(chunk);
        index.push({ url, title, text: chunk, embedding, source: "website" });
      }
      console.log(`Indexed (${chunks.length} chunks): ${url}`);
    } catch (err) {
      console.warn(`Skipped ${url}: ${err.message}`);
    } finally {
      if (page) await page.close();
    }
  }

  await browser.close();

  let existing = [];
  if (fs.existsSync(OUTPUT_FILE)) {
    existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8")).filter((i) => i.source !== "website");
  }
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify([...existing, ...index]));
  console.log(`\nDone. Wrote ${index.length} website chunks to ${OUTPUT_FILE}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
