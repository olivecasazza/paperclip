import type { Request, RequestHandler } from "express";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/**
 * Resolve the host used for the allow/deny decision without letting a direct
 * client promote its own X-Forwarded-Host value into the guard. Express
 * compiles the operator's TRUST_PROXY setting into `trust proxy fn`; only a
 * trusted immediate peer may supply the forwarded host. Without this check any
 * unauthenticated client that can reach the server directly sends
 * `X-Forwarded-Host: localhost` and bypasses the guard entirely.
 */
function forwardedHostFromTrustedProxy(req: Request): string | undefined {
  const remoteAddress = req.socket?.remoteAddress;
  const trustProxy = req.app?.get("trust proxy fn") as
    | ((address: string, hop: number) => boolean)
    | undefined;

  if (
    remoteAddress
    && typeof trustProxy === "function"
    && trustProxy(remoteAddress, 0)
  ) {
    return req.header("x-forwarded-host")?.split(",")[0]?.trim();
  }

  return undefined;
}

function extractHostname(req: Request): string | null {
  const forwardedHost = forwardedHostFromTrustedProxy(req);
  const hostHeader = req.header("host")?.trim();
  const raw = forwardedHost || hostHeader;
  if (!raw) return null;

  try {
    return new URL(`http://${raw}`).hostname.trim().toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

function normalizeAllowedHostnames(values: string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) continue;
    unique.add(trimmed);
  }
  return Array.from(unique);
}

export function resolvePrivateHostnameAllowSet(opts: { allowedHostnames: string[]; bindHost: string }): Set<string> {
  const configuredAllow = normalizeAllowedHostnames(opts.allowedHostnames);
  const bindHost = opts.bindHost.trim().toLowerCase();
  const allowSet = new Set<string>(configuredAllow);

  if (bindHost && bindHost !== "0.0.0.0") {
    allowSet.add(bindHost);
  }
  allowSet.add("localhost");
  allowSet.add("127.0.0.1");
  allowSet.add("::1");
  return allowSet;
}

// The hostname comes from the request Host header, so an unauthenticated
// requester controls it. Never put that value into the guidance command. An
// operator or an agent can paste the guidance into a shell, and that outer
// shell evaluates a backtick, `$( )`, or `$NAME` span in the host before any
// CLI receives argv. A direct-exec form such as `npx` does not stop the
// outer shell. Emit a static `<host>` placeholder and do not echo the raw request
// value. The operator supplies the real hostname.
const BLOCKED_HOSTNAME_MESSAGE =
  "This hostname is not allowed for this Paperclip instance. " +
  "If you want to allow a hostname, run npx paperclipai allowed-hostname <host>.";

export function privateHostnameGuard(opts: {
  enabled: boolean;
  allowedHostnames: string[];
  bindHost: string;
}): RequestHandler {
  if (!opts.enabled) {
    return (_req, _res, next) => next();
  }

  const allowSet = resolvePrivateHostnameAllowSet({
    allowedHostnames: opts.allowedHostnames,
    bindHost: opts.bindHost,
  });

  return (req, res, next) => {
    const hostname = extractHostname(req);
    const wantsJson = req.path.startsWith("/api") || req.accepts(["json", "html", "text"]) === "json";

    if (!hostname) {
      const error = "Missing Host header. If you want to allow a hostname, run npx paperclipai allowed-hostname <host>.";
      if (wantsJson) {
        res.status(403).json({ error });
      } else {
        res.status(403).type("text/plain").send(error);
      }
      return;
    }

    if (isLoopbackHostname(hostname) || allowSet.has(hostname)) {
      next();
      return;
    }

    const error = BLOCKED_HOSTNAME_MESSAGE;
    if (wantsJson) {
      res.status(403).json({ error });
    } else {
      res.status(403).type("text/plain").send(error);
    }
  };
}
