/**
 * News: merge configured sources, dedupe by normalized headline, newest first.
 * Port of collector/src/collector/fetchers/news.py.
 *
 * RSS is the only source.
 *
 * The Python original leaned on feedparser, which silently absorbs a lot of
 * upstream sloppiness. Replacing it means absorbing that sloppiness here
 * instead, and the five configured feeds already exercise most of it:
 *
 *   - federalreserve.gov ships a UTF-8 BOM before the XML declaration, wraps
 *     every field in CDATA, and writes single-digit days ("Fri, 4 Sep 2026").
 *   - ecb.europa.eu pads titles with leading whitespace and uses a numeric UTC
 *     offset ("+0200") rather than a zone name.
 *   - A feed with exactly one <item> parses to an object, not an array.
 *
 * All five are RSS 2.0 today. RDF and Atom are handled anyway, because a feed
 * changing shape is not a thing we would find out about politely.
 */
import { XMLParser } from "fast-xml-parser";

import type { GetText } from "../http";
import type { Store } from "../store";

export interface FeedCfg {
  name: string;
  url: string;
}

export interface NewsItem {
  headline: string;
  url: string;
  feed: string;
  published_at: string;
  source: string;
}

const parser = new XMLParser({
  ignoreAttributes: false, // Atom puts the link in an href attribute
  attributeNamePrefix: "@",
  trimValues: true, // ECB pads titles with whitespace
  parseTagValue: false, // a headline of "2026" is a string, not a number
  // cdataPropName is deliberately unset: CDATA then merges into the tag's text
  // value, which is what the Fed feed needs.
});

/**
 * Normalized dedupe key: the full headline, lowercased, punctuation removed.
 *
 * Full, not truncated -- truncating collides "Live updates: ..."-style
 * headlines that differ only in the tail, silently dropping real stories.
 */
export function dedupeKey(headline: string): string {
  return headline
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

/** Coerce fast-xml-parser's "one child is an object, many are an array" shape. */
function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Read a tag that may be a bare string, a CDATA-merged object, or absent. */
function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const inner = (value as Record<string, unknown>)["#text"];
    if (typeof inner === "string") return inner.trim() || null;
  }
  return null;
}

/** Atom links live in an href attribute; RSS links are element text. */
function link(value: unknown): string | null {
  const direct = text(value);
  if (direct) return direct;
  for (const candidate of asArray(value)) {
    if (candidate && typeof candidate === "object") {
      const href = (candidate as Record<string, unknown>)["@href"];
      if (typeof href === "string" && href.trim()) return href.trim();
    }
  }
  return null;
}

/**
 * Entry timestamp as ISO-8601 UTC, falling back to now when absent or
 * unparseable -- mirrors news.py's `_entry_time`. A story with a broken date is
 * still a story; dropping it would be worse than dating it to this run.
 */
function entryTime(entry: Record<string, unknown>): string {
  for (const key of ["pubDate", "published", "updated", "dc:date", "date"]) {
    const raw = text(entry[key]);
    if (!raw) continue;
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

/** Pull entries out of RSS 2.0, RSS 1.0/RDF or Atom without caring which. */
export function parseEntries(xml: string): Record<string, unknown>[] {
  // Strip a UTF-8 BOM: it precedes the XML declaration and derails the parser.
  const doc = parser.parse(xml.replace(/^﻿/, "")) as Record<string, unknown>;

  const rss = doc["rss"] as Record<string, unknown> | undefined;
  if (rss) {
    const channels = asArray(rss["channel"]) as Record<string, unknown>[];
    return channels.flatMap((c) => asArray(c["item"]) as Record<string, unknown>[]);
  }

  const rdf = (doc["rdf:RDF"] ?? doc["RDF"]) as Record<string, unknown> | undefined;
  if (rdf) return asArray(rdf["item"]) as Record<string, unknown>[];

  const feed = doc["feed"] as Record<string, unknown> | undefined;
  if (feed) return asArray(feed["entry"]) as Record<string, unknown>[];

  return [];
}

export async function fetchNews(
  feeds: readonly FeedCfg[],
  store: Store,
  getText: GetText,
  maxItems: number,
): Promise<string> {
  const items: NewsItem[] = [];

  for (const feed of feeds) {
    let entries: Record<string, unknown>[];
    try {
      entries = parseEntries(await getText(feed.url));
    } catch (err) {
      // spec: drop dead feeds silently, one bad feed must not kill the run
      console.warn(`news feed ${feed.name} dead, skipping: ${String(err)}`);
      continue;
    }
    for (const entry of entries) {
      const headline = text(entry["title"]);
      const url = link(entry["link"]);
      if (!headline || !url) continue;
      items.push({
        headline,
        url,
        feed: feed.name,
        published_at: entryTime(entry),
        source: "rss",
      });
    }
  }

  if (items.length === 0) throw new Error("all news feeds failed");

  items.sort((a, b) => (a.published_at < b.published_at ? 1 : a.published_at > b.published_at ? -1 : 0));

  const seen = new Set<string>();
  const unique: NewsItem[] = [];
  for (const item of items) {
    const key = dedupeKey(item.headline);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  await store.putDoc("news", { items: unique.slice(0, maxItems) }, "rss");
  return "rss";
}
