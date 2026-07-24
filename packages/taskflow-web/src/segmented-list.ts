export const WEB_TASK_PAGE_LIMIT = 200;

export type SegmentedListPage<Item> = {
	readonly pageIndex: number;
	readonly startIndex: number;
	readonly items: readonly Item[];
};

/**
 * Preserve server page boundaries so CSS can skip layout and paint for whole
 * off-screen cursor pages. Empty pages do not create inert accessibility or
 * layout containers.
 */
export function segmentCursorPages<Item>(
	pages: readonly { readonly items: readonly Item[] }[],
): readonly SegmentedListPage<Item>[] {
	const segments: SegmentedListPage<Item>[] = [];
	let startIndex = 0;
	for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
		const items = pages[pageIndex]?.items ?? [];
		if (items.length > 0) {
			segments.push({ pageIndex, startIndex, items });
		}
		startIndex += items.length;
	}
	return segments;
}
