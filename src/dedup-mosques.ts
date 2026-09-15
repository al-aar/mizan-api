/**
 * dedup-mosques.ts
 * Finds named duplicate mosques (same name + city) and checks if they are
 * at the same physical location (within 100 m). If so, keeps the older one
 * and deletes the newer duplicate.
 *
 * SAFE: only deletes if coordinates are within 100m AND it has no prayer_times rows.
 * Prints a report first — you confirm before anything is deleted.
 *
 * Usage:
 *   cd C:\Users\Muzammil\Documents\mizan-api
 *   npx tsx src/dedup-mosques.ts
 *
 * To actually delete after reviewing: npx tsx src/dedup-mosques.ts --delete
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const DRY_RUN = !process.argv.includes("--delete");

function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Fetch all named mosques ───────────────────────────────────────────────

const { data: all } = await supabase
  .from("mosques")
  .select("id, name, city, latitude, longitude, created_at, osm_id")
  .not("name", "ilike", "%unnamed%")
  .not("city", "is", null)
  .order("created_at");

// Group by lowercase name + city
const groups: Record<string, any[]> = {};
for (const m of all ?? []) {
  const key = `${m.name.trim().toLowerCase()}||${m.city?.trim().toLowerCase()}`;
  if (!groups[key]) groups[key] = [];
  groups[key].push(m);
}

const dupes = Object.entries(groups).filter(([, arr]) => arr.length > 1);

console.log(`Found ${dupes.length} named duplicate groups\n`);
if (DRY_RUN) console.log("DRY RUN — add --delete flag to actually delete\n");

let toDelete: string[] = [];
let tooFar: number = 0;
let hasPrayerTimes: number = 0;

for (const [key, arr] of dupes) {
  const [name, city] = key.split("||");
  console.log(`"${name}" in ${city}:`);

  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i], b = arr[j];
      if (!a.latitude || !b.latitude) continue;

      const dist = distanceM(a.latitude, a.longitude, b.latitude, b.longitude);
      console.log(`  Distance between entries: ${Math.round(dist)} m`);

      if (dist > 100) {
        console.log(`  → Different locations — keeping both\n`);
        tooFar++;
        continue;
      }

      // Same location — check if newer one has prayer_times
      const newer = new Date(a.created_at) > new Date(b.created_at) ? a : b;
      const older = newer === a ? b : a;

      const { data: pt } = await supabase
        .from("prayer_times")
        .select("id")
        .eq("mosque_id", newer.id)
        .limit(1);

      if (pt?.length) {
        console.log(`  → Same location but newer entry has prayer_times — skipping (manual review needed)`);
        console.log(`    Keep: ${older.id} (older)`);
        console.log(`    Review: ${newer.id} (has prayer_times)\n`);
        hasPrayerTimes++;
        continue;
      }

      console.log(`  → Same location — will delete newer entry`);
      console.log(`    Keep:   ${older.id}  (osm_id: ${older.osm_id})`);
      console.log(`    Delete: ${newer.id}  (osm_id: ${newer.osm_id})\n`);
      toDelete.push(newer.id);
    }
  }
}

console.log(`\n═══════════════════════════════════`);
console.log(`Summary:`);
console.log(`  Same location, safe to delete: ${toDelete.length}`);
console.log(`  Different locations (keep both): ${tooFar}`);
console.log(`  Same location but has prayer_times (manual): ${hasPrayerTimes}`);

if (toDelete.length === 0) {
  console.log(`\nNothing to delete.`);
} else if (DRY_RUN) {
  console.log(`\nRun with --delete flag to remove ${toDelete.length} duplicates:`);
  console.log(`  npx tsx src/dedup-mosques.ts --delete`);
} else {
  console.log(`\nDeleting ${toDelete.length} duplicates…`);
  for (const id of toDelete) {
    const { error } = await supabase.from("mosques").delete().eq("id", id);
    if (error) console.log(`  ✗ ${id}: ${error.message}`);
    else console.log(`  ✓ deleted ${id}`);
  }
  console.log(`\n[DONE]`);
}
