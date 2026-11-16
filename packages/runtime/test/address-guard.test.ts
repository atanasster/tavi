import { expect, it } from "vitest";
import { classifyAddresses, classifyIpAddress, classifyIpv4, classifyIpv6, isIpLiteralHost } from "@tavi/runtime";

/**
 * The address half of the public-fetch guard.
 *
 * These are the classes `open_web` must never reach. Every case is a literal, so
 * the table is the guard: deleting a branch fails the row that names it.
 */
it.each([
  ["0.0.0.0", "unspecified"],
  ["0.1.2.3", "unspecified"],
  ["10.0.0.1", "private"],
  ["10.255.255.255", "private"],
  ["100.64.0.1", "carrier-grade-nat"],
  ["100.127.255.255", "carrier-grade-nat"],
  ["127.0.0.1", "loopback"],
  ["127.255.255.254", "loopback"],
  ["169.254.169.254", "link-local"],
  ["169.254.0.1", "link-local"],
  ["172.16.0.1", "private"],
  ["172.31.255.255", "private"],
  ["192.0.0.1", "reserved"],
  ["192.0.2.5", "documentation"],
  ["192.88.99.1", "reserved"],
  ["192.168.1.1", "private"],
  ["198.18.0.1", "benchmark"],
  ["198.19.255.255", "benchmark"],
  ["198.51.100.7", "documentation"],
  ["203.0.113.9", "documentation"],
  ["224.0.0.1", "multicast"],
  ["239.255.255.255", "multicast"],
  ["240.0.0.1", "reserved"],
  ["255.255.255.255", "reserved"],
])("refuses the IPv4 address %s as %s", (address, refusal) => {
  expect(classifyIpv4(address)).toBe(refusal);
});

it.each(["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "223.255.255.255"])(
  "allows the public IPv4 address %s",
  (address) => {
    expect(classifyIpv4(address)).toBeUndefined();
  },
);

it.each([
  ["::", "unspecified"],
  ["::1", "loopback"],
  ["fe80::1", "link-local"],
  ["febf::1", "link-local"],
  ["fc00::1", "private"],
  ["fdff::1", "private"],
  ["ff02::1", "multicast"],
  ["2001:db8::1", "documentation"],
  ["64:ff9b::7f00:1", "loopback"],
  ["64:ff9b::a00:1", "private"],
  ["2002:7f00:0001::1", "loopback"],
  ["2002:0a00:0001::1", "private"],
  ["::ffff:127.0.0.1", "loopback"],
  ["::10.0.0.1", "private"],
  ["::a00:1", "private"],
  ["::7f00:1", "loopback"],
  ["::ffff:0:10.0.0.1", "private"],
  ["::ffff:0:169.254.169.254", "link-local"],
  ["2001:2::1", "benchmark"],
  ["2001::1", "reserved"],
  ["2001:10::1", "reserved"],
  ["2001:20::1", "reserved"],
  ["100::1", "reserved"],
  ["::2:0:0:0", "reserved"],
  ["3fff::1", "documentation"],
  ["::ffff:10.0.0.1", "private"],
  ["::ffff:169.254.169.254", "link-local"],
  ["::ffff:7f00:1", "loopback"],
])("refuses the IPv6 address %s as %s", (address, refusal) => {
  expect(classifyIpv6(address)).toBe(refusal);
});

it.each([
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
  "::ffff:1.1.1.1",
  "::1.2.3.4",
  "::8000:1",
  "::ffff:0:1.2.3.4",
  "64:ff9b::5db8:d822",
  "2002:5db8:d822::1",
])("allows the public IPv6 address %s", (address) => {
  expect(classifyIpv6(address)).toBeUndefined();
});

it("classifies through a bracketed literal and refuses a non-address", () => {
  expect(classifyIpAddress("[::1]")).toBe("loopback");
  expect(classifyIpAddress("127.0.0.1")).toBe("loopback");
  expect(classifyIpAddress("2001:db8::1")).toBe("documentation");
  expect(classifyIpAddress("not-an-ip")).toBe("not-an-address");
  expect(classifyIpAddress("1.2.3")).toBe("not-an-address");
  expect(classifyIpAddress("1.2.3.256")).toBe("not-an-address");
  expect(isIpLiteralHost("[::1]")).toBe(true);
  expect(isIpLiteralHost("[fe80::1%25eth0]")).toBe(true);
  expect(isIpLiteralHost("example.com")).toBe(false);
});

it("refuses an empty answer and a mixed public/non-public answer", () => {
  expect(classifyAddresses([])).toMatchObject({ allowed: false, refusal: "no-addresses" });
  // Refused rather than filtered: choosing the public half would leave the other
  // half available to a retry, which is the rebinding hole this guard closes.
  expect(classifyAddresses(["93.184.216.34", "127.0.0.1"])).toMatchObject({ allowed: false, refusal: "loopback", address: "127.0.0.1" });
  expect(classifyAddresses(["10.0.0.1", "93.184.216.34"])).toMatchObject({ allowed: false, refusal: "private", address: "10.0.0.1" });
  expect(classifyAddresses(["93.184.216.34", "2606:4700:4700::1111"])).toEqual({
    allowed: true,
    addresses: ["93.184.216.34", "2606:4700:4700::1111"],
  });
});
