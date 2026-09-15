/**
 * Mizan — Mosque Enrichment Script
 * Uses Gemini + Google Search to find prayer time pages for each mosque.
 * Run one city at a time:
 *
 *   set GEMINI_API_KEY=your_key
 *   set SUPABASE_URL=https://xxx.supabase.co
 *   set SUPABASE_SERVICE_ROLE_KEY=eyJ...
 *   set CITY=London
 *   npx tsx src/enrich-mosques.ts
 *
 * Safe to re-run — skips mosques already processed (has_online_presence not null).
 */

import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

// ── Config ───────────────────────────────────────────────────────────────────
const GEMINI_KEY   = process.env.GEMINI_API_KEY!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CITY         = (process.env.CITY ?? "London").trim();
const LIMIT        = process.env.LIMIT ? parseInt(process.env.LIMIT) : undefined;
const DELAY_MS     = 30000; // 2 req/min — safe for gemini-2.5-flash preview tier

if (!GEMINI_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌  Missing env vars: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const genAI    = new GoogleGenerativeAI(GEMINI_KEY);

const model = genAI.getGenerativeModel({
  model: "gemini-3.6-flash",
  tools: [{ googleSearch: {} } as any],
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Types ────────────────────────────────────────────────────────────────────
interface EnrichResult {
  found: boolean;
  url: string | null;
  source: "masjidbox" | "mawaqit" | "maktab_api" | "own_website" | "pdf" | "none";
  confidence: "high" | "medium" | "low";
}

// ── Gemini search ────────────────────────────────────────────────────────────
async function findPrayerTimesPage(name: string, city: string): Promise<EnrichResult> {
  const prompt = `
Search for the official prayer timetable page for "${name}" mosque in ${city}, UK.

I need to know if this specific mosque publishes its Salah or Jamaat times online.

Respond with ONLY a valid JSON object — no markdown, no explanation:
{
  "found": true or false,
  "url": "https://..." or null,
  "source": "masjidbox" or "mawaqit" or "maktab_api" or "own_website" or "pdf" or "none",
  "confidence": "high" or "medium" or "low"
}

Rules:
- "found" is true only if you found actual prayer/jamaat times for THIS specific mosque
- "source" is "masjidbox" if the URL is on masjidbox.com
- "source" is "mawaqit" if the URL is on mawaqit.net
- "source" is "maktab_api" if the URL is on maktabonline.co.uk
- "source" is "pdf" if the mosque publishes a downloadable PDF timetable
- "source" is "own_website" if they have their own website with prayer times
- "source" is "none" if nothing found or only calculated times (no jamaat times)
- "confidence" is "high" if the page clearly shows jamaat times, "low" if uncertain
`.trim();

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  // Extract JSON from response (Gemini sometimes wraps in markdown)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { found: false, url: null, source: "none", confidence: "low" };

  try {
    return JSON.parse(jsonMatch[0]) as EnrichResult;
  } catch {
    return { found: false, url: null, source: "none", confidence: "low" };
  }
}

// ── Source type → ingestion_type mapping ─────────────────────────────────────
function toIngestionType(source: string): string | null {
  const map: Record<string, string> = {
    masjidbox:   "masjidbox_api",
    mawaqit:     "mawaqit_api",
    maktab_api:  "maktab_api",
    own_website: "scraper_html",
    pdf:         "pdf",
    none:        "none",
  };
  return map[source] ?? null;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== Mizan Mosque Enrichment — ${CITY} ===\n`);

  // Fetch unprocessed mosques for this city
  const { data: mosques, error } = await supabase
    .from("mosques")
    .select("id, slug, name, city")
    .eq("city", CITY)
    .is("has_online_presence", null)
    .order("name");

  if (error) { console.error("DB error:", error.message); process.exit(1); }
  if (!mosques || mosques.length === 0) {
    console.log(`✅  All mosques in ${CITY} already processed.`);
    return;
  }

  const batch = LIMIT ? mosques.slice(0, LIMIT) : mosques;
  console.log(`📋  ${batch.length} of ${mosques.length} mosques to process in ${CITY}\n`);

  let found = 0;
  let notFound = 0;

  for (let i = 0; i < batch.length; i++) {
    const m = batch[i];
    process.stdout.write(`[${i + 1}/${mosques.length}] ${m.name} ... `);

    try {
      const result = await findPrayerTimesPage(m.name, m.city ?? CITY);

      const update: any = {
        has_online_presence: result.found,
      };

      if (result.found && result.url) {
        update.website_url    = result.url;
        update.ingestion_type = toIngestionType(result.source);
        update.feed_source    = result.url;
        update.status         = "verified";
        found++;
      } else {
        update.ingestion_type = "none";
        update.status         = "verified";
        notFound++;
      }

      await supabase.from("mosques").update(update).eq("id", m.id);

      if (result.found) {
        console.log(`✓ ${result.source} — ${result.url}`);
      } else {
        console.log(`— not found`);
      }

    } catch (err: any) {
      console.log(`⚠  error: ${err.message}`);
    }

    if (i < batch.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\n${"═".repeat(50)}`);
  console.log(`✅  Done! ${found} with online times, ${notFound} not found`);
  console.log(`${"═".repeat(50)}`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
