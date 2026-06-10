import { describe, expect, it } from "vitest";

import { assertAllowedXurlArgs, redactArgv } from "../src/xurl.js";

describe("xurl wrapper", () => {
  it("allows the M1 setup and status operations", () => {
    expect(() => assertAllowedXurlArgs(["--help"])).not.toThrow();
    expect(() => assertAllowedXurlArgs(["auth", "status"])).not.toThrow();
    expect(() => assertAllowedXurlArgs(["auth", "apps", "add", "x-hermes"])).not.toThrow();
    expect(() => assertAllowedXurlArgs(["auth", "oauth2", "--app", "x-hermes", "user"])).not.toThrow();
    expect(() => assertAllowedXurlArgs(["auth", "default", "x-hermes", "user"])).not.toThrow();
    expect(() => assertAllowedXurlArgs(["whoami"])).not.toThrow();
  });

  it("allows only explicit X API operations", () => {
    expect(() => assertAllowedXurlArgs(["search", "hello", "-n", "3"])).not.toThrow();
    expect(() => assertAllowedXurlArgs(["read", "123"])).not.toThrow();
    expect(() => assertAllowedXurlArgs(["reply", "123", "text"])).not.toThrow();
    expect(() => assertAllowedXurlArgs(["/2/tweets/search/recent?query=hello"])).not.toThrow();
    expect(() => assertAllowedXurlArgs(["auth", "apps", "delete", "x-hermes"])).toThrow(
      /Refusing/
    );
    expect(() => assertAllowedXurlArgs(["anything"])).toThrow(/Refusing/);
  });

  it("redacts xurl app credentials in command display", () => {
    expect(
      redactArgv([
        "auth",
        "apps",
        "add",
        "x-hermes",
        "--client-id",
        "abc",
        "--client-secret",
        "secret"
      ])
    ).toEqual([
      "auth",
      "apps",
      "add",
      "x-hermes",
      "--client-id",
      "[redacted]",
      "--client-secret",
      "[redacted]"
    ]);
  });
});

