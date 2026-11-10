export interface VirtualWindowOptions {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly estimatedRowHeight: number;
  readonly overscan?: number;
}

export interface VirtualWindowSlice<T> {
  readonly totalCount: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly topSpacerHeight: number;
  readonly bottomSpacerHeight: number;
  readonly visibleItems: readonly { readonly index: number; readonly item: T }[];
}

/**
 * Computes a deterministic virtualized slice for long agent threads (following t3code's
 * Frontend Performance Guidelines: avoid mounting thousands of message/tool DOM nodes).
 */
export function computeVirtualThreadWindow<T>(
  items: readonly T[],
  options: VirtualWindowOptions
): VirtualWindowSlice<T> {
  const totalCount = items.length;
  const rowHeight = Math.max(1, options.estimatedRowHeight);
  const overscan = Math.max(0, options.overscan ?? 4);

  if (totalCount === 0) {
    return {
      totalCount: 0,
      startIndex: 0,
      endIndex: 0,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
      visibleItems: []
    };
  }

  const rawStart = Math.floor(Math.max(0, options.scrollTop) / rowHeight);
  const visibleRowsCount = Math.ceil(Math.max(rowHeight, options.viewportHeight) / rowHeight);

  const startIndex = Math.max(0, rawStart - overscan);
  const endIndex = Math.min(totalCount, rawStart + visibleRowsCount + overscan);

  const topSpacerHeight = startIndex * rowHeight;
  const bottomSpacerHeight = Math.max(0, (totalCount - endIndex) * rowHeight);

  const visibleItems: Array<{ readonly index: number; readonly item: T }> = [];
  for (let i = startIndex; i < endIndex; i += 1) {
    visibleItems.push({ index: i, item: items[i]! });
  }

  return {
    totalCount,
    startIndex,
    endIndex,
    topSpacerHeight,
    bottomSpacerHeight,
    visibleItems
  };
}
