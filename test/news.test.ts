import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { dedupeKey, fetchNews, parseEntries, type FeedCfg, type NewsItem } from "../src/fetchers/news";
import { Store } from "../src/store";

// Ports collector/tests/test_news.py, plus the upstream shapes feedparser used
// to absorb for us: a BOM, CDATA fields, single-digit days, padded titles,
// numeric UTC offsets, RDF and Atom.

import FT_XML from "./fixtures/rss_ft.xml?raw";
import FED_XML from "./fixtures/rss_fed.xml?raw";
import ECB_XML from "./fixtures/rss_ecb.xml?raw";

function store(): Store {
  return new Store(env.DB);
}

async function newsItems(): Promise<NewsItem[]> {
  const doc = await store().doc<{ items: NewsItem[] }>("news");
  return doc?.payload.items ?? [];
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM docs").run();
});

describe("dedupeKey", () => {
  it("normalizes case and punctuation", () => {
    expect(dedupeKey("ECB Signals Pause on Rate Cuts!")).toBe(
      dedupeKey("ecb signals pause on rate cuts"),
    );
  });

  it("keeps the full headline so similar stories stay distinct", () => {
    // Truncating would collide these and silently drop a real story.
    const a = dedupeKey("Live updates: ECB holds rates");
    const b = dedupeKey("Live updates: Fed holds rates");
    expect(a).not.toBe(b);
  });
});

describe("fetchNews", () => {
  it("merges, dedupes, sorts newest first, and caps", async () => {
    const feeds: FeedCfg[] = [
      { name: "FT", url: "http://a" },
      { name: "FT2", url: "http://b" },
      { name: "Dead", url: "http://dead" },
    ];
    const getText = async (url: string) => {
      if (url === "http://dead") throw new Error("connection refused");
      return FT_XML; // both live feeds return the same items -> dedupe
    };

    expect(await fetchNews(feeds, store(), getText, 1)).toBe("rss");

    const items = await newsItems();
    expect(items).toHaveLength(1); // 2 unique, capped to 1
    expect(items[0]?.headline).toBe("ECB signals pause on rate cuts"); // newest first
    expect(items[0]?.feed).toBe("FT");
    expect(items[0]?.url).toMatch(/^https:\/\/www\.ft\.com\//);
    expect(items[0]?.published_at).toBeTruthy();
  });

  it("raises when every feed is dead", async () => {
    const getText = async () => {
      throw new Error("nope");
    };
    await expect(
      fetchNews([{ name: "FT", url: "http://a" }], store(), getText, 5),
    ).rejects.toThrow(/all news feeds failed/);
  });

  it("skips entries missing a title or a link", async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>Has both</title><link>https://e.com/1</link></item>
      <item><title>No link</title></item>
      <item><link>https://e.com/3</link></item>
    </channel></rss>`;
    await fetchNews([{ name: "X", url: "u" }], store(), async () => xml, 10);

    const items = await newsItems();
    expect(items.map((i) => i.headline)).toEqual(["Has both"]);
  });
});

describe("upstream shapes feedparser used to absorb", () => {
  it("parses the Fed feed: BOM, CDATA fields, single-digit day", async () => {
    const entries = parseEntries(FED_XML);
    expect(entries.length).toBeGreaterThan(0);

    await fetchNews([{ name: "Fed", url: "u" }], store(), async () => FED_XML, 10);
    const items = await newsItems();

    expect(items.length).toBeGreaterThan(0);
    // CDATA-wrapped link must come through as a plain URL, not an object.
    expect(items[0]?.url).toMatch(/^https:\/\/www\.federalreserve\.gov\//);
    expect(items[0]?.headline).not.toMatch(/CDATA/);
    // "Fri, 4 Sep 2026 15:00:00 GMT" -- single-digit day, must still parse.
    expect(items[0]?.published_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(items[0]?.published_at).not.toBe(items[0]?.headline);
  });

  it("parses the ECB feed: padded titles, numeric UTC offset", async () => {
    await fetchNews([{ name: "ECB", url: "u" }], store(), async () => ECB_XML, 10);
    const items = await newsItems();

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.headline).toBe(item.headline.trim());
      expect(item.headline.length).toBeGreaterThan(0);
    }
    // +0200 offsets must normalize to UTC, not be dropped.
    expect(items[0]?.published_at).toMatch(/Z$/);
  });

  it("handles a feed with exactly one item", async () => {
    // fast-xml-parser gives an object rather than an array for a single child.
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>Only one</title><link>https://e.com/1</link></item>
    </channel></rss>`;
    expect(parseEntries(xml)).toHaveLength(1);
  });

  it("handles RSS 1.0 / RDF, where items sit outside a channel", () => {
    const xml = `<?xml version="1.0"?>
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
        <channel><title>Feed</title></channel>
        <item><title>An item</title><link>https://e.com/1</link></item>
      </rdf:RDF>`;
    const entries = parseEntries(xml);
    expect(entries).toHaveLength(1);
  });

  it("handles Atom, where the link is an href attribute", async () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Atom entry</title>
          <link href="https://e.com/atom"/>
          <updated>2026-07-08T13:00:00Z</updated>
        </entry>
      </feed>`;
    await fetchNews([{ name: "A", url: "u" }], store(), async () => xml, 10);

    const items = await newsItems();
    expect(items[0]?.url).toBe("https://e.com/atom");
    expect(items[0]?.published_at).toBe("2026-07-08T13:00:00.000Z");
  });

  it("dates an entry with no usable timestamp to now rather than dropping it", async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>No date</title><link>https://e.com/1</link><pubDate>not a date</pubDate></item>
    </channel></rss>`;
    const before = Date.now();
    await fetchNews([{ name: "X", url: "u" }], store(), async () => xml, 10);

    const items = await newsItems();
    expect(items).toHaveLength(1);
    expect(Date.parse(items[0]!.published_at)).toBeGreaterThanOrEqual(before - 1000);
  });

  it("does not coerce a numeric headline into a number", async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>2026</title><link>https://e.com/1</link></item>
    </channel></rss>`;
    await fetchNews([{ name: "X", url: "u" }], store(), async () => xml, 10);

    const items = await newsItems();
    expect(items[0]?.headline).toBe("2026");
    expect(typeof items[0]?.headline).toBe("string");
  });
});
