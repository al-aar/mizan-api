import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Fetch all mosques
const { data, error } = await supabase
  .from("mosques")
  .select("id, name, city, ingestion_type, has_online_presence, website_url")
  .order("city")
  .order("name");

if (error) { console.error(error); process.exit(1); }
if (!data) { console.log("No data"); process.exit(0); }

console.log(`Total mosques in DB: ${data.length}\n`);

// Find exact name+city duplicates
const seen = new Map<string, typeof data>();
const duplicateGroups: (typeof data)[] = [];

for (const m of data) {
  const key = `${m.name?.toLowerCase().trim()}|${m.city?.toLowerCase().trim()}`;
  if (!seen.has(key)) {
    seen.set(key, [m]);
  } else {
    seen.get(key)!.push(m);
  }
}

for (const [key, group] of seen) {
  if (group.length > 1) {
    duplicateGroups.push(group);
  }
}

if (duplicateGroups.length === 0) {
  console.log("✅ No exact duplicates found (same name + same city).");
} else {
  console.log(`⚠️  Found ${duplicateGroups.length} duplicate group(s):\n`);
  for (const group of duplicateGroups) {
    console.log(`  Name: "${group[0].name}" | City: "${group[0].city}"`);
    for (const m of group) {
      console.log(`    ID: ${m.id} | ingestion: ${m.ingestion_type ?? "null"} | online: ${m.has_online_presence ?? "null"} | url: ${m.website_url ?? "null"}`);
    }
    console.log();
  }
}
