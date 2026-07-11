import Link from "next/link";
import type { Locale } from "@/lib/i18n";

export function HomeHeader({
	lang,
	labels,
}: {
	lang: Locale;
	labels: {
		docs: string;
		examples: string;
		github: string;
		localeEn: string;
		localeZh: string;
	};
}) {
	return (
		<header className="home-header">
			<div className="home-frame home-header__inner">
				<Link
					href={`/${lang}/`}
					className="home-header__brand"
					aria-label="taskflow home"
				>
					<span className="home-header__mark" aria-hidden="true" />
					<span>taskflow</span>
				</Link>

				<div className="home-header__cluster">
					<nav className="home-header__nav" aria-label="Primary">
						<Link href={`/${lang}/docs`}>{labels.docs}</Link>
						<a
							href="https://github.com/heggria/taskflow/tree/main/examples"
							target="_blank"
							rel="noreferrer"
						>
							{labels.examples}
						</a>
						<a
							href="https://github.com/heggria/taskflow"
							target="_blank"
							rel="noreferrer"
						>
							{labels.github}
						</a>
					</nav>

					<nav className="home-header__locale" aria-label="Language switcher">
						<Link
							href="/en/"
							data-active={lang === "en"}
							aria-current={lang === "en" ? "page" : undefined}
						>
							{labels.localeEn}
						</Link>
						<Link
							href="/zh-cn/"
							data-active={lang === "zh-cn"}
							aria-current={lang === "zh-cn" ? "page" : undefined}
						>
							{labels.localeZh}
						</Link>
					</nav>
				</div>
			</div>
		</header>
	);
}
