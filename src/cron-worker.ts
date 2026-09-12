import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const API_BASE = process.env.API_BASE_URL ?? "https://muslim-companion-api-production.up.railway.app";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MOSQUES = [
  "glasgow-central",
  "edinburgh-central",
  "east-london",
  "birmingham-central",
  "manchester-central",
];

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toTime(val: string | null | undefined): string | null {
  if (!val || val.trim() === "") return null;
  // Already HH:MM format
  if (/^\d{2}:\d{2}$/.test(val.trim())) return val.trim();
  return null;
}

async function getMosqueUuid(slug: string): Promise<string> {
  const { data, error } = await supabase
    .from("mosques")
    .select("id")
    .eq("slug", slug)
    .single();
  if (error || !data) throw new Error(`Mosque not found in DB: ${slug}`);
  return data.id;
}

async function fetchAndStore(mosqueId: string, date: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/mosque-timetable/${mosqueId}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`API returned HTTP ${res.status}`);
  const data = await res.json();

  const uuid = await getMosqueUuid(mosqueId);

  const row = {
    mosque_id:       uuid,
    date,
    fajr_start:      toTime(data.adhan?.Fajr),
    fajr_jamaat:     toTime(data.jamaat?.Fajr),
    sunrise:         toTime(data.adhan?.Sunrise ?? data.sunrise),
    zuhr_start:      toTime(data.adhan?.Dhuhr),
    zuhr_jamaat:     toTime(data.jamaat?.Dhuhr),
    asr_mithl1:      toTime(data.adhan?.AsrMithl1 ?? data.adhan?.Asr),
    asr_mithl2:      toTime(data.adhan?.AsrMithl2),
    asr_jamaat:      toTime(data.jamaat?.Asr),
    maghrib_start:   toTime(data.adhan?.Maghrib),
    maghrib_jamaat:  toTime(data.jamaat?.Maghrib),
    isha_start:      toTime(data.adhan?.Isha),
    isha_jamaat:     toTime(data.jamaat?.Isha),
    jumuah_1:        toTime(data.jummah?.[0]),
    jumuah_2:        toTime(data.jummah?.[1]),
  };

  const { error } = await supabase
    .from("prayer_times")
    .upsert(row, { onConflict: "mosque_id,date" });

  if (error) throw new Error(error.message);
}

async function main() {
  console.log("=== Mizan Prayer Times Cron Worker ===");
  console.log(`Run time: ${new Date().toISOString()}`);
  console.log(`Fetching from: ${API_BASE}\n`);

  const date = todayKey();
  let failed = 0;

  for (const mosqueId of MOSQUES) {
    try {
      await fetchAndStore(mosqueId, date);
      console.log(`✓ ${mosqueId}`);
    } catch (err: any) {
      console.error(`✗ ${mosqueId}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n=== ${MOSQUES.length - failed}/${MOSQUES.length} mosques saved (${date}) ===`);
  if (failed > 0) process.exit(1);
}

main();