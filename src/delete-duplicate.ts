import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Delete the duplicate — keeping 6f566852 (first one), deleting ea6af5fc
const ID_TO_DELETE = "ea6af5fc-4569-4c7f-9e0c-262188f5e4aa";

const { error } = await supabase
  .from("mosques")
  .delete()
  .eq("id", ID_TO_DELETE);

if (error) {
  console.error("❌ Failed:", error.message);
  process.exit(1);
}

console.log(`✅ Deleted duplicate Masjid-e-Khizra (${ID_TO_DELETE})`);
