import { createClient } from "@supabase/supabase-js";

// ── Config ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// The existing Railway API — same project, different service
const API_BASE =
  process.env.API_BASE_URL ??
  "https://muslim-companion-api-production.up.railway.app";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Mosques to fetch ────────────────────────────────────────────────────────
const MOSQUES = [
  "glasgow-central",
  "edinburgh-central",
  "east-london",
  "birmingham-central",
  "manchester-central",
];

// ── Helpers ─────────────────────────────────────────────────────────────────
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── Core worker ─────────────────────────────────────────────────────────────
async function fetchAndStore(mosqueId: string, date: string): Promise<void> {
  const res = await fetch(`${API_BASE}/mosque-timetable/${mosqueId}`, {
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) throw new Error(`API returned HTTP ${res.status}`);

  const data = await res.json();

  const row = {
    mosque_id:      mosqueId,
    date,
    fajr_adhan:     data.adhan?.Fajr     ?? null,
    fajr_jamaat:    data.jamaat?.Fajr    ?? null,
    dhuhr_adhan:    data.adhan?.Dhuhr    ?? null,
    dhuhr_jamaat:   data.jamaat?.Dhuhr   ?? null,
    asr_adhan:      data.adhan?.Asr      ?? null,
    asr_jamaat:     data.jamaat?.Asr     ?? null,
    maghrib_adhan:  data.adhan?.Maghrib  ?? null,
    maghrib_jamaat: data.jamaat?.Maghrib ?? null,
    isha_adhan:     data.adhan?.Isha     ?? null,
    isha_jamaat:    data.jamaat?.Isha    ?? null,
    jumuah_1:       data.jummah?.[0]     ?? null,
    jumuah_2:       data.jummah?.[1]     ?? null,
    source:         data.source          ?? null,
  };

  const { error } = await supabase
    .from("prayer_times")
    .upsert(row, { onConflict: "mosque_id,date" });

  if (error) throw new Error(error.message);
}

// ── Main ────────────────────────────────────────────────────────────────────
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

  // Non-zero exit tells Railway the cron run failed
  if (failed > 0) process.exit(1);
}

main();
