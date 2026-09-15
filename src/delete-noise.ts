import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const NOISE_NAMES = [
  "Hired regularly for Ismaili Jamaat Khana",
  "Chaplaincy hosting Ismaili Jamaat Khana",
  "Jumu'ah Salaah",
];

for (const name of NOISE_NAMES) {
  const { data, error } = await supabase
    .from("mosques")
    .delete()
    .eq("name", name)
    .select("id, name, city");

  if (error) {
    console.error(`❌ Failed to delete "${name}":`, error.message);
  } else if (!data?.length) {
    console.log(`⚠️  Not found: "${name}"`);
  } else {
    for (const row of data) {
      console.log(`✅ Deleted: "${row.name}" (${row.city ?? "no city"}) — ${row.id}`);
    }
  }
}

console.log("\nDone!");
