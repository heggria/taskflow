import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createContext,
	type PropsWithChildren,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	createWebClient,
	type WebBootstrapView,
	type WebClientFailureError,
	type WebGeneratedClient,
	type WebSessionView,
	WebStreamFrameSchema,
	type WebStreamFrame,
} from "taskflow-control/web-protocol";
import {
	INITIAL_WEB_LIVE_STATE,
	reduceWebLiveState,
} from "taskflow-control/web-presentation-client";
import type {
	WebAuthoritativeResourceIdentity,
	WebAuthorityRefreshStamp,
	WebLiveEvent,
	WebLiveState,
} from "taskflow-control/web-presentation-schema";
import { Value } from "typebox/value";
import {
	formatWebContentMessage,
	formatWebStaticContent,
	selectWebContentLocale,
	type WebContentLocale,
	type WebStaticContentArguments,
	type WebStaticContentKey,
} from "./content/catalog.ts";
import {
	createFetchWebTransport,
	type WebJsonResponseObservation,
} from "./api/fetch-transport.ts";
import {
	acceptWebAuthorityRefresh,
	createWebAuthorityRefreshRegistry,
	invalidateWebAuthorityRefresh,
	webAuthorityRefreshStampFor,
} from "./authority-refresh.ts";
import {
	INITIAL_WEB_SESSION_LIFECYCLE_STATE,
	reduceWebSessionLifecycle,
	shouldSurfaceWebBootFailure,
	type WebSessionEndScope,
	type WebSessionLifecycleEvent,
	type WebSessionLifecycleState,
} from "./session-lifecycle.ts";
import { refetchActiveWebQueries } from "./live-resync.ts";

export type DisplayMode = "simple" | "pro";
export type ThemeMode = "system" | "light" | "dark";

type BootState =
	| { status: "booting" }
	| {
			status: "ready";
			session?: WebSessionView;
			bootstrap: WebBootstrapView;
	  }
	| { status: "terminated"; scope: "current" | "all" }
	| { status: "failed"; error: unknown };

type AppContextValue = {
	readonly client: WebGeneratedClient;
	readonly boot: BootState;
	readonly csrfToken?: string;
	readonly locale: WebContentLocale;
	readonly mode: DisplayMode;
	readonly theme: ThemeMode;
	readonly liveState: WebLiveState;
	readonly beginSessionTermination: (scope: WebSessionEndScope) => void;
	readonly cancelSessionTermination: (scope: WebSessionEndScope) => void;
	readonly endSession: (scope: WebSessionEndScope) => void;
	readonly setLocale: (locale: WebContentLocale) => void;
	readonly setMode: (mode: DisplayMode) => void;
	readonly setTheme: (theme: ThemeMode) => void;
	readonly retryBoot: () => void;
	readonly refreshStampFor: (
		resource: WebAuthoritativeResourceIdentity,
		response: object,
	) => WebAuthorityRefreshStamp | undefined;
	readonly t: (
		key: WebStaticContentKey,
		args?: WebStaticContentArguments,
	) => string;
	readonly message: (
		value: Parameters<typeof formatWebContentMessage>[0],
	) => string;
};

const AppContext = createContext<AppContextValue | null>(null);

function launchToken(): string | undefined {
	const value = new URLSearchParams(window.location.hash.slice(1)).get("launch");
	return value && /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : undefined;
}

function stripLaunchFragment(): void {
	if (!window.location.hash.includes("launch=")) return;
	window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
}

function initialMode(): DisplayMode {
	return new URLSearchParams(window.location.search).get("view") === "pro"
		? "pro"
		: "simple";
}

function applyTheme(theme: ThemeMode): void {
	document.documentElement.dataset.theme = theme;
}

