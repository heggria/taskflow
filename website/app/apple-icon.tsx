// Apple touch icon (Next.js metadata file route → <link rel="apple-touch-icon">).
// Used by iOS Safari bookmarks, "Add to Home Screen", and Safari pinned tabs.
// iOS renders this full-bleed then masks it to the platform's squircle itself,
// so we fill the whole canvas (no rounded corners here) and keep the DAG motif
// generously inset so it isn't clipped by the mask. Same orange gradient as
// icon.tsx / favicon.svg for brand consistency.
import { ImageResponse } from 'next/og';

// `output: export` requires routes to be statically renderable.
export const dynamic = 'force-static';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';
export const alt = 'taskflow';

export default function AppleIcon() {
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
				}}
			>
				<svg
					width="104"
					height="104"
					viewBox="0 0 100 100"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
				>
					<line
						x1="28"
						y1="32"
						x2="72"
						y2="32"
						stroke="#fff"
						strokeWidth="7"
						strokeLinecap="round"
					/>
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
