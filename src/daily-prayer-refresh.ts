/**
 * daily-prayer-refresh.ts
 * Combined daily worker — runs every day at 00:05 UTC via Railway Cron.
 *
 * Phase 1: Scotland mosques via Maktabonline getAll API (6 mosques)
 * Phase 2: England key mosques via individual scrapers
 *           (Edinburgh, East London, Birmingham, Manchester)
 *           Glasgow Central is already covered by Phase 1.
 *
 * Usage (manual):
 *   npx tsx src/daily-prayer-refresh.ts
 */

import { createClient } from "@supabase/supabase-js";

// dotenv only needed locally — Railway injects env vars directly
try {
  const { default: dotenv } = await import("dotenv");
  dotenv.config();
} catch { /* not available in production — that's fine */ }

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ── Shared helpers ─────────────────────────────────────────────────────────

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function todayDDMM(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}`;
}

function toHHMM(t: string | undefined): string {
  if (!t) return "";
  const [h, m] = t.split(":");
  if (!h || !m) return "";
  return `${String(parseInt(h)).padStart(2,"0")}:${m.substring(0,2)}`;
}

function isoToHHMM(iso: string | undefined): string {
  if (!iso) return "";
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : "";
}

function pad24(t: string): string {
  const s = t.trim().replace(/\s+/g, "");
  if (!s || s === "-") return "";
  if (/AM|PM/i.test(s)) {
    const m = s.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!m) return "";
    let h = parseInt(m[1]), mi = parseInt(m[2]);
    if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
    if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
    return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;
  }
  const [h, mi] = s.split(":");
  return h && mi ? `${String(parseInt(h)).padStart(2,"0")}:${mi.substring(0,2)}` : "";
}

function dotTo24(t: string, isPm: boolean): string {
  const s = t.trim().replace(/\s+/g,"");
  if (!s || s==="-") return "";
  const parts = s.split(".");
  if (parts.length < 2) return "";
  let h = parseInt(parts[0]), mi = parseInt(parts[1]);
  if (isNaN(h)||isNaN(mi)) return "";
  if (isPm && h < 12) h += 12;
  if (!isPm && h === 12) h = 0;
  return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;
}

function addMinutes(t: string, n: number): string {
  const [h, m] = t.split(":").map(Number);
  if (isNaN(h)||isNaN(m)) return t;
  const tot = h*60+m+n;
  return `${String(Math.floor(tot/60)%24).padStart(2,"0")}:${String(tot%60).padStart(2,"0")}`;
}

async function fetchHtml(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function upsert(mosqueId: string, times: Record<string, string>) {
  const { error } = await supabase
    .from("prayer_times")
    .upsert({ mosque_id: mosqueId, date: todayKey(), ...times }, { onConflict: "mosque_id,date" });
  if (error) throw new Error(error.message);
}

// ── PHASE 1: Scotland via Maktabonline getAll ──────────────────────────────

const MAKTAB_TO_SUPABASE: Record<string, string> = {
  "5f21a98335596f0f6464b0c3": "4ae8731e-3223-4bca-8171-e5caaa23b979", // Glasgow Central Mosque
  // Others are looked up dynamically by name + postcode
};

async function findSupabaseId(name: string, postcode?: string): Promise<string | null> {
  if (postcode) {
    const clean = postcode.trim().replace(/,$/, "");
    const { data } = await supabase.from("mosques").select("id, name").ilike("postcode", clean).limit(3);
    if (data?.length === 1) return data[0].id;
    if (data && data.length > 1) {
      const match = data.find(r => r.name.toLowerCase().includes(name.toLowerCase().split(" ")[0]));
      if (match) return match.id;
      return data[0].id;
    }
  }
  const words = name.split(" ").filter(w => w.length > 3);
  for (const word of words) {
    for (const city of ["%Glasgow%", "%Edinburgh%", "%Aberdeen%", "%Dundee%", "%"]) {
      const { data } = await supabase.from("mosques").select("id, name, city")
        .ilike("name", `%${word}%`).ilike("city", city).limit(5);
      if (data?.length === 1) return data[0].id;
      if (data && data.length > 1) {
        const match = data.find(r =>
          r.name.toLowerCase().includes(name.toLowerCase().split(" ").slice(0,2).join(" "))
        );
        if (match) return match.id;
      }
      if (city === "%") break;
    }
  }
  return null;
}

async function runScotland(): Promise<{ ok: number; skip: number; err: number }> {
  console.log("\n━━━ Phase 1: Maktabonline (Scotland) ━━━");
  const day = todayDDMM();
  const masjids: any[] = [];

  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`https://maktabonline.co.uk/api/prayers/getAll?day=${day}&page=${page}`, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://maktabonline.co.uk/landing" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`Maktabonline HTTP ${r.status} (page ${page})`);
    const data = await r.json() as any;
    masjids.push(...(data.masjids ?? []).filter((m: any) => m.name && m.name.toLowerCase() !== "test" && m.prayersTimings));
    const { totalPages } = data.pagination ?? {};
    if (page >= parseInt(totalPages ?? "1")) break;
  }

  console.log(`  Found ${masjids.length} mosques on Maktabonline`);
  let ok = 0, skip = 0, err = 0;

  for (const m of masjids) {
    process.stdout.write(`  ${m.name.padEnd(40)} `);
    let id = MAKTAB_TO_SUPABASE[m._id];
    if (!id) {
      id = await findSupabaseId(m.name, m.postcode) ?? "";
      if (id) MAKTAB_TO_SUPABASE[m._id] = id;
    }
    if (!id) { process.stdout.write(`⚠ not in DB (maktab_id: ${m._id})\n`); skip++; continue; }

    const t = m.prayersTimings;
    try {
      await upsert(id, {
        fajr_start: toHHMM(t.fajrBegins), fajr_jamaat: toHHMM(t.fajrJamah),
        sunrise: toHHMM(t.sunrise),
        zuhr_start: toHHMM(t.zuhrBegins), zuhr_jamaat: toHHMM(t.zuhrJamah),
        asr_mithl1: toHHMM(t.asrMithl1), asr_mithl2: toHHMM(t.asrMithl2), asr_jamaat: toHHMM(t.asrJamah),
        maghrib_start: toHHMM(t.maghribBegins), maghrib_jamaat: toHHMM(t.maghribJamah),
        isha_start: toHHMM(t.ishaBegins), isha_jamaat: toHHMM(t.ishaJamah),
      });
      process.stdout.write(`✓\n`); ok++;
    } catch(e: any) { process.stdout.write(`✗ ${e.message}\n`); err++; }
  }

  console.log(`  Result: ${ok} ✓  ${skip} skipped  ${err} ✗`);
  return { ok, skip, err };
}

