import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const geojson = JSON.parse(fs.readFileSync("export.geojson", "utf-8"));
const features = geojson.features as any[];
console.log(`[*] Processing ${features.length} OSM features...`);

// Normalise syndicator tag → our ingestion_type values
function toIngestionType(raw: string): string | null {
  const s = raw.toLowerCase().replace(/[\s_-]+/g, "");
  if (s.includes("masjidbox")) return "masjidbox_api";
  if (s.includes("mymasjid"))  return "mymasjid_api";
  if (s.includes("mawaqit"))   return "mawaqit_api";
  return null;
}

const records: any[] = [];

for (const feature of features) {
  const p = feature.properties as Record<string, string>;
  const coords = feature.geometry?.coordinates as [number, number] | undefined;
  if (!coords) continue;

  const [lng, lat] = coords;
  const rawId: string = feature.id || p["@id"]; // e.g. "node/123456"
  const osmId = parseInt(rawId.replace(/^[^/]+\//, ""), 10); // → 123456

  // Name
  const name = p["name"] || p["name:en"] || "Unnamed Mosque";

  // Address
  const houseNum = p["addr:housenumber"] || "";
  const street   = p["addr:street"] || p["addr:place"] || "";
  const address  = [houseNum, street].filter(Boolean).join(" ") || null;

  // City — try several OSM fields in order
  const city =
    p["addr:city"]    ||
    p["addr:town"]    ||
    p["addr:suburb"]  ||
    p["addr:village"] ||
    p["addr:county"]  ||
    null;

  // Website
  const websiteUrl =
    p["website"] || p["contact:website"] || p["url"] || null;

  // Prayer time provider (already tagged in OSM for some mosques)
  const syndicatorRaw = p["prayer_times:syndicator"] || "";
  const ingestionType = toIngestionType(syndicatorRaw);
  const feedSource    = p["prayer_times:syndicator:url"] || null;

  // Slug: name + city + osm_id to guarantee uniqueness
  const slugBase = `${name} ${city || ""} ${osmId}`.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 120);

  records.push({
    osm_id:             osmId,
    name,
    slug:               slugBase,
    address,
    postcode:           p["addr:postcode"] || null,
    city,
    latitude:           lat,
    longitude:          lng,
    website_url:        websiteUrl,
    status:             "discovered",
    ingestion_type:     ingestionType,
    feed_source:        feedSource,
    has_online_presence:
      ingestionType ? true : websiteUrl ? true : null,
  });
}

console.log(`[*] Uploading ${records.length} mosques…`);

let inserted = 0;
let errors   = 0;

for (let i = 0; i < records.length; i += 50) {
  const batch = records.slice(i, i + 50);
  const { error } = await supabase
    .from("mosques")
    .upsert(batch, { onConflict: "osm_id" });
  if (error) {
    console.error(`  ✗ batch at ${i}: ${error.message}`);
    errors++;
  } else {
    inserted += batch.length;
  }
  if (i % 200 === 0) process.stdout.write(`  ${i}/${records.length}\r`);
}

console.log(`\n[DONE] ${inserted} imported, ${errors} batch errors.`);

// ── Show the 5 key mosques so we can re-link prayer_times ──────────────────
console.log("\n[*] Looking up the 5 key mosques for prayer_times re-link…");
const targets = [
  { name: "Glasgow Central Mosque",    city: "Glasgow"    },
  { name: "Edinburgh Central Mosque",  city: "Edinburgh"  },
  { name: "East London Mosque",        city: "London"     },
  { name: "Birmingham Central Mosque", city: "Birmingham" },
  { name: "Manchester Central Mosque", city: "Manchester" },
];

for (const t of targets) {
  const { data } = await supabase
    .from("mosques")
    .select("id, name, city")
    .ilike("name", `%${t.name.split(" ").slice(-2).join(" ")}%`)
    .ilike("city", `%${t.city}%`)
    .limit(3);
  console.log(`\n${t.name}:`);
  (data ?? []).forEach(r => console.log(`  ${r.id}  ${r.name}, ${r.city}`));
}
