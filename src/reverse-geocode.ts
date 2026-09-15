/**
 * reverse-geocode.ts
 * Fills in missing address / city / postcode for mosques using Nominatim
 * (OpenStreetMap's free reverse-geocoding API).
 *
 * Rules:
 *  - Only processes rows where city IS NULL or postcode IS NULL
 *  - Never overwrites a field that already has a value
 *  - Respects Nominatim's 1-request-per-second rate limit
 *  - Saves progress every 50 rows so you can safely Ctrl-C and re-run
 *
 * Run:
 *   cd C:\Users\Muzammil\Documents\mizan-api
 *   npx tsx src/reverse-geocode.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT    = "MizanApp/1.0 (muzammil1124@gmail.com)"; // required by Nominatim ToS
const DELAY_MS      = 1100; // slightly over 1 s to stay safe

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function reverseGeocode(lat: number, lng: number): Promise<{
  address: string | null;
  city: string | null;
  postcode: string | null;
} | null> {
  try {
    const url = `${NOMINATIM_URL}?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
    const r = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const data = await r.json() as any;
    const a = data.address ?? {};

    const houseNum = a.house_number ?? "";
    const road     = a.road ?? a.pedestrian ?? a.footway ?? "";
    const address  = [houseNum, road].filter(Boolean).join(" ") || null;

    const city =
      a.city      ||
      a.town      ||
      a.suburb    ||
      a.village   ||
      a.county    ||
      null;

    const postcode = a.postcode ?? null;

    return { address, city, postcode };
  } catch {
    return null;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

// Fetch only mosques missing city or postcode
const { data: mosques, error } = await supabase
  .from("mosques")
  .select("id, name, latitude, longitude, address, city, postcode")
  .or("city.is.null,postcode.is.null")
  .not("latitude", "is", null)
  .order("id");

if (error) {
  console.error("Failed to fetch mosques:", error.message);
  process.exit(1);
}

console.log(`[*] ${mosques!.length} mosques need geocoding\n`);

let updated = 0;
let skipped = 0;
let failed  = 0;

for (let i = 0; i < mosques!.length; i++) {
  const m = mosques![i]!;

  process.stdout.write(`  [${i + 1}/${mosques!.length}] ${m.name.substring(0, 40).padEnd(40)} `);

  const geo = await reverseGeocode(m.latitude, m.longitude);
  if (!geo) {
    process.stdout.write("✗ geocode failed\n");
    failed++;
    await sleep(DELAY_MS);
    continue;
  }

  // Only update fields that are currently NULL
  const patch: Record<string, string> = {};
  if (!m.address  && geo.address)  patch.address  = geo.address;
  if (!m.city     && geo.city)     patch.city     = geo.city;
  if (!m.postcode && geo.postcode) patch.postcode = geo.postcode;

  if (Object.keys(patch).length === 0) {
    process.stdout.write("– nothing new\n");
    skipped++;
    await sleep(DELAY_MS);
    continue;
  }

  const { error: upErr } = await supabase
    .from("mosques")
    .update(patch)
    .eq("id", m.id);

  if (upErr) {
    process.stdout.write(`✗ DB error: ${upErr.message}\n`);
    failed++;
  } else {
    const filled = Object.keys(patch).join(", ");
    process.stdout.write(`✓ filled ${filled}\n`);
    updated++;
  }

  // Progress save every 50 rows
  if ((i + 1) % 50 === 0) {
    console.log(`\n  ── checkpoint: ${updated} updated, ${skipped} skipped, ${failed} failed ──\n`);
  }

  await sleep(DELAY_MS);
}

console.log(`\n[DONE] ${updated} updated, ${skipped} already complete, ${failed} failed`);
