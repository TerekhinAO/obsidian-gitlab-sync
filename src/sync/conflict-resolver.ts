import type { GitLabCommitAction } from "../gitlab/types";
import type { LocalSnapshotEntry, VersionState } from "./local-snapshot";
import type { MaterializeOperation, TrackedFile } from "./types";

export type { LocalSnapshotEntry, VersionState } from "./local-snapshot";

export interface ConflictResolutionPlan {
  commitActions: GitLabCommitAction[];
  materializeOperations: MaterializeOperation[];
  conflictPaths: string[];
  nextIndexMutations: Array<
    | { type: "set"; path: string; file: TrackedFile }
    | { type: "delete"; path: string }
  >;
}

export class ConflictResolver {
  async resolve(input: {
    snapshots: LocalSnapshotEntry[];
    remote: Record<string, VersionState>;
    trackedFiles: Record<string, TrackedFile>;
    now: Date;
    deviceName?: string;
    occupiedPaths?: Iterable<string>;
  }): Promise<ConflictResolutionPlan> {
    const plan: ConflictResolutionPlan = {
      commitActions: [],
      materializeOperations: [],
      conflictPaths: [],
      nextIndexMutations: [],
    };
    const occupied = new Set<string>([
      ...Object.keys(input.trackedFiles),
      ...Object.keys(input.remote),
      ...input.snapshots.map((entry) => entry.path),
      ...(input.occupiedPaths ?? []),
    ]);
    const deviceName = input.deviceName ?? "iPhone";

    for (const snapshot of input.snapshots) {
      const remote = input.remote[snapshot.path] ?? { exists: false, bytes: null };
      if (snapshot.base === null) {
        await this.resolveUnknownBase(snapshot, remote, input.now, deviceName, occupied, plan);
        continue;
      }

      await this.resolveKnownBase(snapshot, snapshot.base, remote, input.now, deviceName, occupied, plan);
    }

    return plan;
  }

  private async resolveKnownBase(
    snapshot: LocalSnapshotEntry,
    base: VersionState,
    remote: VersionState,
    now: Date,
    deviceName: string,
    occupied: Set<string>,
    plan: ConflictResolutionPlan,
  ): Promise<void> {
    const localChanged = !sameVersion(snapshot.local, base);
    const remoteChanged = !sameVersion(remote, base);

    if (!localChanged && remoteChanged) {
      materialize(snapshot.path, remote, plan);
      return;
    }

    if (localChanged && !remoteChanged) {
      await commitOriginal(snapshot.path, snapshot.local, base.exists, plan);
      return;
    }

    if (!localChanged || sameVersion(snapshot.local, remote)) {
      return;
    }

    await preserveBoth(snapshot.path, snapshot.local, remote, now, deviceName, occupied, plan);
  }

  private async resolveUnknownBase(
    snapshot: LocalSnapshotEntry,
    remote: VersionState,
    now: Date,
    deviceName: string,
    occupied: Set<string>,
    plan: ConflictResolutionPlan,
  ): Promise<void> {
    if (sameVersion(snapshot.local, remote)) {
      return;
    }

    await preserveBoth(snapshot.path, snapshot.local, remote, now, deviceName, occupied, plan);
  }
}

async function commitOriginal(
  path: string,
  local: VersionState,
  baseExists: boolean,
  plan: ConflictResolutionPlan,
): Promise<void> {
  if (!local.exists || local.bytes === null) {
    plan.commitActions.push({ action: "delete", file_path: path });
    plan.nextIndexMutations.push({ type: "delete", path });
    return;
  }

  plan.commitActions.push({
    action: baseExists ? "update" : "create",
    file_path: path,
    content: toBase64(local.bytes),
    encoding: "base64",
  });
  plan.nextIndexMutations.push({ type: "set", path, file: await trackedFile(local.bytes) });
}

async function preserveBoth(
  path: string,
  local: VersionState,
  remote: VersionState,
  now: Date,
  deviceName: string,
  occupied: Set<string>,
  plan: ConflictResolutionPlan,
): Promise<void> {
  materialize(path, remote, plan);

  if (!local.exists || local.bytes === null) {
    const markerBytes = new TextEncoder().encode(deletionMarker(path));
    const markerPath = nextAvailablePath(
      conflictPath(path, "deletion conflict", deviceName, now, ".md"),
      occupied,
    );
    await addCreatedConflict(markerPath, markerBytes, occupied, plan);
    return;
  }

  const copyPath = nextAvailablePath(
    conflictPath(path, "conflict", deviceName, now),
    occupied,
  );
  await addCreatedConflict(copyPath, local.bytes, occupied, plan);
}

function materialize(
  path: string,
  state: VersionState,
  plan: ConflictResolutionPlan,
): void {
  if (!state.exists || state.bytes === null) {
    plan.materializeOperations.push({ type: "delete", path });
    return;
  }

  plan.materializeOperations.push({
    type: "write",
    path,
    contentBase64: toBase64(state.bytes),
  });
}