export function AppProvider({ children }: PropsWithChildren): React.JSX.Element {
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						staleTime: 2_000,
						retry: 1,
						refetchOnWindowFocus: true,
					},
				},
			}),
	);
	const csrfRef = useRef<string | undefined>(undefined);
	const liveStateRef = useRef<WebLiveState>(INITIAL_WEB_LIVE_STATE);
	const sessionLifecycleRef = useRef<WebSessionLifecycleState>(
		INITIAL_WEB_SESSION_LIFECYCLE_STATE,
	);
	const authorityRefreshRef = useRef(createWebAuthorityRefreshRegistry());
	const responseObserverRef = useRef<
		((observation: WebJsonResponseObservation) => void) | undefined
	>(undefined);
	const unauthorizedObserverRef = useRef<() => void>(
		() => undefined,
	);
	const sessionRevocationObserverRef = useRef<
		(scope: "current" | "all") => void
	>(() => undefined);
	const [csrfToken, setCsrfToken] = useState<string>();
	const [liveState, setLiveState] = useState<WebLiveState>(
		INITIAL_WEB_LIVE_STATE,
	);
	const [refreshStampRevision, setRefreshStampRevision] = useState(0);
	const [bootAttempt, setBootAttempt] = useState(0);
	const [boot, setBoot] = useState<BootState>({ status: "booting" });
	const [mode, setModeState] = useState<DisplayMode>(initialMode);
	const [theme, setThemeState] = useState<ThemeMode>("system");
	const [locale, setLocale] = useState<WebContentLocale>(() =>
		selectWebContentLocale(navigator.languages),
	);
	const client = useMemo(
		() =>
			createWebClient(
				createFetchWebTransport(
					() => csrfRef.current,
					(observation) => responseObserverRef.current?.(observation),
					() => unauthorizedObserverRef.current(),
					() => authorityRefreshRef.current.generation,
				),
			),
		[],
	);
	const dispatchLiveEvent = useCallback((event: WebLiveEvent) => {
		const next = reduceWebLiveState(liveStateRef.current, event);
		liveStateRef.current = next;
		setLiveState(next);
	}, []);
	const invalidateAuthorityRefresh = useCallback(() => {
		invalidateWebAuthorityRefresh(authorityRefreshRef.current);
		setRefreshStampRevision((value) => value + 1);
	}, []);
	responseObserverRef.current = (observation) => {
		if (observation.endpointId === "sessionLogout") {
			sessionRevocationObserverRef.current("current");
		} else if (
			observation.endpointId === "sessionsRevokeAll"
		) {
			sessionRevocationObserverRef.current("all");
		}
		const accepted = acceptWebAuthorityRefresh(
			authorityRefreshRef.current,
			observation,
			liveStateRef.current.invalidationEpoch,
		);
		if (accepted) setRefreshStampRevision((value) => value + 1);
	};

	useEffect(() => {
		let cancelled = false;
		setBoot({ status: "booting" });
		void (async () => {
			try {
				const token = launchToken();
				let session: WebSessionView | undefined;
				if (token) {
					session = await client.sessionExchange({
						params: {},
						query: {},
						body: { launchToken: token },
					});
					csrfRef.current = session.csrfToken;
					setCsrfToken(session.csrfToken);
					stripLaunchFragment();
				}
				const bootstrap = await client.bootstrap({
					params: {},
					query: {},
					body: {},
				});
				csrfRef.current = bootstrap.csrfToken;
				if (!cancelled) {
					setCsrfToken(bootstrap.csrfToken);
					setBoot({ status: "ready", session, bootstrap });
				}
			} catch (error) {
				if (
					!cancelled &&
					shouldSurfaceWebBootFailure(
						sessionLifecycleRef.current,
					)
				) {
					setBoot({ status: "failed", error });
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [bootAttempt, client]);

	useEffect(() => applyTheme(theme), [theme]);
	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);

	useEffect(() => {
		if (boot.status !== "ready") return;
		let disposed = false;
		let resyncing = false;
		let polling = false;
		let streamOpen = false;
		let pollingTimer: number | undefined;
		let sessionProbe: Promise<void> | undefined;
		const eventSource = new EventSource("/api/v1/events");
		const stopPolling = () => {
			if (pollingTimer === undefined) return;
			window.clearTimeout(pollingTimer);
			pollingTimer = undefined;
		};
		const resync = async () => {
			if (disposed || resyncing) return;
			resyncing = true;
			dispatchLiveEvent({ type: "resync-started" });
			try {
				await refetchActiveWebQueries(queryClient);
				if (!disposed) dispatchLiveEvent({ type: "resync-succeeded" });
			} catch {
				if (!disposed) dispatchLiveEvent({ type: "resync-failed" });
			} finally {
				resyncing = false;
			}
		};
		const schedulePolling = () => {
			if (
				disposed ||
				streamOpen ||
				polling ||
				pollingTimer !== undefined
			) {
				return;
			}
			pollingTimer = window.setTimeout(() => {
				pollingTimer = undefined;
				if (disposed || streamOpen || polling) return;
				polling = true;
				void (async () => {
					try {
						const resyncState =
							liveStateRef.current.resyncState;
						if (
							resyncState === "required" ||
							resyncState === "failed"
						) {
							await resync();
						} else {
							await queryClient.refetchQueries({
								type: "active",
							});
						}
					} finally {
						polling = false;
						schedulePolling();
					}
				})();
			}, boot.bootstrap.pollingMinIntervalMs);
		};
		const probeCurrentSession = () => {
			if (
				disposed ||
				sessionProbe ||
				sessionLifecycleRef.current.pendingScope !==
					undefined
			) {
				return;
			}
			const probe = Promise.resolve()
				.then(() =>
					client.bootstrap({
						params: {},
						query: {},
						body: {},
					}),
				)
				.then(
					() => undefined,
					() => undefined,
				)
				.finally(() => {
					if (sessionProbe === probe) sessionProbe = undefined;
				});
			sessionProbe = probe;
		};
		const degradeToPolling = () => {
			streamOpen = false;
			invalidateAuthorityRefresh();
			dispatchLiveEvent({
				type: "stream-disconnected",
				at: Date.now(),
			});
			// EventSource deliberately hides the reconnect response status.
			// Make one deduplicated authenticated request immediately so a
			// listener-wide revocation reaches the authoritative 401 observer
			// even when the current route has no active data queries. A local
			// logout/revoke request already in flight owns its exact scope and
			// must settle before a generic current-tab probe can race it.
			probeCurrentSession();
			schedulePolling();
		};
		eventSource.onopen = () => {
			streamOpen = true;
			stopPolling();
			invalidateAuthorityRefresh();
			dispatchLiveEvent({
				type: "stream-catching-up",
				at: Date.now(),
			});
			dispatchLiveEvent({ type: "stream-connected", at: Date.now() });
		};
		const onFrame = (rawEvent: Event) => {
			if (!(rawEvent instanceof MessageEvent)) return;
			const data = String(rawEvent.data);
			if (new TextEncoder().encode(data).byteLength > 64 * 1024) {
				dispatchLiveEvent({ type: "resync-started" });
				dispatchLiveEvent({ type: "resync-failed" });
				eventSource.close();
				degradeToPolling();
				return;
			}
			let value: unknown;
			try {
				value = JSON.parse(data);
			} catch {
				dispatchLiveEvent({ type: "resync-started" });
				dispatchLiveEvent({ type: "resync-failed" });
				eventSource.close();
				degradeToPolling();
				return;
			}
			if (!Value.Check(WebStreamFrameSchema, value)) {
				dispatchLiveEvent({ type: "resync-started" });
				dispatchLiveEvent({ type: "resync-failed" });
				eventSource.close();
				degradeToPolling();
				return;
			}
			const frame = value as WebStreamFrame;
			streamOpen = true;
			stopPolling();
			dispatchLiveEvent({
				type: "stream-connected",
				at: frame.observedAt,
			});
			if (frame.type === "reset-required") {
				invalidateAuthorityRefresh();
				dispatchLiveEvent({
					type: "reset-required",
					at: frame.observedAt,
				});
				return;
			}
			if (frame.type === "checkpoint") {
				invalidateAuthorityRefresh();
				void resync();
				return;
			}
			if (frame.type === "change") {
				performance.mark(
					"taskflow:event-change-received",
					{
						detail: {
							commitSeq:
								frame.commitSeq ??
								null,
							observedAt:
								frame.observedAt,
						},
					},
				);
				invalidateAuthorityRefresh();
				void queryClient.invalidateQueries();
			}
		};
		eventSource.addEventListener("taskflow", onFrame);
		eventSource.onerror = degradeToPolling;
		return () => {
			disposed = true;
			stopPolling();
			eventSource.removeEventListener("taskflow", onFrame);
			eventSource.close();
		};
	}, [
		boot.status,
		boot.status === "ready"
			? boot.bootstrap.pollingMinIntervalMs
			: undefined,
		client,
		dispatchLiveEvent,
		invalidateAuthorityRefresh,
		queryClient,
	]);

	const setMode = useCallback((next: DisplayMode) => {
		setModeState(next);
		const url = new URL(window.location.href);
		if (next === "pro") url.searchParams.set("view", "pro");
		else url.searchParams.delete("view");
		window.history.replaceState(window.history.state, "", url.pathname + url.search);
	}, []);
	const setTheme = useCallback((next: ThemeMode) => setThemeState(next), []);
	const retryBoot = useCallback(() => setBootAttempt((value) => value + 1), []);
	const beginSessionTermination = useCallback(
		(scope: WebSessionEndScope) => {
			sessionLifecycleRef.current =
				reduceWebSessionLifecycle(
					sessionLifecycleRef.current,
					{
						type: "termination-started",
						scope,
					},
				);
		},
		[],
	);
	const cancelSessionTermination = useCallback(
		(scope: WebSessionEndScope) => {
			sessionLifecycleRef.current =
				reduceWebSessionLifecycle(
					sessionLifecycleRef.current,
					{
						type: "termination-cancelled",
						scope,
					},
				);
		},
		[],
	);
	const applySessionEnd = useCallback(
		(event: WebSessionLifecycleEvent) => {
			const lifecycle = reduceWebSessionLifecycle(
				sessionLifecycleRef.current,
				event,
			);
			sessionLifecycleRef.current = lifecycle;
			const scope = lifecycle.terminatedScope;
			if (!scope) return;
			csrfRef.current = undefined;
			setCsrfToken(undefined);
			invalidateAuthorityRefresh();
			void queryClient.cancelQueries();
			queryClient.clear();
			liveStateRef.current = INITIAL_WEB_LIVE_STATE;
			setLiveState(INITIAL_WEB_LIVE_STATE);
			setBoot({ status: "terminated", scope });
		},
		[invalidateAuthorityRefresh, queryClient],
	);
	const endSession = useCallback(
		(scope: WebSessionEndScope) => {
			applySessionEnd({
				type: "termination-succeeded",
				scope,
			});
		},
		[applySessionEnd],
	);
	unauthorizedObserverRef.current = () => {
		applySessionEnd({ type: "unauthorized" });
	};
	sessionRevocationObserverRef.current = endSession;
	const refreshStampFor = useCallback(
		(
			resource: WebAuthoritativeResourceIdentity,
			response: object,
		) => {
			return webAuthorityRefreshStampFor(
				authorityRefreshRef.current,
				resource,
				response,
			);
		},
		// Revision makes newly verified detail reads observable without exposing
		// the mutable map as browser state.
		[refreshStampRevision],
	);
	const t = useCallback(
		(key: WebStaticContentKey, args: WebStaticContentArguments = {}) =>
			formatWebStaticContent(key, locale, args),
		[locale],
	);
	const message = useCallback(
		(value: Parameters<typeof formatWebContentMessage>[0]) =>
			formatWebContentMessage(value, locale),
		[locale],
	);

	const value = useMemo<AppContextValue>(
		() => ({
			client,
			boot,
			...(csrfToken ? { csrfToken } : {}),
			locale,
			mode,
			theme,
			liveState,
			beginSessionTermination,
			cancelSessionTermination,
			endSession,
			setLocale,
			setMode,
			setTheme,
			retryBoot,
			refreshStampFor,
			t,
			message,
		}),
		[
			boot,
			beginSessionTermination,
			cancelSessionTermination,
			client,
			csrfToken,
			endSession,
			locale,
			liveState,
			message,
			mode,
			retryBoot,
			refreshStampFor,
			setMode,
			setTheme,
			t,
			theme,
		],
	);
	return (
		<QueryClientProvider client={queryClient}>
			<AppContext.Provider value={value}>{children}</AppContext.Provider>
		</QueryClientProvider>
	);
}

export function useApp(): AppContextValue {
	const context = useContext(AppContext);
	if (!context) throw new Error("AppProvider is missing");
	return context;
}

export function failureCode(error: unknown): string | undefined {
	return (error as WebClientFailureError | undefined)?.failure?.error.code;
}
