// Web App Manifest (Next.js metadata file route → /manifest.webmanifest).
// Enables install-to-home-screen, the Android "maskable" adaptive icon, and a
// branded splash color when the site is added to a device. Icon srcs point at
// the metadata file routes (app/icon.tsx, app/apple-icon.tsx); Next.js applies
// the configured basePath automatically, so no manual prefix here.
import type { MetadataRoute } from 'next';

// `output: export` requires routes to be statically renderable.
export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
	// basePath must be prepended manually — manifest is emitted as a static
	// asset under output:export, so icon srcs won't get the prefix otherwise.
	const base = process.env.TASKFLOW_BASE_PATH || '';
	return {
		name: 'taskflow — declarative agent orchestration',
		short_name: 'taskflow',
		description:
			'A declarative, verifiable graph of task nodes for coding-agent subagents. Fan out, gate, loop, resume, and save as a command.',
		start_url: `${base}/`,
		display: 'standalone',
		background_color: '#fff7ed',
		theme_color: '#ea580c',
		icons: [
			{
				// any-purpose icon (browser tab + Android standard)
				src: `${base}/icon`,
				sizes: '180x180',
				type: 'image/png',
				purpose: 'any',
			},
			{
				// maskable: Android adaptive icon — the orange tile fills the
				// safe zone so the platform mask yields a clean squircle.
				src: `${base}/apple-icon`,
				sizes: '180x180',
				type: 'image/png',
				purpose: 'maskable',
			},
		],
	};
}