async function addCreatedConflict(
  path: string,
  bytes: Uint8Array,
  occupied: Set<string>,
  plan: ConflictResolutionPlan,
): Promise<void> {
  occupied.add(path);
  const content = toBase64(bytes);
  plan.commitActions.push({
    action: "create",
    file_path: path,
    content,
    encoding: "base64",
  });
  plan.materializeOperations.push({ type: "write", path, contentBase64: content });
  plan.conflictPaths.push(path);
  plan.nextIndexMutations.push({ type: "set", path, file: await trackedFile(bytes) });
}

async function trackedFile(bytes: Uint8Array): Promise<TrackedFile> {
  return {
    blobId: await calculateGitBlobId(bytes),
    mode: "100644",
    size: bytes.byteLength,
  };
}

export async function calculateGitBlobId(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const payload = new Uint8Array(header.byteLength + bytes.byteLength);
  payload.set(header, 0);
  payload.set(bytes, header.byteLength);

  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-1", payload);
    return hex(new Uint8Array(digest));
  }

  return sha1(payload);
}

function sameVersion(left: VersionState, right: VersionState): boolean {
  if (left.exists !== right.exists) {
    return false;
  }
  if (!left.exists) {
    return true;
  }
  return left.bytes !== null && right.bytes !== null && sameBytes(left.bytes, right.bytes);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function conflictPath(
  path: string,
  label: string,
  deviceName: string,
  now: Date,
  forcedExtension?: string,
): string {
  const slash = path.lastIndexOf("/");
  const directory = slash === -1 ? "" : `${path.slice(0, slash + 1)}`;
  const fileName = slash === -1 ? path : path.slice(slash + 1);
  const dot = fileName.lastIndexOf(".");
  const hasExtension = dot > 0;
  const stem = hasExtension ? fileName.slice(0, dot) : fileName;
  const extension = forcedExtension ?? (hasExtension ? fileName.slice(dot) : "");
  return `${directory}${stem} — ${label} ${deviceName} ${timestamp(now)}${extension}`;
}

function nextAvailablePath(path: string, occupied: Set<string>): string {
  if (!occupied.has(path)) {
    return path;
  }

  const slash = path.lastIndexOf("/");
  const directory = slash === -1 ? "" : `${path.slice(0, slash + 1)}`;
  const fileName = slash === -1 ? path : path.slice(slash + 1);
  const dot = fileName.lastIndexOf(".");
  const hasExtension = dot > 0;
  const stem = hasExtension ? fileName.slice(0, dot) : fileName;
  const extension = hasExtension ? fileName.slice(dot) : "";

  let suffix = 2;
  while (occupied.has(`${directory}${stem}-${suffix}${extension}`)) {
    suffix += 1;
  }
  return `${directory}${stem}-${suffix}${extension}`;
}

function timestamp(now: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join("-") + ` ${pad(now.getHours())}-${pad(now.getMinutes())}`;
}

function deletionMarker(path: string): string {
  return [
    "# Sync conflict: deletion on iPhone",
    "",
    `The file \`${path}\` was deleted on iPhone, but the GitLab version changed after the last successful sync.`,
    "",
    "The GitLab version was kept at the original path. Review it and delete it manually if deletion is still intended.",
    "",
  ].join("\n");
}

function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  return encodeBase64(bytes);
}

function encodeBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";

  for (let index = 0; index < bytes.byteLength; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const hasSecond = index + 1 < bytes.byteLength;
    const hasThird = index + 2 < bytes.byteLength;
    const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    encoded += alphabet[(triple >> 18) & 0x3f];
    encoded += alphabet[(triple >> 12) & 0x3f];
    encoded += hasSecond ? alphabet[(triple >> 6) & 0x3f] : "=";
    encoded += hasThird ? alphabet[triple & 0x3f] : "=";
  }

  return encoded;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sha1(bytes: Uint8Array): string {
  const words: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    words[index >> 2] = (words[index >> 2] ?? 0) | (bytes[index] << (24 - (index % 4) * 8));
  }
  words[bytes.length >> 2] = (words[bytes.length >> 2] ?? 0) | (0x80 << (24 - (bytes.length % 4) * 8));
  words[(((bytes.length + 8) >> 6) << 4) + 15] = bytes.length * 8;

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  for (let block = 0; block < words.length; block += 16) {
    const schedule = new Array<number>(80);
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = words[block + index] ?? 0;
    }
    for (let index = 16; index < 80; index += 1) {
      schedule[index] = rotateLeft(
        schedule[index - 3] ^ schedule[index - 8] ^ schedule[index - 14] ^ schedule[index - 16],
        1,
      );
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let index = 0; index < 80; index += 1) {
      const [f, k] = sha1Round(index, b, c, d);
      const temp = (rotateLeft(a, 5) + f + e + k + schedule[index]) | 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  return [h0, h1, h2, h3, h4]
    .map((word) => (word >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

function sha1Round(index: number, b: number, c: number, d: number): [number, number] {
  if (index < 20) {
    return [(b & c) | (~b & d), 0x5a827999];
  }
  if (index < 40) {
    return [b ^ c ^ d, 0x6ed9eba1];
  }
  if (index < 60) {
    return [(b & c) | (b & d) | (c & d), 0x8f1bbcdc];
  }
  return [b ^ c ^ d, 0xca62c1d6];
}

function rotateLeft(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}
