import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

// The site is statically exported (`output: "export"`) to GitHub Pages, so
// there is no runtime server. `staticGET` pre-renders the full search index
// (zbsearch) into a static JSON file at build time; the client loads it with
// the `type: "static"` search dialog (see app/layout.tsx) and searches in the
// browser, so the Cmd+K / search dialog never hits a 404 endpoint.
//
// See https://fumadocs.dev/docs/headless/search/orama#static-export
export const revalidate = false;

export const { staticGET: GET } = createFromSource(source);
