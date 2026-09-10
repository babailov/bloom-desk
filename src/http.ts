/**
 * HTTP helpers, injected into fetchers so tests never touch the network.
 * Port of collector/src/collector/http.py.
 *
 * The injection seam is the whole reason the fetcher ports are testable: every
 * fetcher takes one of these as an argument, and tests pass a function that
 * returns a recorded fixture.
 */

/**
 * Honest, contactable User-Agent. Standard `product/version (comment)` syntax:
 * some upstream WAFs (aaii.com) reject a bare product token, so the comment is
 * load-bearing, not decoration. We never impersonate a browser -- upstreams can
 * identify and contact us, and every source we use serves this UA fine.
 *
 * Points at this fork, not at cleyfe/os-bloom. A hosted deployment earns its
 * own rate limits and they must not land on the original author's repo.
 */
export const USER_AGENT = "bloom-desk/0.1 (+https://github.com/babailov/bloom-desk)";

const TEXT_TIMEOUT_MS = 20_000;
const BYTES_TIMEOUT_MS = 30_000; // binary sources (Excel files) are MB-sized

export type GetText = (
  url: string,
  params?: Record<string, string>,
  headers?: Record<string, string>,
) => Promise<string>;

export type GetBytes = (
  url: string,
  params?: Record<string, string>,
  headers?: Record<string, string>,
) => Promise<ArrayBuffer>;

export type PostJson = (
  url: string,
  json: unknown,
  headers?: Record<string, string>,
) => Promise<Record<string, unknown>>;

function withParams(url: string, params?: Record<string, string>): string {
  if (!params) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * Strip the query string before putting a URL in an error message: it can carry
 * API keys, and this message ends up in logs and the fetcher_status table.
 */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    return u.toString();
  } catch {
    return url;
  }
}

async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (resp.status >= 400) {
    throw new Error(`HTTP ${resp.status} for ${safeUrl(url)}`);
  }
  return resp;
}

export const getText: GetText = async (url, params, headers) => {
  const resp = await request(
    withParams(url, params),
    { headers: headers ?? { "User-Agent": USER_AGENT } },
    TEXT_TIMEOUT_MS,
  );
  return resp.text();
};

export const getBytes: GetBytes = async (url, params, headers) => {
  const resp = await request(
    withParams(url, params),
    { headers: headers ?? { "User-Agent": USER_AGENT } },
    BYTES_TIMEOUT_MS,
  );
  return resp.arrayBuffer();
};

export const postJson: PostJson = async (url, json, headers) => {
  const resp = await request(
    url,
    {
      method: "POST",
      headers: headers ?? { "User-Agent": USER_AGENT, "Content-Type": "application/json" },
      body: JSON.stringify(json),
    },
    TEXT_TIMEOUT_MS,
  );
  const body: unknown = await resp.json();
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`non-dict JSON body for ${safeUrl(url)}`);
  }
  return body as Record<string, unknown>;
};
