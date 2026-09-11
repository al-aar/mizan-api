import { Router } from "express";
import * as cheerio from "cheerio";

const router = Router();

interface DailyTimes {
  adhan: Record<string, string>;
  jamaat: Record<string, string>;
  source: string;
}

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

function addMinutes(t: string, n: number): string {
  const [h, m] = t.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return t;
  const tot = h * 60 + m + n;
  return `${String(Math.floor(tot / 60) % 24).padStart(2, "0")}:${String(tot % 60).padStart(2, "0")}`;
}

function cellText($: cheerio.CheerioAPI, el: cheerio.Element): string {
  return $(el).text().replace(/\u200b/g, "").trim();
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

      // Prefer the website's own "today" CSS class — most reliable
      const rowClass = ($(row).attr("class") || "").toLowerCase();
      const todayByClass = rowClass.includes("today");
      // Fallback: match by date text in first column
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
      const res = await fetch(url, {
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        errors.push(`${url} → HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      // Cloudflare challenge pages are small and contain no table data
      if (html.length < 5000 || !html.includes("<table")) {
        errors.push(`${url} → no table found (possibly Cloudflare challenge)`);
        continue;
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

const SCRAPERS: Record<string, () => Promise<DailyTimes>> = {
  "glasgow-central": scrapeGlasgow,
  "east-london": scrapeEastLondon,
  "edinburgh-central": scrapeEdinburgh,
  "birmingham-central": scrapeBirmingham,
};

router.get("/mosque-timetable/:mosqueId", async (req, res) => {
  const { mosqueId } = req.params;
  const scraper = SCRAPERS[mosqueId];
  if (!scraper) {
    return res.status(404).json({ error: "No timetable available for this mosque" });
  }
  try {
    const times = await scraper();
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json(times);
  } catch (err: any) {
    console.error(`[mosque-timetable] ${mosqueId}:`, err.message);
    res.status(502).json({ error: `Failed to fetch timetable: ${err.message}` });
  }
});

export default router;