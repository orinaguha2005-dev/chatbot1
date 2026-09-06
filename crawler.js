/**
 * crawler.js
 * ----------
 * Reads your website's sitemap.xml, visits every page using a real
 * headless browser (Puppeteer), extracts the meaningful text AFTER
 * JavaScript has rendered it, splits it into chunks, embeds each chunk
 * with OpenAI, and saves everything into index.json.
 *
 * WHY PUPPETEER (not a simple fetch): jhsassociates.in — like many modern
 * sites — loads its real content with JavaScript after the initial page
 * load. A plain fetch() only sees the empty "shell" HTML, not the actual
 * text. Puppeteer runs a real browser so it sees the page exactly like a
 * visitor would, then reads the finished result.
 *
 * Run manually:      node crawler.js
 * Run on a schedule:  a nightly cron job / GitHub Action / Render cron
 *                      job calling `node crawler.js` keeps index.json fresh
 *                      automatically — no manual editing required.
 */

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

// ---- sitemap reading (plain fetch is fine here — sitemaps are static XML) --

async function getSitemapUrls(sitemapUrl) {
  const res = await fetch(sitemapUrl);
  const xml = await res.text();
  const parsed = await xml2js.parseStringPromise(xml);

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

// ---- main crawl (Puppeteer visits each page like a real visitor) ----------

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
      // Small extra wait for any late-loading content (e.g. team cards, sector lists)
      await new Promise((r) => setTimeout(r, 800));

      const html = await page.content(); // fully rendered HTML, after JS ran
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

  // Preserve any MongoDB ("source: mongodb") entries already in the index
  // when re-running just the website crawl
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
