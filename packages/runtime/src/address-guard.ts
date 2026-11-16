import { isIP } from "node:net";

/**
 * Address-level egress guard for a public fetch.
 *
 * A host allowlist is a *name* allowlist, and a name is not a guarantee: a name
 * the operator trusts can resolve to `127.0.0.1`, to the host's metadata service,
 * or to a private address the fetch has no business reaching. Worse, the answer
 * can differ between the check and the connection (DNS rebinding), so validating
 * a name and then letting the transport resolve it again is not a guard at all.
 *
 * The rule this module encodes is therefore about *addresses*, and the transport
 * is expected to connect to the very address that was validated: resolve once,
 * classify every answer, refuse a mixed or non-public answer, then pin the
 * socket to it while TLS still verifies the hostname.
 */

/** Why an address may not be dialed, or `undefined` when it is public. */
export type AddressRefusal =
  | "not-an-address"
  | "unspecified"
  | "loopback"
  | "private"
  | "link-local"
  | "carrier-grade-nat"
  | "multicast"
  | "reserved"
  | "documentation"
  | "benchmark"
  | "shared-address-space"
  | "no-addresses";

const refusalText: Readonly<Record<AddressRefusal, string>> = {
  "not-an-address": "the resolver returned something that is not an IP address",
  unspecified: "the unspecified address",
  loopback: "a loopback address",
  private: "a private address",
  "link-local": "a link-local address (including the cloud metadata service at 169.254.169.254)",
  "carrier-grade-nat": "a carrier-grade NAT address",
  multicast: "a multicast address",
  reserved: "a reserved address",
  documentation: "a documentation address",
  benchmark: "a benchmarking address",
  "shared-address-space": "a shared address space",
  "no-addresses": "no addresses at all",
};

export function describeAddressRefusal(refusal: AddressRefusal): string {
  return refusalText[refusal];
}

/** The IPv4 bytes of a dotted quad, or `undefined` when it is not one. */
function ipv4Bytes(address: string): readonly number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    bytes.push(value);
  }
  return bytes;
}

/** Classify one IPv4 address. `undefined` means "public and dialable". */
export function classifyIpv4(address: string): AddressRefusal | undefined {
  const bytes = ipv4Bytes(address);
  if (bytes === undefined) return "not-an-address";
  const [a = 0, b = 0, c = 0] = bytes;
  if (a === 0) return "unspecified";
  if (a === 10) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade-nat";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 0 && c === 0) return "reserved";
  if (a === 192 && b === 0 && c === 2) return "documentation";
  // 192.88.99.0/24, the deprecated 6to4 relay anycast prefix (IANA IPv4
  // Special-Purpose Address Registry): not globally reachable.
  if (a === 192 && b === 88 && c === 99) return "reserved";
  if (a === 192 && b === 168) return "private";
  if (a === 198 && (b === 18 || b === 19)) return "benchmark";
  if (a === 198 && b === 51 && c === 100) return "documentation";
  if (a === 203 && b === 0 && c === 113) return "documentation";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  return undefined;
}

