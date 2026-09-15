import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const { data, error } = await supabase
  .from("mosques")
  .select("id, name, city, ingestion_type, has_online_presence, website_url")
  .ilike("name", "%khizra%")
  .order("id");

if (error) { console.error(error); process.exit(1); }

console.log("Masjid-e-Khizra rows in DB:");
console.table(data);
