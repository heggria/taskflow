import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import lastModified from "fumadocs-mdx/plugins/last-modified";

export const docs = defineDocs({
	dir: "content/docs",
});

export default defineConfig({
	// Injects `lastModified` (Date, from git) into each page's data so that
	// <PageLastUpdate date={page.data.lastModified} /> can render on docs pages.
	plugins: [lastModified()],
});
