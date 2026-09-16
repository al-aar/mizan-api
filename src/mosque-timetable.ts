import { Router } from "express";
import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";

let _supabase: ReturnType<typeof createClient> | null = null;
function getSupabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("Missing Supabase env vars");
    _supabase = createClient(url, key);
  }
  return _supabase;
}

const router = Router();

interface DailyTimes {
  adhan: Record<string, string>;
  jamaat: Record<string, string>;
  source: string;
}

// ── In-memory cache ────────────────────────────────────────────────────────
// Avoids hitting mosque websites on every app request.
// Entries are considered fresh for 6 hours on the same calendar day.
// On fetch failure, stale cache is returned so the app never shows a 502
// just because a mosque website is temporarily slow or blocked.
interface CacheEntry {
  data: DailyTimes;
  dateKey: string;   // "YYYY-MM-DD" — invalidated on a new day
  fetchedAt: number; // ms timestamp  — re-fetched after 6 h on same day
}
const cache = new Map<string, CacheEntry>();

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function withCache(id: string, fn: () => Promise<DailyTimes>): Promise<DailyTimes> {
  const now = Date.now();
  const today = todayKey();
  const entry = cache.get(id);

  if (entry && entry.dateKey === today && now - entry.fetchedAt < 6 * 60 * 60 * 1000) {
    return entry.data; // fresh cache hit
  }

  try {
    const data = await fn();
    cache.set(id, { data, dateKey: today, fetchedAt: now });
    return data;
  } catch (err) {
    if (entry) {
      console.warn(`[cache] ${id}: fetch failed, serving stale data from ${entry.dateKey}`);
      return entry.data; // serve yesterday's times rather than 502
    }
    throw err;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function pad24(t: string): string {
  const s = t.trim().replace(/\s+/g, "");
  if (!s || s === "-") return "";
  if (/AM|PM/i.test(s)) {
    const m = s.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!m) return "";
    let h = parseInt(m[1]), mi = parseInt(m[2]);
    const ap = m[3].toUpperCase();
    if (ap === "AM" && h === 12) h = 0;
    if (ap === "PM" && h !== 12) h += 12;
    return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  }
  const [h, mi] = s.split(":");
  if (!h || !mi) return "";
  return `${String(parseInt(h)).padStart(2, "0")}:${mi.substring(0, 2)}`;
}

// Manchester times use "4.30" / "1.06" dot format without AM/PM
function dotTo24(t: string, isPm: boolean): string {
  const s = t.trim().replace(/\s+/g, "");
  if (!s || s === "-") return "";
  const parts = s.split(".");
  if (parts.length < 2) return "";
  let h = parseInt(parts[0]);
  const mi = parseInt(parts[1]);
  if (isNaN(h) || isNaN(mi)) return "";
  if (isPm && h < 12) h += 12;
  if (!isPm && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

function addMinutes(t: string, n: number): string {
  const [h, m] = t.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return t;
  const tot = h * 60 + m + n;
  return `${String(Math.floor(tot / 60) % 24).padStart(2, "0")}:${String(tot % 60).padStart(2, "0")}`;
}

function cellText($: cheerio.CheerioAPI, el: cheerio.Element): string {
  return $(el).text().replace(/​/g, "").trim();
}

async function fetchHtml(url: string, timeoutMs = 15000, ua = "Mozilla/5.0 (compatible; PrayerTimesBot/1.0)"): Promise<string> {
  const r = await fetch(url, {
    headers: {
      "User-Agent": ua,
      Accept: "text/html",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.text();
}

// Extract HH:MM from an ISO timestamp: "2026-09-11T05:14:00+01:00" → "05:14"
function isoToHHMM(iso: string | undefined): string {
  if (!iso) return "";
  const match = iso.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : "";
}

// ── MasjidBox scraper (shared for all MasjidBox mosques) ──────────────────
// MasjidBox embeds all prayer + iqamah times server-side in window.REDUX_STATE,
// so a plain HTML fetch is enough — no browser or API key required.

async function scrapeMasjidBox(slug: string, source: string): Promise<DailyTimes> {
  const html = await fetchHtml(
    `https://masjidbox.com/prayer-times/${slug}`,
    15000,
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
  );

  // The value mixes standard %XX and non-standard %uXXXX Unicode escapes
  const match = html.match(/window\.REDUX_STATE\s*=\s*'([\s\S]+?)'\s*;/);
  if (!match) throw new Error(`MasjidBox ${slug}: REDUX_STATE not found in page`);

  const decoded = match[1]
    .replace(/%u([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const json = decodeURIComponent(decoded);
  const state = JSON.parse(json);
  const timetable: any[] = state.masjidbox.masjidboxAthany.timetable;

  const today = todayKey();
  const entry = timetable.find((t: any) => t.date.startsWith(today));
  if (!entry) throw new Error(`MasjidBox ${slug}: no timetable entry for ${today}`);

  return {
    adhan: {
      Fajr: isoToHHMM(entry.fajr),
      Dhuhr: isoToHHMM(entry.dhuhr),
      Asr: isoToHHMM(entry.asr),
      Maghrib: isoToHHMM(entry.maghrib),
      Isha: isoToHHMM(entry.isha),
    },
    jamaat: {
      Fajr: isoToHHMM(entry.iqamah?.fajr),
      Dhuhr: isoToHHMM(entry.iqamah?.dhuhr),
      Asr: isoToHHMM(entry.iqamah?.asr),
      Maghrib: isoToHHMM(entry.iqamah?.maghrib),
      Isha: isoToHHMM(entry.iqamah?.isha),
    },
    source,
  };
}

// ── Individual scrapers ────────────────────────────────────────────────────

async function scrapeEdinburgh(): Promise<DailyTimes> {
  const html = await fetchHtml("https://edmosque.org/about-the-mosque/prayer-times/");
  const $ = cheerio.load(html);
  const today = new Date().getDate();
  let jamFajr = "", jamZuhr = "", jamAsr = "", jamMaghribOffset = 0, jamIsha = "";
  let result: DailyTimes | null = null;
  $("table tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length === 0) return;
    const first = cellText($, cells.get(0)!).toLowerCase();
    if (first.includes("jama") || first.includes("jamā")) {
      if (cells.length >= 6) {
        jamFajr = pad24(cellText($, cells.get(1)!));
        jamZuhr = pad24(cellText($, cells.get(2)!));
        jamAsr = pad24(cellText($, cells.get(3)!));
        const maghribCell = cellText($, cells.get(4)!);
        const offsetM = maghribCell.match(/\+\s*(\d+)/);
        jamMaghribOffset = offsetM ? parseInt(offsetM[1]) : 0;
        jamIsha = pad24(cellText($, cells.get(5)!));
      }
      return;
    }
    const day = parseInt(first);
    if (isNaN(day) || day !== today) return;
    if (cells.length < 7) return;
    const adhanMaghrib = pad24(cellText($, cells.get(5)!));
    const jamMaghrib = addMinutes(adhanMaghrib, jamMaghribOffset);
    result = {
      adhan: { Fajr: pad24(cellText($, cells.get(2)!)), Dhuhr: pad24(cellText($, cells.get(3)!)), Asr: pad24(cellText($, cells.get(4)!)), Maghrib: adhanMaghrib, Isha: pad24(cellText($, cells.get(6)!)) },
      jamaat: { Fajr: jamFajr, Dhuhr: jamZuhr, Asr: jamAsr, Maghrib: jamMaghrib, Isha: jamIsha },
      source: "https://edmosque.org/about-the-mosque/prayer-times/",
    };
    return false as any;
  });
  if (!result) throw new Error("Edinburgh: today's row not found");
  return result!;
}

async function scrapeGlasgow(): Promise<DailyTimes> {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const res = await fetch(
    `https://maktabonline.co.uk/api/prayers/timings/5f21a98335596f0f6464b0c3?day=${dd}/${mm}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`Maktab API HTTP ${res.status}`);
  const t = await res.json();
  return {
    adhan: { Fajr: t.fajrBegins, Dhuhr: t.zuhrBegins, AsrMithl1: t.asrMithl1, AsrMithl2: t.asrMithl2, Maghrib: t.maghribBegins, Isha: t.ishaBegins },
    jamaat: { Fajr: t.fajrJamah, Dhuhr: t.zuhrJamah, Asr: t.asrJamah, Maghrib: t.maghribJamah, Isha: t.ishaJamah },
    source: "https://nmic.co.uk/",
  };
}

async function scrapeManchester(): Promise<DailyTimes> {
  // The prayer times page fires an AJAX POST to admin-ajax.php on load.
  // Plugin: prayer-import. Action: mcm_get_month_file, param: current_file="Sep 2026".
  // Times use dot-separated 12h format without AM/PM (e.g. "4.30", "1.06").
  // Fajr columns are AM; all other prayer columns are PM.
  // Column layout (0-based):
  //   0=day  1=dayName  2=islamicDate
  //   3=FajrAdhan  4=Sunrise  5=Zawal
  //   6=ZuhrAdhan  7=AsrAdhan  8=Sunset(MaghribAdhan)  9=IshaAdhan
  //   10=FajrJamaat  11=ZuhrJamaat  12=AsrJamaat  13=MaghribJamaat  14=IshaJamaat
  const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const now = new Date();
  const month = MONTH_ABBR[now.getMonth()];
  const year = now.getFullYear();
  const today = now.getDate();
  const currentFile = `${month} ${year}`; // e.g. "Sep 2026"

  const res = await fetch("https://manchestercentralmosque.org/wp-admin/admin-ajax.php", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Referer": "https://manchestercentralmosque.org/prayer-times/",
      "Origin": "https://manchestercentralmosque.org",
    },
    body: `action=mcm_get_month_file&current_file=${encodeURIComponent(currentFile)}`,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Manchester admin-ajax HTTP ${res.status}`);
  const html = await res.text();

  const $ = cheerio.load(html);
  let result: DailyTimes | null = null;

  $("table tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 15) return;
    const dayText = cellText($, cells.get(0)!).trim();
    if (parseInt(dayText) !== today) return;
    const c = (i: number) => cellText($, cells.get(i)!);
    result = {
      adhan: {
        Fajr: dotTo24(c(3), false),
        Dhuhr: dotTo24(c(6), true),
        Asr: dotTo24(c(7), true),
        Maghrib: dotTo24(c(8), true),
        Isha: dotTo24(c(9), true),
      },
      jamaat: {
        Fajr: dotTo24(c(10), false),
        Dhuhr: dotTo24(c(11), true),
        Asr: dotTo24(c(12), true),
        Maghrib: dotTo24(c(13), true),
        Isha: dotTo24(c(14), true),
      },
      source: "https://manchestercentralmosque.org/prayer-times/",
    };
    return false as any;
  });

  if (!result) throw new Error(`Manchester: row for day ${today} not found`);
  return result!;
}

// ── Router ─────────────────────────────────────────────────────────────────

const SCRAPERS: Record<string, () => Promise<DailyTimes>> = {
  "glasgow-central":    scrapeGlasgow,
  "edinburgh-central":  scrapeEdinburgh,
  "east-london":        () => scrapeMasjidBox("eastlondonmosque",       "https://masjidbox.com/prayer-times/eastlondonmosque"),
  "birmingham-central": () => scrapeMasjidBox("centralmosque",           "https://masjidbox.com/prayer-times/centralmosque"),
  "manchester-central": scrapeManchester,
};

// ── Fetch today's times from prayer_times table ────────────────────────────
async function fromDatabase(mosqueId: string): Promise<DailyTimes | null> {
  try {
    const sb = getSupabase();
    const today = todayKey();
    const { data, error } = await sb
      .from("prayer_times")
      .select("*")
      .eq("mosque_id", mosqueId)
      .eq("date", today)
      .single();
    if (error || !data) return null;

    const t = (v: string | null) => v ? v.substring(0, 5) : ""; // "HH:MM:SS" → "HH:MM"

    return {
      adhan: {
        Fajr:      t(data.fajr_start),
        Dhuhr:     t(data.zuhr_start),
        AsrMithl1: t(data.asr_mithl1),
        AsrMithl2: t(data.asr_mithl2),
        Asr:       t(data.asr_mithl1 || data.asr_start), // fallback
        Maghrib:   t(data.maghrib_start),
        Isha:      t(data.isha_start),
      },
      jamaat: {
        Fajr:    t(data.fajr_jamaat),
        Dhuhr:   t(data.zuhr_jamaat),
        Asr:     t(data.asr_jamaat),
        Maghrib: t(data.maghrib_jamaat),
        Isha:    t(data.isha_jamaat),
      },
      source: "database",
    };
  } catch {
    return null;
  }
}

// ── Is this a UUID (DB mosque) or a slug (hardcoded scraper)? ──────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/mosque-timetable/:mosqueId", async (req, res) => {
  const { mosqueId } = req.params;

  // UUID-based mosque → try prayer_times table first
  if (UUID_RE.test(mosqueId)) {
    const dbTimes = await fromDatabase(mosqueId);
    if (dbTimes) {
      res.setHeader("Cache-Control", "public, max-age=1800");
      return res.json(dbTimes);
    }
    // No data in DB yet for today
    return res.status(404).json({ error: "No timetable available for this mosque today" });
  }

  // Slug-based mosque → use hardcoded scraper
  const scraper = SCRAPERS[mosqueId];
  if (!scraper) {
    return res.status(404).json({ error: "No timetable available for this mosque" });
  }
  try {
    const times = await withCache(mosqueId, scraper);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json(times);
  } catch (err: any) {
    console.error(`[mosque-timetable] ${mosqueId}:`, err.message);
    res.status(502).json({ error: `Failed to fetch timetable: ${err.message}` });
  }
});

// ── Haversine distance in metres ──────────────────────────────────────────
function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── List mosques by city OR by lat/lng radius ─────────────────────────────
router.get("/mosques", async (req, res) => {
  const city    = (req.query.city   as string | undefined)?.trim();
  const latStr  = req.query.lat     as string | undefined;
  const lngStr  = req.query.lng     as string | undefined;
  const radiusStr = req.query.radius as string | undefined; // miles

  const useRadius = latStr && lngStr;

  if (!city && !useRadius) {
    return res.status(400).json({ error: "Provide either 'city' or 'lat'+'lng' query params" });
  }

  try {
    const sb = getSupabase();

    if (useRadius) {
      const lat    = parseFloat(latStr!);
      const lng    = parseFloat(lngStr!);
      const miles  = parseFloat(radiusStr ?? "5");   // default 5 miles
      const metres = miles * 1609.344;

      // Bounding box (1 degree lat ≈ 111 km; 1 degree lng ≈ 111*cos(lat) km)
      const latDelta = metres / 111_000;
      const lngDelta = metres / (111_000 * Math.cos(lat * Math.PI / 180));

      const { data, error } = await sb
        .from("mosques")
        .select("id, name, city, postcode, latitude, longitude, has_online_presence, ingestion_type")
        .gte("latitude",  lat - latDelta)
        .lte("latitude",  lat + latDelta)
        .gte("longitude", lng - lngDelta)
        .lte("longitude", lng + lngDelta)
        .not("latitude",  "is", null)
        .not("longitude", "is", null);

      if (error) throw error;

      // Exact Haversine filter + add distance_miles
      const filtered = (data ?? [])
        .map(m => ({ ...m, distance_miles: distanceM(lat, lng, m.latitude, m.longitude) / 1609.344 }))
        .filter(m => m.distance_miles <= miles)
        .sort((a, b) => a.distance_miles - b.distance_miles);

      res.setHeader("Cache-Control", "public, max-age=300"); // 5 min cache for location queries
      return res.json(filtered);
    }

    // City filter (original behaviour)
    const { data, error } = await sb
      .from("mosques")
      .select("id, name, city, postcode, latitude, longitude, has_online_presence, ingestion_type")
      .ilike("city", city!)
      .order("name");
    if (error) throw error;
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json(data ?? []);

  } catch (err: any) {
    console.error("[/api/mosques]", err.message);
    res.status(500).json({ error: "Failed to fetch mosques" });
  }
});

export default router;
