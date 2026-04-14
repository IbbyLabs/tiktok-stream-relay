import test from "node:test";
import assert from "node:assert/strict";
import axios, { AxiosResponse } from "axios";
import { IbbyLabsParserProvider } from "../src/search/providers/ibbylabs-parser-provider.js";

function buildApiEntry(videoId: string, desc = "tate mcrae leaks"): unknown {
  return {
    type: 1,
    item: {
      id: videoId,
      desc,
      author: {
        nickname: "tester",
        uniqueId: "artist-id",
      },
      video: {
        duration: 20,
        cover: "https://example.com/cover.jpg",
      },
      music: {
        id: "sound-1",
        title: "original sound",
        authorName: "tester",
        duration: 20,
        coverLarge: "https://example.com/music.jpg",
      },
    },
  };
}

function authError(status: number): Error {
  return {
    name: "AxiosError",
    message: "auth",
    isAxiosError: true,
    response: { status, data: { message: "login" } },
  } as unknown as Error;
}

function throttleError(status = 429): Error {
  return {
    name: "AxiosError",
    message: "throttle",
    isAxiosError: true,
    response: { status, data: { message: "rate limited" } },
  } as unknown as Error;
}

test("provider uses auth cookie when configured", async () => {
  const originalGet = axios.get;
  const calls: string[] = [];

  (axios as unknown as { get: typeof axios.get }).get =
    (async (url: string, config?: { headers?: Record<string, string> }) => {
      calls.push(`${url}::${config?.headers?.cookie ?? ""}`);
      if (url.includes("/search?q=")) {
        return {
          data: "",
          headers: { "set-cookie": ["sid=anon; Path=/"] },
        } as AxiosResponse<string>;
      }

      return {
        data: {
          data: [buildApiEntry("111")],
          has_more: false,
          cursor: 1,
          statusCode: 0,
        },
      } as AxiosResponse;
    }) as typeof axios.get;

  try {
    const provider = new IbbyLabsParserProvider(36, {
      authCookie: "sessionid=auth_cookie",
      retryMaxAttempts: 0,
      retryBaseDelayMs: 1,
    });

    const page = await provider.search({ query: "tate mcrae leaks", limit: 5 });
    assert.equal(page.tracks.length, 1);

    const apiCall = calls.find((value) => value.includes("/api/search/general/full/"));
    assert.ok(apiCall);
    assert.ok(apiCall.includes("sessionid=auth_cookie"));
  } finally {
    (axios as unknown as { get: typeof axios.get }).get = originalGet;
  }
});

test("provider falls back to anonymous mode when auth fails", async () => {
  const originalGet = axios.get;
  const apiCookies: string[] = [];
  let apiCallCount = 0;

  (axios as unknown as { get: typeof axios.get }).get =
    (async (url: string, config?: { headers?: Record<string, string> }) => {
      if (url.includes("/search?q=")) {
        return {
          data: "",
          headers: { "set-cookie": ["sid=anon; Path=/"] },
        } as AxiosResponse<string>;
      }

      apiCallCount += 1;
      apiCookies.push(config?.headers?.cookie ?? "");
      if (apiCallCount === 1) {
        throw authError(401);
      }

      return {
        data: {
          data: [buildApiEntry("222")],
          has_more: false,
          cursor: 2,
          statusCode: 0,
        },
      } as AxiosResponse;
    }) as typeof axios.get;

  try {
    const provider = new IbbyLabsParserProvider(36, {
      authCookie: "sessionid=auth_cookie",
      retryMaxAttempts: 0,
      retryBaseDelayMs: 1,
    });

    const page = await provider.search({ query: "tate mcrae leaks", limit: 5 });
    assert.equal(page.tracks.length, 1);
    assert.equal(apiCallCount, 2);
    assert.ok(apiCookies[0].includes("sessionid=auth_cookie"));
    assert.equal(apiCookies[1].includes("sessionid=auth_cookie"), false);
  } finally {
    (axios as unknown as { get: typeof axios.get }).get = originalGet;
  }
});

test("provider returns partial results when throttled after first page", async () => {
  const originalGet = axios.get;
  let apiCallCount = 0;

  (axios as unknown as { get: typeof axios.get }).get =
    (async (url: string) => {
      if (url.includes("/search?q=")) {
        return {
          data: "",
          headers: { "set-cookie": ["sid=anon; Path=/"] },
        } as AxiosResponse<string>;
      }

      apiCallCount += 1;
      if (apiCallCount === 1) {
        return {
          data: {
            data: [buildApiEntry("333")],
            has_more: true,
            cursor: 10,
            statusCode: 0,
          },
        } as AxiosResponse;
      }

      throw throttleError(429);
    }) as typeof axios.get;

  try {
    const provider = new IbbyLabsParserProvider(36, {
      retryMaxAttempts: 0,
      retryBaseDelayMs: 1,
    });

    const page = await provider.search({ query: "tate mcrae leaks", limit: 3 });
    assert.equal(page.tracks.length, 1);
    assert.equal(page.partial, true);
    assert.equal(page.hasMore, false);
  } finally {
    (axios as unknown as { get: typeof axios.get }).get = originalGet;
  }
});

test("provider throws when throttled before collecting results", async () => {
  const originalGet = axios.get;

  (axios as unknown as { get: typeof axios.get }).get =
    (async (url: string) => {
      if (url.includes("/search?q=")) {
        return {
          data: "",
          headers: { "set-cookie": ["sid=anon; Path=/"] },
        } as AxiosResponse<string>;
      }

      throw throttleError(429);
    }) as typeof axios.get;

  try {
    const provider = new IbbyLabsParserProvider(36, {
      retryMaxAttempts: 0,
      retryBaseDelayMs: 1,
    });

    await assert.rejects(() => provider.search({ query: "tate mcrae leaks", limit: 3 }));
  } finally {
    (axios as unknown as { get: typeof axios.get }).get = originalGet;
  }
});
