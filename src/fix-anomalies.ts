/**
 * fix-anomalies.ts
 * Finds and fixes data anomalies in the mosques table:
 *
 *  1. "Unnamed Mosque" — re-queries OSM Overpass API by osm_id to get the
 *     current name. If still no name, tries Nominatim for a nearby POI name.
 *     If nothing found, flags status = 'needs_review'.
 *
 *  2. Very short names (< 4 chars) — likely bad data, flags for review.
 *
 *  3. Duplicate names in the same city — lists them so you can decide.
 *
 * Usage:
 *   cd C:\Users\Muzammil\Documents\mizan-api
 *   npx tsx src/fix-anomalies.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const DELAY_MS = 1100;
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── 1. Fix "Unnamed Mosque" entries ──────────────────────────────────────

async function getOsmName(osmId: number): Promise<string | null> {
  try {
    // Try node first, then way, then relation
    for (const type of ["node", "way", "relation"]) {
      const query = `[out:json][timeout:10];${type}(${osmId});out tags;`;
      const r = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        body: `data=${encodeURIComponent(query)}`,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) continue;
      const data = await r.json() as any;
      const el = data.elements?.[0];
      if (!el) continue;
      const name = el.tags?.name || el.tags?.["name:en"];
      if (name) return name;
    }
    return null;
  } catch { return null; }
}

async function getNominatimName(lat: number, lon: number): Promise<string | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
    const r = await fetch(url, {
      headers: { "User-Agent": "MizanApp/1.0 (muzammil1124@gmail.com)", "Accept-Language": "en" },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const data = await r.json() as any;
    // Use the display name only if it looks like a mosque/islamic centre
    const display = data.display_name ?? "";
    if (/mosque|masjid|islamic|muslim/i.test(display)) {
      return data.name ?? null;
    }
    return null;
  } catch { return null; }
}

console.log("═══════════════════════════════════════════════");
console.log(" PHASE 1: Fix Unnamed Mosques");
console.log("═══════════════════════════════════════════════\n");

const { data: unnamed } = await supabase
  .from("mosques")
  .select("id, osm_id, name, latitude, longitude, city, postcode")
  .ilike("name", "%Unnamed%");

console.log(`Found ${unnamed?.length ?? 0} unnamed mosques\n`);

let fixed = 0;
let flagged = 0;

for (const m of unnamed ?? []) {
  process.stdout.write(`  osm_id ${m.osm_id} (${m.city ?? "no city"}) → `);

  // Try OSM first
  let newName: string | null = null;
  if (m.osm_id) {
    newName = await getOsmName(m.osm_id);
    await sleep(DELAY_MS);
  }

  // Try Nominatim if OSM gave nothing
  if (!newName && m.latitude && m.longitude) {
    newName = await getNominatimName(m.latitude, m.longitude);
    await sleep(DELAY_MS);
  }

  if (newName) {
    await supabase.from("mosques").update({ name: newName }).eq("id", m.id);
    console.log(`✓ renamed → "${newName}"`);
    fixed++;
  } else {
    await supabase.from("mosques").update({ status: "needs_review" }).eq("id", m.id);
    console.log(`⚑ flagged for review (${m.latitude?.toFixed(4)}, ${m.longitude?.toFixed(4)})`);
    flagged++;
  }
}

console.log(`\n  Fixed: ${fixed}, Flagged: ${flagged}\n`);

// ── 2. Short name anomalies ───────────────────────────────────────────────

console.log("═══════════════════════════════════════════════");
console.log(" PHASE 2: Short / Suspicious Names");
console.log("═══════════════════════════════════════════════\n");

const { data: shortNames } = await supabase
  .from("mosques")
  .select("id, name, city, postcode, osm_id")
  .not("name", "ilike", "%Unnamed%");

const suspicious = (shortNames ?? []).filter(m => m.name.trim().length < 5);
console.log(`Found ${suspicious.length} mosques with very short names:\n`);
suspicious.forEach(m => {
  console.log(`  "${m.name}"  (${m.city ?? "no city"}, osm_id: ${m.osm_id})`);
});

// ── 3. Duplicate names in same city ──────────────────────────────────────

console.log("\n═══════════════════════════════════════════════");
console.log(" PHASE 3: Duplicate Names in Same City");
console.log("═══════════════════════════════════════════════\n");

const { data: allMosques } = await supabase
  .from("mosques")
  .select("id, name, city")
  .not("city", "is", null);

// Group by name+city
const groups: Record<string, any[]> = {};
for (const m of allMosques ?? []) {
  const key = `${m.name.toLowerCase().trim()}||${m.city?.toLowerCase().trim()}`;
  if (!groups[key]) groups[key] = [];
  groups[key].push(m);
}

const dupes = Object.entries(groups).filter(([, arr]) => arr.length > 1);
console.log(`Found ${dupes.length} duplicate name+city combinations:\n`);

dupes.slice(0, 30).forEach(([key, arr]) => {
  const [name, city] = key.split("||");
  console.log(`  "${name}" in ${city} — ${arr.length} entries:`);
  arr.forEach(m => console.log(`    ${m.id}`));
});

if (dupes.length > 30) {
  console.log(`  … and ${dupes.length - 30} more (showing first 30 only)`);
}

console.log("\n[DONE]");