// ── PHASE 2: England key mosques (individual scrapers) ─────────────────────

// Edinburgh Central Mosque — edmosque.org
async function scrapeEdinburgh() {
  const { load } = await import("cheerio");
  const html = await fetchHtml("https://edmosque.org/about-the-mosque/prayer-times/");
  const $ = load(html);
  const today = new Date().getDate();
  let jamFajr="", jamZuhr="", jamAsr="", jamMaghribOffset=0, jamIsha="";
  let result: any = null;
  $("table tr").each((_: any, row: any) => {
    const cells = $(row).find("td");
    if (!cells.length) return;
    const first = $(cells.get(0)!).text().trim().toLowerCase();
    if (first.includes("jama")) {
      jamFajr  = pad24($(cells.get(1)!).text().trim());
      jamZuhr  = pad24($(cells.get(2)!).text().trim());
      jamAsr   = pad24($(cells.get(3)!).text().trim());
      const mc = $(cells.get(4)!).text().trim();
      const om = mc.match(/\+\s*(\d+)/);
      jamMaghribOffset = om ? parseInt(om[1]) : 0;
      jamIsha  = pad24($(cells.get(5)!).text().trim());
      return;
    }
    const day = parseInt(first);
    if (isNaN(day) || day !== today || cells.length < 7) return;
    const adhanMaghrib = pad24($(cells.get(5)!).text().trim());
    result = {
      fajr_start: pad24($(cells.get(2)!).text().trim()), fajr_jamaat: jamFajr,
      zuhr_start: pad24($(cells.get(3)!).text().trim()), zuhr_jamaat: jamZuhr,
      asr_mithl1: pad24($(cells.get(4)!).text().trim()), asr_jamaat: jamAsr,
      maghrib_start: adhanMaghrib, maghrib_jamaat: addMinutes(adhanMaghrib, jamMaghribOffset),
      isha_start: pad24($(cells.get(6)!).text().trim()), isha_jamaat: jamIsha,
    };
    return false as any;
  });
  if (!result) throw new Error("Edinburgh row not found");
  return result;
}

