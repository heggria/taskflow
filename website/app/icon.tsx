// Favicon / browser-tab icon (Next.js metadata file route).
// Emits /icon (with basePath applied automatically) as a PNG that modern
// browsers pick up via the injected <link rel="icon">. We also keep
// public/favicon.svg as an SVG fallback; this PNG is the canonical tab icon
// (renders identically in Safari, which still prefers PNG over SVG favicons).
//
// The DAG motif matches favicon.svg and the plugin icons: an orange rounded
// tile with three white nodes joined into a downward graph.
import { ImageResponse } from 'next/og';

// `output: export` requires routes to be statically renderable.
export const dynamic = 'force-static';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';
export const alt = 'taskflow';

export default function Icon() {
	return new ImageResponse(
		(
			<div
				style={{
					width: '100%',
					height: '100%',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					background: '#fb923c',
					backgroundImage:
						'linear-gradient(160deg, #fb923c 0%, #ea580c 100%)',
					borderRadius: 40,
					boxShadow: '0 6px 20px rgba(194, 65, 12, 0.3)',
				}}
			>
				<svg
					width="108"
					height="108"
					viewBox="0 0 100 100"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
				>
					{/* top crossbar edge */}
					<line
						x1="28"
						y1="32"
						x2="72"
						y2="32"
						stroke="#fff"
						strokeWidth="7"
						strokeLinecap="round"
					/>
					{/* downstroke edges into the bottom node */}
					<line
						x1="28"
						y1="32"
						x2="50"
						y2="70"
						stroke="#fff"
						strokeWidth="7"
						strokeLinecap="round"
					/>
					<line
						x1="72"
						y1="32"
						x2="50"
						y2="70"
						stroke="#fff"
						strokeWidth="7"
						strokeLinecap="round"
					/>
					{/* three nodes */}
					<circle cx="28" cy="32" r="10" fill="#fff" />
					<circle cx="72" cy="32" r="10" fill="#fff" />
					<circle cx="50" cy="72" r="12" fill="#fff" />
				</svg>
			</div>
		),
		{
			...size,
		},
	);
}
