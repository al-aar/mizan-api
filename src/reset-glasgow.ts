import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const s = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Reset Glasgow mosques that have null ingestion_type (incomplete previous run)
// Glasgow Central Mosque (maktab_api) is already set and will be skipped by this filter
const { error } = await s
  .from("mosques")
  .update({ has_online_presence: null })
  .eq("city", "Glasgow")
  .is("ingestion_type", null);

if (error) {
  console.error("Error:", error.message);
  process.exit(1);
}

// Verify how many are now queued
const { data: queued } = await s
  .from("mosques")
  .select("name")
  .eq("city", "Glasgow")
  .is("has_online_presence", null);

console.log(`✅ Reset done — ${queued?.length ?? 0} mosques queued for enrichment.`);
