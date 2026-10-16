import { describe, expect, it } from "vitest";
import {
  assertPublicRemoteHttpEndpoint,
  parseRemoteHttpEndpoint,
} from "../services/remote-http-endpoint-guard.js";

function guardError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

describe("remote HTTP endpoint guard", () => {
  it("blocks hostnames that resolve to private network addresses", async () => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://metadata.example/mcp"),
      { lookup: async () => [{ address: "10.0.0.12", family: 4 }] },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it("allows hostnames when every resolved address is public", async () => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://public.example/mcp"),
      { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
      guardError,
    )).resolves.toBeUndefined();
  });

  it.each([
    "169.254.0.1",
    "169.254.169.254",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "fe80::1",
    "febf::1",
  ])("always rejects link-local literal %s when private networking is allowed", async (address) => {
    const url = address.includes(":") ? `http://[${address}]/mcp` : `http://${address}/mcp`;
    await expect(assertPublicRemoteHttpEndpoint(
      new URL(url),
      { allowPrivateNetwork: true },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it.each(["169.254.42.1", "fe80::1234"])(
    "always rejects link-local DNS answer %s when private networking is allowed",
    async (address) => {
      await expect(assertPublicRemoteHttpEndpoint(
        new URL("https://operator-endpoint.example/mcp"),
        { allowPrivateNetwork: true, lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }] },
        guardError,
      )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
    },
  );

  it.each(["127.0.0.1", "10.1.2.3", "fd00::1"])(
    "allows intended private address %s when private networking is allowed",
    async (address) => {
      const url = address.includes(":") ? `http://[${address}]/mcp` : `http://${address}/mcp`;
      await expect(assertPublicRemoteHttpEndpoint(
        new URL(url),
        { allowPrivateNetwork: true },
        guardError,
      )).resolves.toBeUndefined();
    },
  );

  it.each([
    "http://[2001::1]/mcp",
    "http://[2001:20::1]/mcp",
    "http://[2001:2f::1]/mcp",
    "http://[64:ff9b:1::1]/mcp",
  ])("rejects reserved IPv6 endpoint %s", async (url) => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL(url),
      {},
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it.each([
    "http://mcp.example/mcp",
    "https://mcp.example/mcp",
    "https://mcp.example/mcp?tenant=acme#frag",
    "https://user:pass@mcp.example:8443/mcp",
  ])("parses allowed endpoint %s", (value) => {
    const parsed = parseRemoteHttpEndpoint(value, guardError);
    expect(parsed).toBeInstanceOf(URL);
    expect(parsed.protocol).toMatch(/^https?:$/);
    expect(parsed.toString()).toBe(new URL(value).toString());
  });

  it("normalizes an uppercase scheme to the lowercase allowlist form", () => {
    const parsed = parseRemoteHttpEndpoint("HTTPS://MCP.EXAMPLE/mcp", guardError);
    expect(parsed.protocol).toBe("https:");
    expect(parsed.hostname).toBe("mcp.example");
  });

  it.each([
    "file:///etc/passwd",
    "gopher://mcp.example/mcp",
    "data:text/plain,leak",
    "ftp://mcp.example/mcp",
    "ws://mcp.example/mcp",
    "wss://mcp.example/mcp",
    "javascript:alert(1)",
    "chrome-extension://abc/def",
  ])("rejects non-http(s) scheme %s as invalid", (value) => {
    // Schemes that `new URL()` accepts must be refused by the allowlist, not
    // reach the socket layer.
    expect(() => new URL(value)).not.toThrow();
    expect(() => parseRemoteHttpEndpoint(value, guardError))
      .toThrowError(expect.objectContaining({ code: "mcp_remote_url_invalid" }));
  });

  it.each([
    ["not a url", "unparseable text"],
    ["//mcp.example/mcp", "scheme-relative"],
    ["http://", "scheme with no host"],
    ["http://mcp.example:notaport/mcp", "invalid port"],
  ])("rejects %s as an invalid URL (%s)", (value) => {
    expect(() => parseRemoteHttpEndpoint(value, guardError))
      .toThrowError(expect.objectContaining({ code: "mcp_remote_url_invalid" }));
  });

  it.each([
    ["", "empty string"],
    ["   ", "whitespace only"],
  ])("rejects a missing URL (%s) before parsing", (value) => {
    expect(() => parseRemoteHttpEndpoint(value, guardError))
      .toThrowError(expect.objectContaining({ code: "mcp_remote_url_missing" }));
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["number", 42],
    ["object", { url: "https://mcp.example/mcp" }],
  ])("rejects a non-string %s value as a missing URL", (_label, value) => {
    expect(() => parseRemoteHttpEndpoint(value, guardError))
      .toThrowError(expect.objectContaining({ code: "mcp_remote_url_missing" }));
  });

  it("routes the error through the injected factory rather than throwing bare", () => {
    // Call sites map these codes onto 422s (tool-gateway/tool-access), so the
    // guard must surface the caller-supplied error, not its own.
    expect(() => parseRemoteHttpEndpoint("file:///etc/passwd", guardError))
      .toThrowError(/must use http or https/);
    expect(() => parseRemoteHttpEndpoint("", guardError))
      .toThrowError(/requires config\.url/);
    expect(() => parseRemoteHttpEndpoint("nope", guardError))
      .toThrowError(/URL is invalid/);
  });

  it("fails closed when the hostname resolves to no addresses at all", async () => {
    // An empty answer must not be treated as "no private addresses found".
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://empty-dns.example/mcp"),
      { lookup: async () => [] },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_dns_failed" });
  });

  it("fails closed when the resolver itself throws", async () => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://broken-dns.example/mcp"),
      { lookup: async () => { throw new Error("ECONNREFUSED"); } },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_dns_failed" });
  });
});
