import { Router } from "express";
import * as cheerio from "cheerio";

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

async function fetchHtml(url: string, timeoutMs = 15000): Promise<string> {
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PrayerTimesBot/1.0)",
      Accept: "text/html",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.text();
}

function elmTo24(t: string, isPm: boolean): string {
  const s = t.trim();
  const [h, m] = s.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return "";
  let h24 = h;
  if (isPm && h < 12) h24 = h + 12;
  if (!isPm && h === 12) h24 = 0;
  return `${String(h24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function isToday(cell: string): boolean {
  const now = new Date();
  const d = now.getDate(), m = now.getMonth() + 1, y = now.getFullYear();
  const text = cell.replace(/(\d+)(st|nd|rd|th)/gi, "$1").trim();
  const MONTHS: Record<string, number> = {
    january:1,february:2,march:3,april:4,may:5,june:6,
    july:7,august:8,september:9,october:10,november:11,december:12,
    jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12
  };
  const t = text.match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/i);
  if (t) {
    const mo = MONTHS[t[2].toLowerCase()];
    return !!mo && parseInt(t[1]) === d && mo === m && parseInt(t[3]) === y;
  }
  const s = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (s) return parseInt(s[1]) === d && parseInt(s[2]) === m && parseInt(s[3]) === y;
  return false;
}

// ── Scrapers ───────────────────────────────────────────────────────────────

async function scrapeEastLondon(): Promise<DailyTimes> {
  const html = await fetchHtml("https://www.eastlondonmosque.org.uk/prayer-times");
  const $ = cheerio.load(html);
  const now = new Date();
  const dateStr = `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()}`;
  let result: DailyTimes | null = null;
  $("table tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 15) return;
    if (cellText($, cells.get(0)!) !== dateStr) return;
    const c = (i: number) => cellText($, cells.get(i)!);
    result = {
      adhan: { Fajr: elmTo24(c(5), false), Dhuhr: elmTo24(c(7), true), Asr: elmTo24(c(9), true), Maghrib: elmTo24(c(12), true), Isha: elmTo24(c(14), true) },
      jamaat: { Fajr: elmTo24(c(6), false), Dhuhr: elmTo24(c(8), true), Asr: elmTo24(c(11), true), Maghrib: elmTo24(c(13), true), Isha: elmTo24(c(15), true) },
      source: "https://www.eastlondonmosque.org.uk/prayer-times",
    };
    return false as any;
  });
  if (!result) throw new Error(`East London: no row for ${dateStr}`);
  return result!;
}

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

async function scrapeBirmingham(): Promise<DailyTimes> {
  // Try HTML pages directly — Cloudflare blocks wp-json for Railway's IPs
  const BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
    "Referer": "https://centralmosque.org.uk/",
  };

  const URLS = [
    "https://centralmosque.org.uk/mobile-timetable/",
    "https://centralmosque.org.uk/timetable/",
    "https://centralmosque.org.uk/prayer-times/",
  ];

  function parseTodayRow(html: string, source: string): DailyTimes | null {
    const $ = cheerio.load(html);
    let result: DailyTimes | null = null;
    $("table tr").each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length < 13) return;
      const rowClass = ($(row).attr("class") || "").toLowerCase();
      const todayByClass = rowClass.includes("today");
      const todayByDate = !todayByClass && isToday(cellText($, cells.get(0)!));
      if (!todayByClass && !todayByDate) return;
      result = {
        adhan: {
          Fajr: pad24(cellText($, cells.get(2)!)),
          Dhuhr: pad24(cellText($, cells.get(6)!)),
          Asr: pad24(cellText($, cells.get(8)!)),
          Maghrib: pad24(cellText($, cells.get(10)!)),
          Isha: pad24(cellText($, cells.get(12)!)),
        },
        jamaat: {
          Fajr: pad24(cellText($, cells.get(3)!)),
          Dhuhr: pad24(cellText($, cells.get(7)!)),
          Asr: pad24(cellText($, cells.get(9)!)),
          Maghrib: pad24(cellText($, cells.get(11)!)),
          Isha: pad24(cellText($, cells.get(13)!)),
        },
        source,
      };
      return false as any;
    });
    return result;
  }

  const errors: string[] = [];
  for (const url of URLS) {
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(15000) });
      if (!res.ok) { errors.push(`${url} → HTTP ${res.status}`); continue; }
      const html = await res.text();
      if (html.length < 5000 || !html.includes("<table")) {
        errors.push(`${url} → no table found (possibly Cloudflare challenge)`); continue;
      }
      const result = parseTodayRow(html, url);
      if (result) return result;
      errors.push(`${url} → today's row not found in table`);
    } catch (e: unknown) {
      errors.push(`${url} → ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`Birmingham: all URLs failed — ${errors.join("; ")}`);
}

async function scrapeGlasgow(): Promise<DailyTimes> {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const res = await fetch(
    `https://maktabonline.co.uk/api/prayers/timings/6064ea57133de011c43f930f?day=${dd}/${mm}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`Maktab API HTTP ${res.status}`);
  const t = await res.json();
  return {
    adhan: { Fajr: t.fajrBegins, Dhuhr: t.zuhrBegins, Asr: t.asrMithl1, Maghrib: t.maghribBegins, Isha: t.ishaBegins },
    jamaat: { Fajr: t.fajrJamah, Dhuhr: t.zuhrJamah, Asr: t.asrJamah, Maghrib: t.maghribJamah, Isha: t.ishaJamah },
    source: "https://nmic.co.uk/",
  };
}

async function scrapeManchester(): Promise<DailyTimes> {
  // The prayer times page fires an AJAX POST to admin-ajax.php on load.
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
  const today = now.getDate();

  const res = await fetch("https://manchestercentralmosque.org/wp-admin/admin-ajax.php", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Referer": "https://manchestercentralmosque.org/prayer-times/",
      "Origin": "https://manchestercentralmosque.org",
    },
    body: `action=get_monthly_timetable&month=${month}`,
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
  "glasgow-central": scrapeGlasgow,
  "east-london": scrapeEastLondon,
  "edinburgh-central": scrapeEdinburgh,
  "birmingham-central": scrapeBirmingham,
  "manchester-central": scrapeManchester,
};

router.get("/mosque-timetable/:mosqueId", async (req, res) => {
  const { mosqueId } = req.params;
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

export default router;
