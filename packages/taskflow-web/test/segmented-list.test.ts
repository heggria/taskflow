import assert from "node:assert/strict";
import { test } from "node:test";
import {
	segmentCursorPages,
	WEB_TASK_PAGE_LIMIT,
} from "../src/segmented-list.ts";

test("task list page limit matches the P17 global maximum", () => {
	assert.equal(WEB_TASK_PAGE_LIMIT, 200);
});

test("segmentCursorPages preserves cursor-page boundaries and global offsets", () => {
	const pages = [
		{ items: Array.from({ length: 200 }, (_, index) => `a-${index}`) },
		{ items: [] as string[] },
		{ items: Array.from({ length: 17 }, (_, index) => `b-${index}`) },
	];
	const segments = segmentCursorPages(pages);
	assert.deepEqual(
		segments.map((segment) => ({
			pageIndex: segment.pageIndex,
			startIndex: segment.startIndex,
			length: segment.items.length,
		})),
		[
			{ pageIndex: 0, startIndex: 0, length: 200 },
			{ pageIndex: 2, startIndex: 200, length: 17 },
		],
	);
	assert.equal(segments[1]?.items[0], "b-0");
});

test("segmentCursorPages represents 10,000 rows as 50 virtualizable pages", () => {
	const pages = Array.from({ length: 50 }, (_, pageIndex) => ({
		items: Array.from(
			{ length: WEB_TASK_PAGE_LIMIT },
			(_, itemIndex) => pageIndex * WEB_TASK_PAGE_LIMIT + itemIndex,
		),
	}));
	const segments = segmentCursorPages(pages);
	assert.equal(segments.length, 50);
	assert.equal(segments[49]?.startIndex, 9_800);
	assert.equal(
		segments.reduce((count, segment) => count + segment.items.length, 0),
		10_000,
	);
});
