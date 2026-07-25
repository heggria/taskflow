import { useCallback, useRef } from "react";
import type {
	WebBootstrapView,
	WebGeneratedClient,
	WebSessionView,
} from "taskflow-control/web-protocol";

export type WebBootResult = {
	readonly session?: WebSessionView;
	readonly bootstrap: WebBootstrapView;
};

type WebBootClient = Pick<
	WebGeneratedClient,
	"bootstrap" | "sessionExchange"
>;

function consumeLaunchToken(): string | undefined {
	const params = new URLSearchParams(
		window.location.hash.slice(1),
	);
	const value = params.get("launch");
	const token =
		value && /^[A-Za-z0-9_-]{43}$/u.test(value)
			? value
			: undefined;
	if (value !== null) {
		window.history.replaceState(
			window.history.state,
			"",
			window.location.pathname +
				window.location.search,
		);
	}
	return token;
}

/**
 * StrictMode replays effects without replaying refs. Keep each boot attempt
 * single-flight so a one-time launch capability is removed before I/O and is
 * never exchanged twice by setup-cleanup-setup.
 */
export function useWebBootRequest(
	client: WebBootClient,
	attempt: number,
): () => Promise<WebBootResult> {
	const requestRef = useRef<
		| {
				readonly attempt: number;
				readonly promise: Promise<WebBootResult>;
		  }
		| undefined
	>(undefined);
	return useCallback(() => {
		if (
			!requestRef.current ||
			requestRef.current.attempt !== attempt
		) {
			const token = consumeLaunchToken();
			requestRef.current = {
				attempt,
				promise: (async () => {
					let session: WebSessionView | undefined;
					if (token) {
						session =
							await client.sessionExchange({
								params: {},
								query: {},
								body: {
									launchToken:
										token,
								},
							});
					}
					const bootstrap =
						await client.bootstrap({
							params: {},
							query: {},
							body: {},
						});
					return { session, bootstrap };
				})(),
			};
		}
		return requestRef.current.promise;
	}, [attempt, client]);
}
