/**
 * Mizan — UK Mosque Seeder
 * Scrapes mosquenearme.net and inserts all UK mosques into Supabase.
 * Run once as a seed operation. Safe to re-run — skips slugs already in DB.
 *
 * Usage:
 *   set SUPABASE_URL=https://xxx.supabase.co
 *   set SUPABASE_SERVICE_ROLE_KEY=eyJ...
 *   npx tsx src/seed-mosques.ts
 */

import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE = "https://mosquenearme.net";
const DELAY_MS = 1500;   // ms between requests — be polite
const BATCH_SIZE = 50;   // upsert to Supabase every N mosques

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌  Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars first");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function extractCoords(html: string): [number, number] | null {
  // Try Google Maps embed URL: @lat,lng or q=lat,lng or center=lat,lng
  const patterns = [
    /\/@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /center=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /ll=(-?\d+\.\d+),(-?\d+\.\d+)/,
    // Plain coordinate pair in text (e.g. "51.5443534015, 0.077290535")
    /\b(5[0-5]\.\d{4,}),\s*(-?\d+\.\d{4,})\b/,  // UK lat range 50-55
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
      if (lat >= 49 && lat <= 61 && lng >= -8 && lng <= 2) return [lat, lng];
    }
  }
  return null;
}

function extractPhone(text: string): string | null {
  const m = text.match(/(?:tel|phone|call)?[:\s]*(0\d{2,4}[\s\-]?\d{3,4}[\s\-]?\d{3,4})/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

function extractWebsite($: cheerio.CheerioAPI): string | null {
  let site: string | null = null;
  $("a[href^='http']").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (
      !href.includes("mosquenearme.net") &&
      !href.includes("google.com") &&
      !href.includes("facebook.com") &&
      !href.includes("twitter.com") &&
      !href.includes("instagram.com") &&
      !href.includes("youtube.com") &&
      href.startsWith("http")
    ) {
      site = href.split("?")[0].replace(/\/$/, "");
      return false; // break
    }
  });
  return site;
}

function extractType(text: string): string | null {
  const m = text.match(/Purpose-built Mosque|Converted Building|Community Mosque|University Prayer Room/i);
  return m ? m[0] : null;
}

function extractAddress($: cheerio.CheerioAPI): string | null {
  // Try common address selectors
  const candidates = [
    $("[class*='address']").first().text().trim(),
    $("[itemprop='streetAddress']").first().text().trim(),
    $("address").first().text().trim(),
  ];
  for (const c of candidates) {
    if (c && c.length > 3 && c.length < 120) return c.replace(/\s+/g, " ");
  }

  // Fallback: find a paragraph that looks like a street address
  let found: string | null = null;
  $("p, li, td, span").each((_, el) => {
    const t = $( el).text().replace(/\s+/g, " ").trim();
    if (/^\d+\s+\w/.test(t) && t.length < 120 && !found) {
      found = t;
    }
  });
  return found;
}

function extractPostcode(text: string): string | null {
  const m = text.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2})\b/i);
  return m ? m[1].toUpperCase().replace(/\s+/g, " ") : null;
}

function extractCity($: cheerio.CheerioAPI, text: string): string | null {
  // Try itemprop
  const city = $("[itemprop='addressLocality']").first().text().trim();
  if (city) return city;
  // Try breadcrumb — usually includes city name
  const crumbs = $("nav[aria-label*='read'], .breadcrumb, [class*='breadcrumb']").text();
  if (crumbs) {
    const parts = crumbs.split(/[›»/|>]/).map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) return parts[parts.length - 2] ?? null;
  }
  return null;
}

// ── Step 1: get all mosque slugs ────────────────────────────────────────────
async function getAllSlugs(): Promise<string[]> {
  console.log("📋  Fetching full mosque list from mosquenearme.net...");
  const html = await fetchHtml(`${BASE}/mosques`);
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const slugs: string[] = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const m = href.match(/^\/mosques\/([^/]+)\/?$/);
    if (m && m[1] && !seen.has(m[1])) {
      seen.add(m[1]);
      slugs.push(m[1]);
    }
  });

  return slugs;
}

// ── Step 2: scrape one mosque detail page ────────────────────────────────────
interface MosqueRow {
  slug: string;
  name: string;
  address: string | null;
  city: string | null;
  postcode: string | null;
  latitude: number | null;
  longitude: number | null;
  website_url: string | null;
  status: string;
  ingestion_type: null;
  feed_source: null;
  has_online_presence: null;
}

async function scrapeMosque(slug: string): Promise<MosqueRow | null> {
  const url = `${BASE}/mosques/${slug}/`;
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const text = $.text();

    const coords = extractCoords(html);
    const postcode = extractPostcode(text);
    const city = extractCity($, text);

    return {
      slug,
      name: $("h1").first().text().trim() || slug,
      address: extractAddress($),
      city,
      postcode,
      latitude: coords?.[0] ?? null,
      longitude: coords?.[1] ?? null,
      website_url: extractWebsite($),
      status: "discovered",
      ingestion_type: null,
      feed_source: null,
      has_online_presence: null,
    };
  } catch (err: any) {
    console.warn(`  ⚠  ${slug}: ${err.message}`);
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Mizan UK Mosque Seeder ===\n");

  const slugs = await getAllSlugs();
  console.log(`✅  Found ${slugs.length} mosques on mosquenearme.net\n`);

  // Skip slugs already in DB
  const { data: existing } = await supabase.from("mosques").select("slug");
  const existingSet = new Set((existing ?? []).map((r: any) => r.slug));
  const toFetch = slugs.filter(s => !existingSet.has(s));

  console.log(`📦  ${existingSet.size} already in DB — fetching ${toFetch.length} new mosques`);
  const eta = Math.round((toFetch.length * DELAY_MS) / 60_000);
  console.log(`⏱   Estimated time: ~${eta} minutes\n`);

  let done = 0;
  let saved = 0;
  let failed = 0;
  let batch: MosqueRow[] = [];

  for (const slug of toFetch) {
    const row = await scrapeMosque(slug);
    done++;

    if (row) {
      batch.push(row);
      console.log(`✓ [${done}/${toFetch.length}] ${row.name} — ${row.city ?? "?"} ${row.postcode ?? ""}`);
    } else {
      failed++;
    }

    // Flush batch
    if (batch.length >= BATCH_SIZE || done === toFetch.length) {
      if (batch.length > 0) {
        const { error } = await supabase
          .from("mosques")
          .upsert(batch, { onConflict: "slug" });
        if (error) {
          console.error(`  ❌  Batch upsert failed: ${error.message}`);
        } else {
          saved += batch.length;
          console.log(`  → 💾  Saved batch of ${batch.length} (total saved: ${saved})\n`);
        }
        batch = [];
      }
    }

    await sleep(DELAY_MS + Math.random() * 500); // jitter
  }

  console.log("═══════════════════════════════════════");
  console.log(`✅  Done! ${saved} saved, ${failed} failed, ${existingSet.size} skipped`);
  console.log("═══════════════════════════════════════");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
