/**
 * discover-website.ts
 * Visits each mosque's website_url and looks for known prayer time
 * provider signatures in the HTML. Updates ingestion_type + feed_source.
 *
 * Providers detected:
 *   masjidbox_api   — masjidbox.com script/iframe in the page
 *   mawaqit_api     — mawaqit.net widget/embed in the page
 *   mymasjid_api    — mymasjid.com.au or salah.com embed
 *   monthly_pdf_ai  — link to a .pdf/.jpg/.png near "timetable"/"salah"/"prayer"
 *
 * Usage:
 *   cd C:\Users\Muzammil\Documents\mizan-api
 *   npx tsx src/discover-website.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const DELAY_MS  = 1500;   // pause between requests — be polite to mosque websites
const TIMEOUT   = 12000;  // 12 s per page

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Provider detection ────────────────────────────────────────────────────

interface DetectionResult {
  ingestion_type: string;
  feed_source: string | null;
}

function detect(html: string, pageUrl: string): DetectionResult | null {
  const h = html.toLowerCase();

  // 1. MasjidBox
  if (h.includes("masjidbox.com")) {
    // Try to extract masjid ID from the embed URL
    // e.g. https://masjidbox.com/prayer-times/east-london-mosque or
    //      src="https://masjidbox.com/..."
    const m = html.match(/masjidbox\.com\/(?:prayer-times|embed|widget)\/([a-z0-9\-]+)/i);
    return {
      ingestion_type: "masjidbox_api",
      feed_source: m ? m[1] : null,
    };
  }

  // 2. Mawaqit
  if (h.includes("mawaqit.net")) {
    // e.g. https://mawaqit.net/en/some-mosque-slug
    const m = html.match(/mawaqit\.net\/(?:en|fr|ar)\/([a-z0-9\-]+)/i);
    return {
      ingestion_type: "mawaqit_api",
      feed_source: m ? m[1] : null,
    };
  }

  // 3. MyMasjid / Salah.com
  if (h.includes("mymasjid.com.au") || h.includes("salah.com") || h.includes("mymasjid.eu")) {
    // e.g. https://www.mymasjid.com.au/widgets/Prayer-Times-Widget/?masjidID=1234
    const m = html.match(/masjidID=(\d+)/i) || html.match(/mymasjid[^"']*\/(\d+)/i);
    return {
      ingestion_type: "mymasjid_api",
      feed_source: m ? m[1] : null,
    };
  }

  // 4. PDF / image timetable
  // Look for links to PDFs or images near prayer-related words
  const pdfPattern = /href=["']([^"']+\.(?:pdf|jpg|jpeg|png))['"]/gi;
  const prayerWords = /timetable|prayer.?time|salah|salat|namaz|prayer.?schedule/i;
  let pdfMatch;
  while ((pdfMatch = pdfPattern.exec(html)) !== null) {
    // Check surrounding context (±300 chars)
    const start = Math.max(0, pdfMatch.index - 300);
    const end   = Math.min(html.length, pdfMatch.index + 300);
    const ctx   = html.slice(start, end);
    if (prayerWords.test(ctx)) {
      return {
        ingestion_type: "monthly_pdf_ai",
        feed_source: pdfMatch[1].startsWith("http")
          ? pdfMatch[1]
          : new URL(pdfMatch[1], pageUrl).href,
      };
    }
  }

  return null;
}

// ── Fetch with redirect follow ─────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; MizanBot/1.0; +https://mizan.app)",
      "Accept": "text/html",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  // Only read first 150 KB — enough to find any widget in <head> or early <body>
  const buf = await r.arrayBuffer();
  return new TextDecoder().decode(buf.slice(0, 150_000));
}

// ── Main ──────────────────────────────────────────────────────────────────

const { data: mosques, error } = await supabase
  .from("mosques")
  .select("id, name, website_url")
  .is("ingestion_type", null)
  .not("website_url", "is", null)
  .order("id");

if (error) { console.error("DB error:", error.message); process.exit(1); }

console.log(`[*] Scanning ${mosques!.length} mosque websites for provider signatures…\n`);

let tagged   = 0;
let noMatch  = 0;
let errored  = 0;

for (let i = 0; i < mosques!.length; i++) {
  const m = mosques![i]!;
  process.stdout.write(`  [${i+1}/${mosques!.length}] ${m.name.substring(0,38).padEnd(38)} `);

  let html: string;
  try {
    html = await fetchHtml(m.website_url!);
  } catch (e: any) {
    process.stdout.write(`✗ fetch: ${e.message.substring(0,50)}\n`);
    errored++;
    await sleep(DELAY_MS);
    continue;
  }

  const result = detect(html, m.website_url!);

  if (!result) {
    process.stdout.write("– no provider found\n");
    noMatch++;
    await sleep(DELAY_MS);
    continue;
  }

  const patch: any = {
    ingestion_type:      result.ingestion_type,
    has_online_presence: true,
  };
  if (result.feed_source) patch.feed_source = result.feed_source;

  const { error: upErr } = await supabase
    .from("mosques")
    .update(patch)
    .eq("id", m.id);

  if (upErr) {
    process.stdout.write(`✗ DB: ${upErr.message}\n`);
    errored++;
  } else {
    const src = result.feed_source ? ` → ${result.feed_source}` : "";
    process.stdout.write(`✓ ${result.ingestion_type}${src}\n`);
    tagged++;
  }

  if ((i + 1) % 25 === 0) {
    console.log(`\n  ── checkpoint: ${tagged} tagged, ${noMatch} no match, ${errored} errors ──\n`);
  }

  await sleep(DELAY_MS);
}

console.log(`\n[DONE] ${tagged} tagged, ${noMatch} no provider found, ${errored} errors`);
console.log(`\nBreakdown by type:`);

const { data: counts } = await supabase
  .from("mosques")
  .select("ingestion_type")
  .not("ingestion_type", "is", null);

const breakdown: Record<string, number> = {};
(counts ?? []).forEach((r: any) => {
  breakdown[r.ingestion_type] = (breakdown[r.ingestion_type] ?? 0) + 1;
});
Object.entries(breakdown)
  .sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`  ${k.padEnd(20)} ${v}`));
