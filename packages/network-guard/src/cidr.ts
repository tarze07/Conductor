import { isIP } from "node:net";

export const DEFAULT_INTRANET_CIDRS: readonly string[] = [
  // IPv4 Loopback (RFC 1122)
  "127.0.0.0/8",
  // IPv4 Private Networks (RFC 1918)
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  // IPv4 Link-Local (RFC 3927)
  "169.254.0.0/16",
  // IPv6 Loopback
  "::1/128",
  // IPv6 Unique Local Addresses (RFC 4193)
  "fc00::/7",
  // IPv6 Link-Local
  "fe80::/10"
];

export const TAILNET_CGNAT_CIDR = "100.64.0.0/10";

export interface ParsedCidr {
  readonly raw: string;
  readonly version: 4 | 6;
  readonly networkBigInt: bigint;
  readonly maskBigInt: bigint;
  readonly prefixLength: number;
}

/**
 * Unwraps IPv4-mapped IPv6 addresses such as `::ffff:10.0.0.1` or `::ffff:7f00:0001`
 * into their canonical IPv4 dotted-quad representation so IPv4 CIDR policies apply uniformly.
 */
export function normalizeIpAddress(ip: string): string {
  const trimmed = ip.trim().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const rest = lower.slice("::ffff:".length);
    if (isIP(rest) === 4) {
      return rest;
    }
    const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hexMatch) {
      const high = Number.parseInt(hexMatch[1]!, 16);
      const low = Number.parseInt(hexMatch[2]!, 16);
      return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    }
  }
  return trimmed;
}

export function ipv4ToBigInt(ip: string): bigint {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  let result = 0n;
  for (const part of parts) {
    const octet = Number.parseInt(part, 10);
    if (Number.isNaN(octet) || octet < 0 || octet > 255 || String(octet) !== part) {
      throw new Error(`Invalid IPv4 octet in address: ${ip}`);
    }
    result = (result << 8n) | BigInt(octet);
  }
  return result;
}

export function ipv6ToBigInt(ip: string): bigint {
  const normalized = ip.split("%")[0] ?? ip;
  const doubleColonParts = normalized.split("::");
  if (doubleColonParts.length > 2) {
    throw new Error(`Invalid IPv6 address: ${ip}`);
  }

  const expandGroup = (segment: string): number[] => {
    if (!segment) {
      return [];
    }
    const tokens = segment.split(":");
    const groups: number[] = [];
    for (const token of tokens) {
      if (token.includes(".")) {
        const v4 = ipv4ToBigInt(token);
        groups.push(Number((v4 >> 16n) & 0xffffn));
        groups.push(Number(v4 & 0xffffn));
      } else {
        const val = Number.parseInt(token, 16);
        if (Number.isNaN(val) || val < 0 || val > 0xffff) {
          throw new Error(`Invalid IPv6 group in address: ${ip}`);
        }
        groups.push(val);
      }
    }
    return groups;
  };

  let groups: number[];
  if (doubleColonParts.length === 2) {
    const left = expandGroup(doubleColonParts[0]!);
    const right = expandGroup(doubleColonParts[1]!);
    const missing = 8 - (left.length + right.length);
    if (missing < 1) {
      throw new Error(`Invalid IPv6 compression in address: ${ip}`);
    }
    groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  } else {
    groups = expandGroup(normalized);
  }

  if (groups.length !== 8) {
    throw new Error(`Invalid IPv6 group count in address: ${ip}`);
  }

  let result = 0n;
  for (const group of groups) {
    result = (result << 16n) | BigInt(group);
  }
  return result;
}

export function parseCidr(cidr: string): ParsedCidr {
  const [rawAddress, rawPrefix] = cidr.trim().split("/");
  if (!rawAddress) {
    throw new Error(`Invalid CIDR notation: ${cidr}`);
  }
  const normalizedAddress = normalizeIpAddress(rawAddress);
  const version = isIP(normalizedAddress);
  if (version !== 4 && version !== 6) {
    throw new Error(`Invalid IP address in CIDR: ${cidr}`);
  }

  const maxBits = version === 4 ? 32 : 128;
  const prefixLength = rawPrefix !== undefined ? Number.parseInt(rawPrefix, 10) : maxBits;
  if (Number.isNaN(prefixLength) || prefixLength < 0 || prefixLength > maxBits) {
    throw new Error(`Invalid prefix length in CIDR: ${cidr}`);
  }

  const totalBits = BigInt(maxBits);
  const hostBits = totalBits - BigInt(prefixLength);
  const allOnes = (1n << totalBits) - 1n;
  const maskBigInt = prefixLength === 0 ? 0n : (allOnes >> hostBits) << hostBits;
  const addressBigInt =
    version === 4 ? ipv4ToBigInt(normalizedAddress) : ipv6ToBigInt(normalizedAddress);

  return {
    raw: cidr,
    version,
    networkBigInt: addressBigInt & maskBigInt,
    maskBigInt,
    prefixLength
  };
}

export function isIpInCidrs(ip: string, cidrs: readonly (string | ParsedCidr)[]): boolean {
  const normalized = normalizeIpAddress(ip);
  const version = isIP(normalized);
  if (version !== 4 && version !== 6) {
    return false;
  }

  const ipValue = version === 4 ? ipv4ToBigInt(normalized) : ipv6ToBigInt(normalized);
  for (const entry of cidrs) {
    const parsed = typeof entry === "string" ? parseCidr(entry) : entry;
    if (parsed.version !== version) {
      continue;
    }
    if ((ipValue & parsed.maskBigInt) === parsed.networkBigInt) {
      return true;
    }
  }
  return false;
}
