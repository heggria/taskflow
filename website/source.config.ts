import { pageSchema } from "fumadocs-core/source/schema";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import lastModified from "fumadocs-mdx/plugins/last-modified";
import { z } from "zod";

const docsPageSchema = pageSchema.extend({
	redirect: z.string().startsWith("/").optional(),
});

export const docs = defineDocs({
	dir: "content/docs",
	docs: {
		schema: docsPageSchema,
	},
});

export default defineConfig({
	// Injects `lastModified` (Date, from git) into each page's data so that
	// <PageLastUpdate date={page.data.lastModified} /> can render on docs pages.
	plugins: [lastModified()],
});
