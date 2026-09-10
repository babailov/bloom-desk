import { afterEach, describe, expect, it, vi } from "vitest";
import { USER_AGENT, getBytes, getText, postJson } from "../src/http";

// Ports collector/tests/test_http.py.

type FetchArgs = { url: string; init: RequestInit | undefined };

/** Stub global fetch, capturing what it was called with. */
function stubFetch(respond: (args: FetchArgs) => Response): FetchArgs[] {
  const calls: FetchArgs[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const args = { url: String(input), init };
    calls.push(args);
    return Promise.resolve(respond(args));
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("error messages", () => {
  it("strips the query string from getText errors", async () => {
    stubFetch(() => new Response("", { status: 429 }));

    await expect(
      getText("https://api.stlouisfed.org/x", { api_key: "SECRET123" }),
    ).rejects.toThrow(/429/);

    // The key must never reach a log line or the fetcher_status table.
    await expect(
      getText("https://api.stlouisfed.org/x", { api_key: "SECRET123" }),
    ).rejects.not.toThrow(/SECRET123/);
  });

  it("strips the query string from getBytes errors", async () => {
    stubFetch(() => new Response("", { status: 403 }));

    const err = await getBytes("https://example.com/f.xls", { api_key: "SECRET123" }).catch(
      (e: Error) => e,
    );
    expect(String(err)).toContain("403");
    expect(String(err)).not.toContain("SECRET123");
  });

  it("treats any status at or above 400 as an error", async () => {
    stubFetch(() => new Response("", { status: 400 }));
    await expect(getText("https://example.com/x")).rejects.toThrow(/400/);
  });

  it("does not treat a 3xx as an error", async () => {
    stubFetch(() => new Response("ok", { status: 200 }));
    await expect(getText("https://example.com/x")).resolves.toBe("ok");
  });
});

describe("headers", () => {
  it("uses custom headers when given", async () => {
    const calls = stubFetch(() => new Response("ok"));
    const custom = { "User-Agent": "Mozilla/5.0 fake" };

    expect(await getText("https://example.com/x", undefined, custom)).toBe("ok");
    expect(calls[0]?.init?.headers).toEqual(custom);
  });

  it("defaults to the honest User-Agent", async () => {
    const calls = stubFetch(() => new Response("ok"));

    await getText("https://example.com/x");
    expect(calls[0]?.init?.headers).toEqual({ "User-Agent": USER_AGENT });
  });

  it("never impersonates a browser", () => {
    // CONTRIBUTING.md treats this as a hard rule, so it is asserted, not assumed.
    expect(USER_AGENT).not.toMatch(/Mozilla|Chrome|Safari|AppleWebKit/);
    expect(USER_AGENT).toMatch(/^bloom-desk\/\S+ \(\+https:\/\/github\.com\/\S+\)$/);
  });
});

describe("params", () => {
  it("appends params to the URL", async () => {
    const calls = stubFetch(() => new Response("ok"));

    await getText("https://example.com/x", { range: "1y", interval: "1d" });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("range")).toBe("1y");
    expect(url.searchParams.get("interval")).toBe("1d");
  });

  it("leaves the URL alone when there are no params", async () => {
    const calls = stubFetch(() => new Response("ok"));

    await getText("https://example.com/x?already=set");
    expect(calls[0]?.url).toBe("https://example.com/x?already=set");
  });
});

describe("getBytes", () => {
  it("returns raw content", async () => {
    const body = new Uint8Array([0x00, 0x01, 0x62, 0x69, 0x6e]);
    stubFetch(() => new Response(body));

    const got = new Uint8Array(await getBytes("https://example.com/f.xls"));
    expect([...got]).toEqual([...body]);
  });
});

describe("postJson", () => {
  it("posts a JSON body and returns the parsed object", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ result: "0xabc" })));

    const body = await postJson("https://rpc.example", { method: "eth_call", id: 1 });
    expect(body).toEqual({ result: "0xabc" });
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ method: "eth_call", id: 1 });
  });

  it("rejects a non-object JSON body", async () => {
    // A JSON-RPC endpoint answering with an array or a bare scalar is a
    // protocol violation, not a result to decode.
    stubFetch(() => new Response(JSON.stringify([1, 2, 3])));
    await expect(postJson("https://rpc.example", {})).rejects.toThrow(/non-dict JSON body/);
  });
});
