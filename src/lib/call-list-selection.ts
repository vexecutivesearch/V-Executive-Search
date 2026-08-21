/** Rows the operator can see right now (closed stay out unless expanded). */
export function visibleCallListEntryIds(options: {
  activeIds: string[];
  closedIds: string[];
  showClosed: boolean;
}): string[] {
  return options.showClosed
    ? [...options.activeIds, ...options.closedIds]
    : options.activeIds;
}

export type SelectAllState = "none" | "some" | "all";

export function selectAllState(
  visibleIds: readonly string[],
  selected: ReadonlySet<string>,
): SelectAllState {
  if (visibleIds.length === 0) return "none";
  let n = 0;
  for (const id of visibleIds) {
    if (selected.has(id)) n += 1;
  }
  if (n === 0) return "none";
  if (n === visibleIds.length) return "all";
  return "some";
}

/** Select every visible row, or clear the visible ones if they are all selected. */
export function toggleSelectAll(
  visibleIds: readonly string[],
  selected: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selected);
  const allSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  if (allSelected) {
    for (const id of visibleIds) next.delete(id);
  } else {
    for (const id of visibleIds) next.add(id);
  }
  return next;
}

export function pruneSelection(
  selected: ReadonlySet<string>,
  existingIds: ReadonlySet<string>,
): Set<string> {
  const next = new Set<string>();
  for (const id of selected) {
    if (existingIds.has(id)) next.add(id);
  }
  return next;
}
