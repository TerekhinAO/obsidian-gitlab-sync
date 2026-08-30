/**
 * Labels that identify the local side of a sync.
 *
 * The label reaches GitLab commit messages and the names of conflict copies
 * that then sync to every other device, so it has to be both recognisable and
 * safe to embed in a vault path.
 */

/** The subset of Obsidian's `Platform` this module needs, kept injectable for tests. */
export interface DevicePlatform {
  isIosApp?: boolean;
  isAndroidApp?: boolean;
  isTablet?: boolean;
  isMacOS?: boolean;
  isWin?: boolean;
  isLinux?: boolean;
}

const FALLBACK_DEVICE_NAME = "Unknown device";
const MAX_LABEL_LENGTH = 40;
/** Characters that no vault path may contain. */
const ILLEGAL_PATH_CHARACTERS = /[/\\:*?"<>|]/g;
const DEL_CODE_POINT = 0x7f;
const FIRST_PRINTABLE_CODE_POINT = 0x20;

/**
 * Names the current platform. The app flags win over the host operating
 * system flags, because Obsidian reports both on iPadOS.
 */
export function detectDeviceName(platform: DevicePlatform): string {
  if (platform.isIosApp) {
    return platform.isTablet ? "iPad" : "iPhone";
  }
  if (platform.isAndroidApp) {
    return "Android";
  }
  if (platform.isMacOS) {
    return "Mac";
  }
  if (platform.isWin) {
    return "Windows";
  }
  if (platform.isLinux) {
    return "Linux";
  }
  return FALLBACK_DEVICE_NAME;
}

/**
 * The short label used in conflict copy paths and conflict note bodies, where
 * every character costs. Falls back to the detected device when the configured
 * author name is missing or survives sanitising as an empty string.
 */
export function deviceLabel(authorName: string, platform: DevicePlatform): string {
  return sanitize(authorName) || detectDeviceName(platform);
}

/**
 * The long label used in commit messages, where the extra context is worth the
 * width: it tells you both who configured the device and what kind it is.
 */
export function commitDeviceLabel(authorName: string, platform: DevicePlatform): string {
  const author = sanitize(authorName);
  const device = detectDeviceName(platform);
  return author === "" ? device : `${author} (${device})`;
}

function sanitize(value: string): string {
  return blankControlCharacters(value)
    .replace(ILLEGAL_PATH_CHARACTERS, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LABEL_LENGTH)
    .trim();
}

/**
 * Turns control characters into spaces rather than dropping them, so that a
 * tab-separated name collapses into separate words instead of one run-on word.
 */
function blankControlCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl = codePoint < FIRST_PRINTABLE_CODE_POINT || codePoint === DEL_CODE_POINT;
    result += isControl ? " " : character;
  }
  return result;
}