/** Expand an IPv6 address into its eight 16-bit groups, or `undefined`. */
function ipv6Groups(address: string): readonly number[] | undefined {
  const withoutZone = address.includes("%") ? address.slice(0, address.indexOf("%")) : address;
  // A trailing dotted quad (`::ffff:127.0.0.1`) is the same address as its two
  // hex groups, and it is the spelling a resolver is most likely to return.
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(withoutZone);
  if (dotted !== null) {
    const bytes = ipv4Bytes(dotted[2]!);
    if (bytes === undefined) return undefined;
    return ipv6Groups(
      `${dotted[1]}${(((bytes[0]! << 8) | bytes[1]!) >>> 0).toString(16)}:${(((bytes[2]! << 8) | bytes[3]!) >>> 0).toString(16)}`,
    );
  }
  const halves = withoutZone.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (head === undefined || tail === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return undefined;
  return [...head, ...Array.from({ length: fill }, () => 0), ...tail];
}

/** The last 32 bits of an IPv6 address as a dotted quad. */
function tailIpv4(groups: readonly number[]): string {
  const g6 = groups[6] ?? 0;
  const g7 = groups[7] ?? 0;
  return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
}

/**
 * The IPv4 address an IPv6 address embeds, in any of the three forms
 * RFC 4291/2765 define, or `undefined` when it embeds none.
 *
 * All three carry a real IPv4 destination the network will dial, so all three
 * must be classified as that IPv4: an IPv4-*mapped* address is the obvious case,
 * but `::a.b.c.d` (IPv4-compatible) and `::ffff:0:a.b.c.d` (IPv4-translated) are
 * the same bypass written differently. Checking only the mapped prefix left
 * `::ffff:0:10.0.0.1` reading as public.
 */
function embeddedIpv4(groups: readonly number[]): string | undefined {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = groups;
  // IPv4-compatible `::a.b.c.d` and IPv4-mapped `::ffff:a.b.c.d`.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) return tailIpv4(groups);
  // IPv4-translated `::ffff:0:a.b.c.d`.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return tailIpv4(groups);
  return undefined;
}

/** Classify one IPv6 address, recursing into an embedded IPv4. `undefined` means public. */
export function classifyIpv6(address: string): AddressRefusal | undefined {
  const groups = ipv6Groups(address);
  if (groups === undefined) return "not-an-address";
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0] = groups;
  if (groups.every((group) => group === 0)) return "unspecified";
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return "loopback";
  const embedded = embeddedIpv4(groups);
  if (embedded !== undefined) return classifyIpv4(embedded);
  // 64:ff9b::/96 (NAT64) and 2002::/16 (6to4) carry an IPv4 address that will be
  // dialed on the caller's behalf, so the embedded half decides. A *public*
  // embedded address is therefore dialable — the prefix adds no destination of its
  // own, and refusing it made `web_fetch` unusable on an IPv6-only/DNS64 network,
  // which resolves every public host to exactly this form.
  if (g0 === 0x64 && g1 === 0xff9b) {
    const embedded = `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
    return classifyIpv4(embedded);
  }
  if (g0 === 0x2002) {
    const embedded = `${groups[1]! >> 8}.${groups[1]! & 0xff}.${groups[2]! >> 8}.${groups[2]! & 0xff}`;
    return classifyIpv4(embedded);
  }
  // 100::/64, the discard-only prefix (IANA IPv6 Special-Purpose Address
  // Registry): not globally reachable.
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return "reserved";
  if ((g0 & 0xfe00) === 0xfc00) return "private";
  if ((g0 & 0xffc0) === 0xfe80) return "link-local";
  if ((g0 & 0xff00) === 0xff00) return "multicast";
  if (g0 === 0x2001 && g1 === 0x0db8) return "documentation";
  // RFC 9637 documentation prefix and RFC 5180 benchmarking prefix: both are
  // non-routable by policy, so neither belongs to a public fetch.
  if ((g0 & 0xfff0) === 0x3ff0) return "documentation";
  if (g0 === 0x2001 && g1 === 0x0002) return "benchmark";
  if (g0 === 0x2001 && g1 === 0x0000) return "reserved";
  // 2001:10::/28 (the deprecated ORCHID, RFC 4843) and 2001:20::/28 (ORCHIDv2,
  // RFC 7343): the low four bits of the second group are free.
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x0010) return "reserved";
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x0020) return "reserved";
  // The rest of 0000::/8 is "Reserved by IETF" (IANA IPv6 Special-Purpose Address
  // Registry) once the specified sub-blocks above have been carved out. This has
  // to stay behind the embedded-IPv4 and NAT64 branches, which live inside it.
  if ((g0 & 0xff00) === 0) return "reserved";
  return undefined;
}

/**
 * Every spelling a dial to `address` reaches, canonical: an IPv4 literal as
 * itself; an IPv6 one as its eight lowercase hex groups, plus the IPv4 it
 * embeds (mapped, compatible, translated, NAT64 or 6to4). A denylist of
 * addresses (the cloud metadata services) checks every one, so
 * `::ffff:169.254.169.254` and `fd00:ec2:0::254` are caught.
 */
export function addressTargets(address: string): readonly string[] {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  if (isIP(bare) === 4) return [bare];
  const groups = ipv6Groups(bare);
  if (groups === undefined) return [bare.toLowerCase()];
  const targets = [groups.map((group) => group.toString(16)).join(":")];
  const embedded = embeddedIpv4(groups);
  if (embedded !== undefined) targets.push(embedded);
  if (groups[0] === 0x64 && groups[1] === 0xff9b) targets.push(tailIpv4(groups));
  if (groups[0] === 0x2002)
    targets.push(`${(groups[1] ?? 0) >> 8}.${(groups[1] ?? 0) & 0xff}.${(groups[2] ?? 0) >> 8}.${(groups[2] ?? 0) & 0xff}`);
  return targets;
}

/** Classify any IP literal. `undefined` means public and dialable. */
export function classifyIpAddress(address: string): AddressRefusal | undefined {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const version = isIP(bare);
  if (version === 4) return classifyIpv4(bare);
  if (version === 6) return classifyIpv6(bare);
  return "not-an-address";
}

export type AddressResolution =
  | { readonly allowed: true; readonly addresses: readonly [string, ...string[]] }
  | { readonly allowed: false; readonly refusal: AddressRefusal; readonly address: string };

/**
 * Whether an answer is usable: at least one address, every address public.
 *
 * A *mixed* answer is refused rather than filtered. Picking the public half would
 * leave the transport free to choose the other one on a retry, which is the
 * rebinding hole this guard exists to close — and an operator whose host really
 * does answer with a private address has a misconfigured name, not a fetch the
 * guard should silently repair.
 */
export function classifyAddresses(addresses: readonly string[]): AddressResolution {
  const [first, ...rest] = addresses;
  if (first === undefined) return { allowed: false, refusal: "no-addresses", address: "" };
  for (const address of addresses) {
    const refusal = classifyIpAddress(address);
    if (refusal !== undefined) return { allowed: false, refusal, address };
  }
  return { allowed: true, addresses: [first, ...rest] };
}

/**
 * Whether a URL names an address directly, which a public fetch refuses outright.
 *
 * A bracketed IPv6 literal may carry a zone (`[fe80::1%25eth0]`), which `isIP`
 * does not accept; the zone is stripped first so the literal is still recognized
 * rather than falling through as an ordinary name.
 */
export function isIpLiteralHost(hostname: string): boolean {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isIP(bare.includes("%") ? bare.slice(0, bare.indexOf("%")) : bare) !== 0;
}
