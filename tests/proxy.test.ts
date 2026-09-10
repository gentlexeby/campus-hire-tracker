import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy } from "@/proxy";

const LOCAL_URL = "http://127.0.0.1:3210/api/resumes";

function post(headers: Record<string, string> = {}) {
  return proxy(new NextRequest(LOCAL_URL, {
    method: "POST",
    headers: { host: "127.0.0.1:3210", ...headers },
  }));
}

describe("local request boundary", () => {
  it("accepts an explicit local Origin", () => {
    const response = post({ origin: "http://127.0.0.1:3210" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("accepts a browser same-origin form navigation when Origin is omitted", () => {
    const response = post({ "sec-fetch-site": "same-origin" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("accepts Chromium's opaque Origin for a verified same-origin form navigation", () => {
    const response = post({ origin: "null", "sec-fetch-site": "same-origin" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each([
    [{ origin: "https://example.com" }],
    [{ origin: "null", "sec-fetch-site": "cross-site" }],
    [{ origin: "null" }],
    [{ "sec-fetch-site": "cross-site" }],
    [{}],
  ])("rejects a non-local or unverifiable mutation", (headers) => {
    const response = post(headers);
    expect(response.status).toBe(403);
    expect(response.headers.get("x-middleware-next")).toBeNull();
  });

  it("rejects a forged Host before evaluating origin metadata", () => {
    const response = proxy(new NextRequest(LOCAL_URL, {
      method: "POST",
      headers: {
        host: "localhost:3210",
        origin: "http://127.0.0.1:3210",
      },
    }));
    expect(response.status).toBe(403);
  });
});
