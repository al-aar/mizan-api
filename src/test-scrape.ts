/**
 * Test scraper — first 10 Glasgow mosques only
 * Run: npx tsx src/test-scrape.ts
 */
import * as cheerio from "cheerio";

const BASE = "https://mosquenearme.net";
const DELAY_MS = 1500;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const TEST_SLUGS = [
  "al-falaah-academy-glasgow",
  "al-furqan-islamic-centre-glasgow",
  "ahlulbait-mosque-glasgow",
  "al-huda-masjid-glasgow",
  "glasgow-islamic-centre-and-central-mosque-glasgow",
  "jamia-islamia-glasgow",
  "masjid-e-khizra-glasgow",
  "masjid-al-farooq-glasgow",
  "masjid-noor-glasgow",
  "salahuddin-mosque-and-islamic-centre-glasgow",
];

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Extract UK coordinates from page text
function extractCoords(text: string): [number, number] | null {
  // Pattern: two numbers like "55.8523000464, -4.2511940002"
  const m = text.match(/\b((?:4[9-9]|5\d)\.\d{4,}),\s*(-?\d+\.\d{4,})\b/);
  if (m) {
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (lat >= 49 && lat <= 61 && lng >= -8 && lng <= 2) return [lat, lng];
  }
  return null;
}

// Extract street address — must look like a real address, not capacity text
function extractAddress($: cheerio.CheerioAPI): string | null {
  const text = $.text();
  // Look for lines starting with a number and a street name
  const lines = text.split(/\n|\r/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (
      /^\d+\s+[A-Za-z]/.test(line) &&          // starts with number + word
      !line.includes("worshippers") &&           // not capacity text
      !line.includes("Fajr") &&                  // not prayer times
      line.length > 5 &&
      line.length < 80
    ) {
      return line;
    }
  }
  return null;
}

// Extract phone number
function extractPhone(text: string): string | null {
  const m = text.match(/0\d{2,4}[\s\-]?\d{3,4}[\s\-]?\d{3,4}/);
  return m ? m[0].trim() : null;
}

// Extract mosque type
function extractType(text: string): string | null {
  const m = text.match(/Purpose-built Mosque|Converted Building|Community Mosque|University Prayer Room/i);
  return m ? m[0] : null;
}

// Extract city from slug — slugs end with the city name e.g. "-glasgow"
function cityFromSlug(slug: string): string {
  // Split by hyphens, then walk back to find where the city name starts
  // Strategy: city name is the trailing segment after the mosque name
  // For Glasgow slugs they end with "-glasgow"
  const parts = slug.split("-");
  // Check last 1-3 words as potential city
  for (let n = 3; n >= 1; n--) {
    const candidate = parts.slice(-n).join(" ");
    // Simple heuristic: if the candidate appears in a known list or looks like a place name
    if (candidate.length > 2) return toTitleCase(candidate);
  }
  return toTitleCase(parts[parts.length - 1]);
}

function toTitleCase(s: string): string {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

// Check if mosque has daily/jumu'ah prayers (useful for has_online_presence later)
function hasPrayers(text: string): boolean {
  return text.includes("Daily Prayers") || text.includes("Jumu'ah Prayers");
}

async function scrapeOne(slug: string) {
  const url = `${BASE}/mosques/${slug}/`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const text = $.text();

  const name = $("h1").first().text().trim();
  const coords = extractCoords(text);
  const address = extractAddress($);
  const phone = extractPhone(text);
  const type = extractType(text);
  const city = cityFromSlug(slug);
  const prayers = hasPrayers(text);

  return { slug, name, city, address, coords, phone, type, prayers };
}

async function main() {
  console.log("=== Test Scrape: 10 Glasgow Mosques ===\n");

  for (const slug of TEST_SLUGS) {
    try {
      const d = await scrapeOne(slug);
      console.log(`✓ ${d.name}`);
      console.log(`  city:    ${d.city}`);
      console.log(`  address: ${d.address ?? "—"}`);
      console.log(`  coords:  ${d.coords ? `${d.coords[0]}, ${d.coords[1]}` : "—"}`);
      console.log(`  phone:   ${d.phone ?? "—"}`);
      console.log(`  type:    ${d.type ?? "—"}`);
      console.log(`  prayers: ${d.prayers ? "yes" : "no"}`);
      console.log();
    } catch (err: any) {
      console.error(`✗ ${slug}: ${err.message}\n`);
    }
    await sleep(DELAY_MS);
  }

  console.log("Done.");
}

main();
