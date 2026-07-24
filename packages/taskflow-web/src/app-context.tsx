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
	readonly endSession: (scope: "current" | "all") => void;
	readonly setLocale: (locale: WebContentLocale) => void;
	readonly setMode: (mode: DisplayMode) => void;
	readonly setTheme: (theme: ThemeMode) => void;
	readonly retryBoot: () => void;
	readonly refreshStampFor: (
		resource: WebAuthoritativeResourceIdentity,
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(
	value: Record<string, unknown>,
	key: string,
): string | undefined {
	return typeof value[key] === "string" ? value[key] : undefined;
}

function resourceKey(resource: WebAuthoritativeResourceIdentity): string {
	switch (resource.type) {
		case "project":
			return `project\u0000${resource.projectId}\u0000${resource.controlDomainId}`;
		case "run":
			return `run\u0000${resource.projectId}\u0000${resource.controlDomainId}\u0000${resource.runId}`;
		case "approval":
			return `approval\u0000${resource.projectId}\u0000${resource.controlDomainId}\u0000${resource.runId}\u0000${resource.approvalRequestId}`;
		case "reservation":
			return `reservation\u0000${resource.reservationId}`;
	}
}

function responseRefreshStamp(
	observation: WebJsonResponseObservation,
	invalidationEpoch: number,
): WebAuthorityRefreshStamp | undefined {
	if (!isRecord(observation.envelope) || observation.envelope.ok !== true) {
		return undefined;
	}
	const requestId = stringField(observation.envelope, "requestId");
	const data = observation.envelope.data;
	if (!requestId || !isRecord(data)) return undefined;
	const sourceObservation = data.sourceObservation;
	if (
		!isRecord(sourceObservation) ||
		sourceObservation.authority !== "verified" ||
		typeof sourceObservation.observedAt !== "number"
	) {
		return undefined;
	}

	let resource: WebAuthoritativeResourceIdentity | undefined;
	if (observation.endpointId === "projectDetail") {
		const projectId = stringField(data, "projectId");
		const controlDomainId = stringField(data, "controlDomainId");
		if (projectId && controlDomainId) {
			resource = { type: "project", projectId, controlDomainId };
		}
	} else if (observation.endpointId === "runDetail" && isRecord(data.run)) {
		const projectId = stringField(data.run, "projectId");
		const controlDomainId = stringField(data.run, "controlDomainId");
		const runId = stringField(data.run, "runId");
		if (projectId && controlDomainId && runId) {
			resource = { type: "run", projectId, controlDomainId, runId };
		}
	} else if (
		observation.endpointId === "approvalDetail" &&
		isRecord(data.summary)
	) {
		const projectId = stringField(data.summary, "projectId");
		const controlDomainId = stringField(data.summary, "controlDomainId");
		const runId = stringField(data.summary, "runId");
		const approvalRequestId = stringField(data.summary, "approvalRequestId");
		if (projectId && controlDomainId && runId && approvalRequestId) {
			resource = {
				type: "approval",
				projectId,
				controlDomainId,
				runId,
				approvalRequestId,
			};
		}
	} else if (observation.endpointId === "reservationDetail") {
		const reservationId = stringField(data, "reservationId");
		if (reservationId) resource = { type: "reservation", reservationId };
	}
	if (!resource) return undefined;
	return {
		resource,
		invalidationEpoch,
		requestId,
		observedAt: sourceObservation.observedAt,
	};
}

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
	const refreshStampsRef = useRef(
		new Map<string, WebAuthorityRefreshStamp>(),
	);
	const responseObserverRef = useRef<
		((observation: WebJsonResponseObservation) => void) | undefined
	>(undefined);
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
				),
			),
		[],
	);
	const dispatchLiveEvent = useCallback((event: WebLiveEvent) => {
		const next = reduceWebLiveState(liveStateRef.current, event);
		liveStateRef.current = next;
		setLiveState(next);
	}, []);
	const clearRefreshStamps = useCallback(
		(predicate?: (stamp: WebAuthorityRefreshStamp) => boolean) => {
			const stamps = refreshStampsRef.current;
			let changed = false;
			if (!predicate) {
				changed = stamps.size > 0;
				stamps.clear();
			} else {
				for (const [key, stamp] of stamps) {
					if (!predicate(stamp)) continue;
					stamps.delete(key);
					changed = true;
				}
			}
			if (changed) setRefreshStampRevision((value) => value + 1);
		},
		[],
	);
	responseObserverRef.current = (observation) => {
		const stamp = responseRefreshStamp(
			observation,
			liveStateRef.current.invalidationEpoch,
		);
		if (!stamp) return;
		refreshStampsRef.current.set(resourceKey(stamp.resource), stamp);
		setRefreshStampRevision((value) => value + 1);
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
				if (!cancelled) setBoot({ status: "failed", error });
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
			clearRefreshStamps();
			try {
				await queryClient.refetchQueries({ type: "active" });
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
		const degradeToPolling = () => {
			streamOpen = false;
			dispatchLiveEvent({
				type: "stream-disconnected",
				at: Date.now(),
			});
			schedulePolling();
		};
		eventSource.onopen = () => {
			streamOpen = true;
			stopPolling();
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
				dispatchLiveEvent({
					type: "reset-required",
					at: frame.observedAt,
				});
				clearRefreshStamps();
				return;
			}
			if (frame.type === "checkpoint") {
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
				if (frame.projectId && frame.controlDomainId) {
					clearRefreshStamps((stamp) => {
						if (stamp.resource.type === "reservation") return false;
						return (
							stamp.resource.projectId === frame.projectId &&
							stamp.resource.controlDomainId === frame.controlDomainId
						);
					});
				} else {
					clearRefreshStamps();
				}
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
		clearRefreshStamps,
		dispatchLiveEvent,
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
	const endSession = useCallback(
		(scope: "current" | "all") => {
			csrfRef.current = undefined;
			setCsrfToken(undefined);
			clearRefreshStamps();
			void queryClient.cancelQueries();
			queryClient.clear();
			liveStateRef.current = INITIAL_WEB_LIVE_STATE;
			setLiveState(INITIAL_WEB_LIVE_STATE);
			setBoot({ status: "terminated", scope });
		},
		[clearRefreshStamps, queryClient],
	);
	const refreshStampFor = useCallback(
		(resource: WebAuthoritativeResourceIdentity) =>
			refreshStampsRef.current.get(resourceKey(resource)),
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
