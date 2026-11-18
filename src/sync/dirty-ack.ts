import type { DirtyEntry, PendingTransaction, PluginData } from "./types";

export function acknowledgeTransactionDirtyEntries(
  data: PluginData,
  transaction: PendingTransaction,
): void {
  const exactEntries = transaction.acknowledgedDirtyEntries;
  if (exactEntries === undefined) {
    for (const path of transaction.acknowledgedDirtyPaths) {
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
