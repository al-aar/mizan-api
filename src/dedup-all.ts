import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// IDs to DELETE — in each group we keep the row with real ingestion data,
// or the first row if all are null. The kept IDs are NOT in this list.
const IDS_TO_DELETE = [
  // Belfast Islamic Centre
  "86f74d00-ce1d-4bab-b1bf-2e6f00297d4c",

  // Birmingham Central Mosque — deleting the null one, keeping masjidbox_api
  "1317ee90-bd40-4008-95a6-9dacaa2794d2",

  // Jami Masjid and Islamic Centre, Birmingham
  "31f6cddb-214e-4ab4-beef-77cd5a3b0259",

  // Madina Mosque, Birmingham (3 rows → keep first)
  "d0c4596d-b77c-4e5c-9711-c00a39c85727",
  "2c4e6d1b-cd48-41b3-80b3-6a5ce366a4b4",

  // Masjid-e-Noor, Birmingham
  "d3f07683-3996-415a-be61-acd189a4a2b0",

  // Prayer Room, Birmingham (4 rows → keep first)
  "d304d48f-d453-499e-bc81-cf384d4d007f",
  "9d69695f-50da-42e6-bb16-51e406ec8273",
  "ce6e458e-c45c-4b17-b16a-f9809ad74495",

  // Jamiyat Tabligh ul Islam, Bradford (7 rows → keep first)
  "eecf1f88-550f-4e35-b15e-a37c0e08a007",
  "07e7cfe0-b37a-425e-90f7-9c1f3567962b",
  "e5ade70f-f1cb-471b-a3e2-4a4fad31c2c1",
  "3efa17c5-f463-443c-a242-b637ea31df69",
  "9632a491-70a9-4aea-b055-a41142dac48b",
  "b916e8ec-3b3d-40f5-ac0b-43e0cef37244",

  // Jamiyat Tabligh-ul-Islam, Bradford
  "2297ec61-03bb-4766-98f1-d0cce3656bd2",

  // Muslim Prayer Room, Bradford
  "4b165fed-29c0-416d-a01b-ad7c289b42cf",

  // Shah Jalal Masjid, Burnley
  "3d046092-74bc-48e0-8db9-1f9acf768d9e",

  // Ismaili Jamaat Khana, Chester
  "b5287cf8-edb8-4fd2-9754-4b53017ed58a",

  // Prayer Room, Coventry (3 rows → keep first)
  "d0745f90-4a96-4086-a082-7e6c98886dc8",
  "6500cf9f-842f-4441-9950-c705d522fe28",

  // Derby Jamia Mosque
  "4f2d1762-d51d-48e5-8345-a535d208351b",

  // musallah, Dublin (5 rows → keep first)
  "63eae9f3-92b2-4d22-88d9-6356b58540f3",
  "ca48778b-2cd8-45fb-b85a-3dc64ef32d95",
  "983ffebe-c0df-4eea-9655-e7d67b5d291a",
  "076fc272-8758-41dc-a08e-31cc456ab09d",

  // Fife Islamic Centre
  "e610e7a0-02b3-4d36-b6f0-4632081e90f0",

  // Guildford Islamic Soc
  "b1531377-47aa-416d-8435-9361f0d45c01",

  // Bletchley Jamee Mosque, Milton Keynes
  "39e0f942-cdc2-49cd-978c-91a1bbc51eea",

  // Jamia Masjid Abu Huraira, Leeds
  "972f111c-03ca-4666-b669-cd896225553c",

  // Madni Jamia Masjid, Leeds
  "d7a28da7-ee21-4bfb-9515-1a7cfae22362",

  // Masjid Ibrahim, Leeds
  "d6e95791-a4d3-48ba-9a69-7bc705f348d8",

  // Masjid an-Noor, Leicester
  "4b0ec392-c8c5-46e7-a6c5-9bb581f93fea",

  // Prayer Room, Leicester (3 rows → keep first)
  "ebf1b5d6-4815-46cb-876c-1131eb771adb",
  "2739f596-c324-4441-b9bb-1e37bc201752",

  // Lincoln Mosque and Islamic Association
  "79627f74-63df-4641-ad20-7a002c2fd6d8",
];

console.log(`Deleting ${IDS_TO_DELETE.length} duplicate rows...\n`);

let deleted = 0;
let failed = 0;

for (const id of IDS_TO_DELETE) {
  const { error } = await supabase.from("mosques").delete().eq("id", id);
  if (error) {
    console.error(`❌ Failed ${id}: ${error.message}`);
    failed++;
  } else {
    console.log(`✅ Deleted ${id}`);
    deleted++;
  }
}

console.log(`\n══════════════════════════════════`);
console.log(`Deleted: ${deleted} | Failed: ${failed}`);
console.log(`══════════════════════════════════`);

// Also flag generic noise names that still remain (1 copy each)
const GENERIC_NAMES = ["Prayer Room", "musallah", "Ismaili Jamaat Khana"];
console.log(`\nℹ️  Generic/noise names still in DB (1 copy each — review manually):`);
for (const name of GENERIC_NAMES) {
  const { data } = await supabase
    .from("mosques").select("id, city").eq("name", name);
  if (data?.length) {
    for (const r of data) console.log(`  "${name}" — ${r.city} (${r.id})`);
  }
}