// East London + Birmingham Central — MasjidBox API
async function scrapeMasjidBox(slug: string) {
  const html = await fetchHtml(`https://masjidbox.com/prayer-times/${slug}`);
  const match = html.match(/window\.REDUX_STATE\s*=\s*'([\s\S]+?)'\s*;/);
  if (!match) throw new Error("REDUX_STATE not found");
  const decoded = match[1].replace(/%u([0-9A-Fa-f]{4})/g, (_: any, h: string) => String.fromCharCode(parseInt(h,16)));
  const state = JSON.parse(decodeURIComponent(decoded));
  const timetable = state.masjidbox.masjidboxAthany.timetable;
  const today = todayKey();
  const entry = timetable.find((t: any) => t.date.startsWith(today));
  if (!entry) throw new Error(`No entry for ${today}`);
  return {
    fajr_start:    isoToHHMM(entry.fajr),    fajr_jamaat:    isoToHHMM(entry.iqamah?.fajr),
    zuhr_start:    isoToHHMM(entry.dhuhr),   zuhr_jamaat:    isoToHHMM(entry.iqamah?.dhuhr),
    asr_mithl1:    isoToHHMM(entry.asr),     asr_jamaat:     isoToHHMM(entry.iqamah?.asr),
    maghrib_start: isoToHHMM(entry.maghrib), maghrib_jamaat: isoToHHMM(entry.iqamah?.maghrib),
    isha_start:    isoToHHMM(entry.isha),    isha_jamaat:    isoToHHMM(entry.iqamah?.isha),
  };
}

// Manchester Central Mosque — wp-admin ajax
async function scrapeManchester() {
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const now = new Date();
  const today = now.getDate();
  const currentFile = `${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  const r = await fetch("https://manchestercentralmosque.org/wp-admin/admin-ajax.php", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://manchestercentralmosque.org/prayer-times/",
    },
    body: `action=mcm_get_month_file&current_file=${encodeURIComponent(currentFile)}`,
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Manchester HTTP ${r.status}`);
  const { load } = await import("cheerio");
  const $ = load(await r.text());
  let result: any = null;
  $("table tr").each((_: any, row: any) => {
    const cells = $(row).find("td");
    if (cells.length < 15) return;
    const c = (i: number) => $(cells.get(i)!).text().trim();
    if (parseInt(c(0)) !== today) return;
    result = {
      fajr_start: dotTo24(c(3),false),   fajr_jamaat:    dotTo24(c(10),false),
      zuhr_start: dotTo24(c(6),true),    zuhr_jamaat:    dotTo24(c(11),true),
      asr_mithl1: dotTo24(c(7),true),    asr_jamaat:     dotTo24(c(12),true),
      maghrib_start: dotTo24(c(8),true), maghrib_jamaat: dotTo24(c(13),true),
      isha_start: dotTo24(c(9),true),    isha_jamaat:    dotTo24(c(14),true),
    };
    return false as any;
  });
  if (!result) throw new Error(`Manchester row ${today} not found`);
  return result;
}

// England mosque UUIDs — these don't change
const ENGLAND_MOSQUES: Array<{ name: string; id: string; scraper: () => Promise<any> }> = [
  { name: "Edinburgh Central Mosque", id: "c8133b4d-f03d-40b6-b3a5-c81abcd8dd42", scraper: scrapeEdinburgh },
  { name: "East London Mosque",       id: "7fef4352-26ee-4010-9d3a-875a18791559", scraper: () => scrapeMasjidBox("eastlondonmosque") },
  { name: "Birmingham Central Mosque",id: "ee0426c7-ef96-4425-a5bd-eca83f8511bf", scraper: () => scrapeMasjidBox("centralmosque") },
  { name: "Manchester Central Mosque",id: "16090a25-f4f4-46b6-aee1-8dd0bb6a09f1", scraper: scrapeManchester },
];

async function runEngland(): Promise<{ ok: number; err: number }> {
  console.log("\n━━━ Phase 2: Custom scrapers (Edinburgh, East London, Birmingham, Manchester) ━━━");
  let ok = 0, err = 0;
  for (const { name, id, scraper } of ENGLAND_MOSQUES) {
    process.stdout.write(`  ${name.padEnd(40)} `);
    try {
      const times = await scraper();
      await upsert(id, times);
      process.stdout.write(`✓\n`); ok++;
    } catch(e: any) { process.stdout.write(`✗ ${e.message}\n`); err++; }
  }
  console.log(`  Result: ${ok} ✓  ${err} ✗`);
  return { ok, err };
}

// ── Main ───────────────────────────────────────────────────────────────────

const started = Date.now();
console.log(`[daily-prayer-refresh] ${todayKey()} — starting`);

const s = await runScotland();
const e = await runEngland();

const total = s.ok + e.ok;
const errors = s.err + e.err;
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

console.log(`\n[DONE] ${total} inserted, ${s.skip} skipped, ${errors} errors — ${elapsed}s`);
if (errors > 0) process.exit(1); // non-zero exit so Railway flags the run as failed
