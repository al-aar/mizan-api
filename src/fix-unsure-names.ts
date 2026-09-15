import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Find all mosques whose name starts with [Unsure]
const { data, error } = await supabase
  .from("mosques")
  .select("id, name, city")
  .ilike("name", "[Unsure]%");

if (error) { console.error(error); process.exit(1); }

if (!data?.length) {
  console.log("No [Unsure] names found.");
  process.exit(0);
}

console.log(`Found ${data.length} mosques with [Unsure] prefix:`);
for (const m of data) {
  const cleanName = m.name.replace(/^\[Unsure\]\s*/i, "").trim();
  console.log(`  "${m.name}" → "${cleanName}"`);

  const { error: updateErr } = await supabase
    .from("mosques")
    .update({ name: cleanName })
    .eq("id", m.id);

  if (updateErr) {
    console.error(`  ❌ Failed to update ${m.id}:`, updateErr.message);
  } else {
    console.log(`  ✅ Fixed`);
  }
}

console.log("\nDone!");
