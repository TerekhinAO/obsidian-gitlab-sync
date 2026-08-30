import { describe, expect, it } from "vitest";
import { commitDeviceLabel, detectDeviceName, deviceLabel } from "../src/device-label";

const IPHONE = { isIosApp: true };
const IPAD = { isIosApp: true, isTablet: true };
const ANDROID = { isAndroidApp: true };
const MAC = { isMacOS: true };
const WINDOWS = { isWin: true };
const LINUX = { isLinux: true };

describe("detectDeviceName", () => {
  it("names each supported platform", () => {
    expect(detectDeviceName(IPHONE)).toBe("iPhone");
    expect(detectDeviceName(IPAD)).toBe("iPad");
    expect(detectDeviceName(ANDROID)).toBe("Android");
    expect(detectDeviceName(MAC)).toBe("Mac");
    expect(detectDeviceName(WINDOWS)).toBe("Windows");
    expect(detectDeviceName(LINUX)).toBe("Linux");
  });

  it("prefers the app platform over the host operating system", () => {
    // Obsidian reports isMacOS on an iPad running the iOS app.
    expect(detectDeviceName({ isIosApp: true, isTablet: true, isMacOS: true })).toBe("iPad");
  });

  it("falls back to a generic name when nothing matches", () => {
    expect(detectDeviceName({})).toBe("Unknown device");
  });
});

describe("deviceLabel", () => {
  it("uses the configured author name", () => {
    expect(deviceLabel("macbook-work", MAC)).toBe("macbook-work");
  });

  it("falls back to the detected device when no author is configured", () => {
    expect(deviceLabel("", MAC)).toBe("Mac");
    expect(deviceLabel("   ", IPHONE)).toBe("iPhone");
  });

  it("strips characters that would break a conflict copy path", () => {
    expect(deviceLabel('work/mac:1*?"<>|', MAC)).toBe("workmac1");
  });

  it("collapses whitespace runs left by stripping", () => {
    expect(deviceLabel("home\tmac  mini", MAC)).toBe("home mac mini");
  });

  it("falls back to the detected device when the author name is all illegal characters", () => {
    expect(deviceLabel("///", MAC)).toBe("Mac");
  });

  it("truncates an overlong author name so paths stay usable", () => {
    expect(deviceLabel("x".repeat(80), MAC)).toBe("x".repeat(40));
  });
});

describe("commitDeviceLabel", () => {
  it("pairs the author with the detected device", () => {
    expect(commitDeviceLabel("macbook-work", MAC)).toBe("macbook-work (Mac)");
  });

  it("keeps the pair even when the author already names the device", () => {
    expect(commitDeviceLabel("iPhone", IPHONE)).toBe("iPhone (iPhone)");
  });

  it("returns the device alone when no author is configured", () => {
    expect(commitDeviceLabel("", MAC)).toBe("Mac");
  });

  it("uses the sanitized author name", () => {
    expect(commitDeviceLabel("work/mac", MAC)).toBe("workmac (Mac)");
  });
});
