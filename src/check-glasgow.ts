import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const s = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const { data } = await s
  .from("mosques")
  .select("name, has_online_presence, ingestion_type, website_url")
  .eq("city", "Glasgow")
  .order("name");

if (!data || data.length === 0) {
  console.log("No Glasgow mosques found.");
} else {
  console.log(`\n${data.length} mosques in Glasgow:\n`);
  for (const m of data) {
    const icon = m.has_online_presence ? "✓" : "—";
    const type = (m.ingestion_type ?? "unknown").padEnd(16);
    console.log(`${icon} ${type} ${m.name}`);
  }
}
