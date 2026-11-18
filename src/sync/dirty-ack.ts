import type { DirtyEntry, PendingTransaction, PluginData } from "./types";

export function acknowledgeTransactionDirtyEntries(
  data: PluginData,
  transaction: PendingTransaction,
): void {
  acknowledgeDirtyEntries(
    data,
    transaction.acknowledgedDirtyEntries,
    transaction.acknowledgedDirtyPaths,
  );
}

export function acknowledgeDirtyEntries(
  data: PluginData,
  exactEntries: DirtyEntry[] | undefined,
  legacyPaths: string[],
): void {
  if (exactEntries === undefined) {
    for (const path of legacyPaths) {
      delete data.state.dirtyEntries[path];
    }
    return;
  }

  for (const acknowledged of exactEntries) {
    const current = data.state.dirtyEntries[acknowledged.path];
    if (sameDirtyEntry(current, acknowledged)) {
      delete data.state.dirtyEntries[acknowledged.path];
    }
  }
}

export function sameDirtyEntry(
  current: DirtyEntry | undefined,
  acknowledged: DirtyEntry,
): boolean {
  return current !== undefined &&
    current.path === acknowledged.path &&
    current.operation === acknowledged.operation &&
    current.recordedAt === acknowledged.recordedAt;
}
