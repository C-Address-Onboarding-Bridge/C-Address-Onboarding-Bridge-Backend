import net from 'node:net';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';

/**
 * Shared SSRF protection primitives for outbound webhook delivery.
 *
 * Both the API delivery path (WebhookDeliveryService.attemptDelivery) and the
 * BullMQ retry worker (processWebhookRetry) use these helpers so the same
 * "resolve once, reject blocked ranges, connect through a pinned lookup"
 * guarantee applies everywhere a signed POST body is sent to a user-supplied
 * URL.
 *
 * Issue #1058 fixed the TOCTOU in the delivery path; issue #1059 extends the
 * same protection to the retry worker (which runs in a separate process and
 * therefore cannot reuse any state from the API process).
 */

/** Thrown when a webhook URL's DNS answer contains a non-public (blocked) IP. */
export class BlockedAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedAddressError';
  }
}

function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.parse(address).range() === 'unicast';
  } catch {
    return false;
  }
}

function ipv6ToBigInt(address: string): bigint {
  let normalized = address.toLowerCase();
  const ipv4Tail = normalized.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Tail) {
    const octets = ipv4Tail[1].split('.').map(Number);
    const first = ((octets[0] << 8) | octets[1]).toString(16);
    const second = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, ipv4Tail.index)}${first}:${second}`;
  }

  const [leftPart, rightPart = ''] = normalized.split('::');
  const left = leftPart ? leftPart.split(':') : [];
  const right = rightPart ? rightPart.split(':') : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group || '0'}`), 0n);
}

function ipv4FromBigInt(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join('.');
}

/**
 * Returns true when the given IP literal falls in a private, loopback,
 * link-local, or cloud-metadata range that must never be reachable via a
 * user-supplied webhook URL (SSRF protection).
 */
export function isBlockedIp(ip: string): boolean {
  let addr = ip.trim();
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);

  const version = net.isIP(addr);
  if (version === 4) {
    const parts = addr.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  if (version === 6) {
    const value = ipv6ToBigInt(addr);
    const prefix96 = value >> 32n;
    const embeddedIpv4 = value & 0xffffffffn;
    if (prefix96 === 0n || prefix96 === 0xffffn || prefix96 === 0x64ff9b0000000000000000n) {
      return isBlockedIp(ipv4FromBigInt(embeddedIpv4));
    }
    if (value >> 112n === 0x2002n) {
      return isBlockedIp(ipv4FromBigInt((value >> 80n) & 0xffffffffn));
    }

    const lower = addr.toLowerCase();
    if (lower === '::' || lower === '::1') return true; // unspecified / loopback
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return true; // fe80::/10 link-local
    }
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique local
    if (lower.startsWith('ff')) return true; // ff00::/8 multicast
    return false;
  }

  // Not a valid IP literal - treat as unsafe.
  return true;
}

/**
 * Resolves the hostname of a webhook URL exactly ONCE and returns a vetted
 * address. This is the primary SSRF defence: the result is pinned into an
 * undici Agent lookup by safeWebhookFetch() so the resolver is never consulted
 * a second time (defeating DNS rebinding).
 *
 * `verbatim: true` preserves resolver order so the same address is always
 * chosen for pinning across calls.
 *
 * @throws BlockedAddressError when the hostname resolves to any non-public IP.
 */
export async function resolveSafeWebhookAddress(url: string): Promise<{
  hostname: string;
  address: string;
  family: number;
}> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('Invalid webhook URL');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error('Webhook URL must use HTTP(S) without credentials');
  }

  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new BlockedAddressError('Webhook URL resolves to a non-public address');
  }

  return { hostname, ...addresses[0] };
}

/**
 * Registration-time validation. Requires https and rejects literal IPs or
 * hostnames whose DNS answer contains any blocked address.
 *
 * Unlike the delivery path this only validates; the delivery path additionally
 * pins the resolved address into the connection so the resolver cannot flip
 * between check and connect.
 */
export async function assertSafeWebhookUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid webhook URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Webhook URL must use https');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new BlockedAddressError('Webhook URL resolves to a blocked address');
    }
    return;
  }

  let addresses: string[];
  try {
    const records = await lookup(hostname, { all: true });
    addresses = records.map((r) => r.address);
  } catch {
    throw new Error('Webhook URL host could not be resolved');
  }

  if (addresses.length === 0 || addresses.some((a) => isBlockedIp(a))) {
    throw new BlockedAddressError('Webhook URL resolves to a blocked address');
  }
}

/**
 * Build the connect.lookup that undici invokes when opening the TCP socket.
 * It returns ONLY the address that resolveSafeWebhookAddress vetted and
 * refuses any other hostname/address combination with EACCES.
 */
function createPinnedLookup(vetted: { hostname: string; address: string; family: number }) {
  return (
    requestedHostname: string,
    options: { all?: boolean } | number,
    callback: (
      _error: NodeJS.ErrnoException | null,
      _address: string | { address: string; family: number }[],
      _family?: number,
    ) => void,
  ) => {
    if (requestedHostname !== vetted.hostname || !isPublicAddress(vetted.address)) {
      const error = new Error('Webhook connection did not match its vetted destination') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      callback(error, '');
      return;
    }

    if (typeof options === 'object' && options.all) {
      callback(null, [{ address: vetted.address, family: vetted.family }]);
    } else {
      callback(null, vetted.address, vetted.family);
    }
  };
}

/**
 * SSRF-safe variant of fetch() for outbound webhook deliveries.
 *
 * Guarantees:
 * 1. The target hostname is resolved exactly once. If any answer is in a
 *    blocked range, resolveSafeWebhookAddress throws BlockedAddressError and
 *    fetch() is never called.
 * 2. The connection is pinned to the vetted address via an undici Agent, so
 *    a rebinding DNS answer between check and connect cannot be chosen.
 * 3. `redirect: 'error'` - a 3xx response is a delivery failure, not a
 *    follow-up request to an arbitrary (possibly internal) target.
 * 4. The dispatcher is destroyed in a finally block so its socket pool does
 *    not leak between deliveries.
 *
 * Callers cannot override `redirect` or `dispatcher` - passing either through
 * `init` is rejected at the type level.
 */
export async function safeWebhookFetch(
  url: string,
  init: Omit<RequestInit, 'redirect' | 'dispatcher'>,
): Promise<Response> {
  // Resolve BEFORE constructing the Agent so we never open sockets when the
  // answer is blocked. BlockedAddressError propagates to the caller.
  const vetted = await resolveSafeWebhookAddress(url);

  const dispatcher = new Agent({ connect: { lookup: createPinnedLookup(vetted) } });
  try {
    return await fetch(url, {
      ...init,
      redirect: 'error',
      dispatcher,
    } as RequestInit & { dispatcher: Agent });
  } finally {
    try {
      await dispatcher.destroy();
    } catch {
      // Best-effort cleanup; a stuck socket pool must not mask the delivery
      // outcome.
    }
  }
}
