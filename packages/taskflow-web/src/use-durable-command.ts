import { useCallback, useEffect, useRef, useState } from "react";
import {
	WebClientFailureError,
	type WebCommandOutcome,
	type WebCommandRequest,
	type WebGeneratedClient,
} from "taskflow-control/web-protocol";

export type WebCommandRequestBase =
	WebCommandRequest extends infer Command
		? Command extends WebCommandRequest
			? Omit<Command, "commandId">
			: never
		: never;

export type DurableCommandState =
	| { readonly status: "idle" }
	| {
			readonly status: "submitting" | "checking";
			readonly commandId: string;
			readonly request?: WebCommandRequest;
	  }
	| {
			readonly status: "recorded";
			readonly commandId: string;
			readonly request?: WebCommandRequest;
			readonly outcome: Extract<
				WebCommandOutcome,
				{ status: "pending" }
			>;
	  }
	| {
			readonly status: "unknown";
			readonly commandId: string;
			readonly request?: WebCommandRequest;
	  }
	| {
			readonly status: "failed";
			readonly commandId: string;
			readonly request: WebCommandRequest;
			readonly error: unknown;
	  }
	| {
			readonly status: "settled";
			readonly commandId: string;
			readonly outcome: Exclude<
				WebCommandOutcome,
				{ status: "pending" | "not-found" }
			>;
	  };

function commandIdFromLocation(): string | undefined {
	const value = new URLSearchParams(window.location.search).get("op");
	return value && /^[A-Za-z0-9_-]{1,128}$/u.test(value)
		? value
		: undefined;
}

function setLocationCommandId(commandId: string | undefined): void {
	const url = new URL(window.location.href);
	if (commandId) url.searchParams.set("op", commandId);
	else url.searchParams.delete("op");
	window.history.replaceState(
		window.history.state,
		"",
		`${url.pathname}${url.search}`,
	);
}

export function useDurableCommand({
	client,
	onSettled,
}: {
	readonly client: WebGeneratedClient;
	readonly onSettled: () => void | Promise<void>;
}): {
	readonly state: DurableCommandState;
	readonly isPending: boolean;
	readonly execute: (request: WebCommandRequestBase) => Promise<void>;
	readonly checkAgain: () => Promise<void>;
	readonly retrySame: () => Promise<void>;
	readonly dismiss: () => void;
} {
	const [state, setState] = useState<DurableCommandState>({
		status: "idle",
	});
	const stateRef = useRef(state);
	const onSettledRef = useRef(onSettled);
	const mountedRef = useRef(true);
	stateRef.current = state;
	onSettledRef.current = onSettled;

	useEffect(
		() => () => {
			mountedRef.current = false;
		},
		[],
	);

	const settle = useCallback(
		async (
			commandId: string,
			request: WebCommandRequest | undefined,
			outcome: WebCommandOutcome,
		): Promise<void> => {
			if (!mountedRef.current) return;
			if (outcome.status === "not-found") {
				setState({ status: "unknown", commandId, request });
				return;
			}
			if (outcome.status === "pending") {
				setState({
					status: "recorded",
					commandId,
					request,
					outcome,
				});
				return;
			}
			setLocationCommandId(undefined);
			setState({ status: "settled", commandId, outcome });
			await onSettledRef.current();
		},
		[],
	);

	const inspect = useCallback(
		async (
			commandId: string,
			request?: WebCommandRequest,
		): Promise<void> => {
			if (mountedRef.current) {
				setState({ status: "checking", commandId, request });
			}
			try {
				const outcome = await client.command({
					params: { commandId },
					query: {},
					body: {},
				});
				await settle(commandId, request, outcome);
			} catch {
				if (mountedRef.current) {
					setState({ status: "unknown", commandId, request });
				}
			}
		},
		[client, settle],
	);

	const submit = useCallback(
		async (request: WebCommandRequest): Promise<void> => {
			setLocationCommandId(request.commandId);
			if (mountedRef.current) {
				setState({
					status: "submitting",
					commandId: request.commandId,
					request,
				});
			}
			try {
				const outcome = await client.commands({
					params: {},
					query: {},
					body: request,
				});
				await settle(request.commandId, request, outcome);
			} catch (error) {
				if (
					error instanceof WebClientFailureError &&
					error.failure.error.sideEffects === "none"
				) {
					setLocationCommandId(undefined);
					if (mountedRef.current) {
						setState({
							status: "failed",
							commandId: request.commandId,
							request,
							error,
						});
					}
					return;
				}
				await inspect(request.commandId, request);
			}
		},
		[client, inspect, settle],
	);

	const execute = useCallback(
		async (request: WebCommandRequestBase): Promise<void> => {
			await submit({
				...request,
				commandId: `web-${crypto.randomUUID()}`,
			} as WebCommandRequest);
		},
		[submit],
	);

	const checkAgain = useCallback(async (): Promise<void> => {
		const current = stateRef.current;
		if (
			current.status !== "checking" &&
			current.status !== "recorded" &&
			current.status !== "unknown"
		) {
			return;
		}
		await inspect(current.commandId, current.request);
	}, [inspect]);

	const retrySame = useCallback(async (): Promise<void> => {
		const current = stateRef.current;
		if (current.status !== "unknown" || !current.request) return;
		await submit(current.request);
	}, [submit]);

	const dismiss = useCallback(() => {
		const current = stateRef.current;
		if (
			current.status === "submitting" ||
			current.status === "checking"
		) {
			return;
		}
		if (
			current.status !== "recorded" &&
			current.status !== "unknown"
		) {
			setLocationCommandId(undefined);
		}
		setState({ status: "idle" });
	}, []);

	useEffect(() => {
		const commandId = commandIdFromLocation();
		if (!commandId) return;
		void inspect(commandId);
	}, [inspect]);

	return {
		state,
		isPending:
			state.status === "submitting" ||
			state.status === "checking",
		execute,
		checkAgain,
		retrySame,
		dismiss,
	};
}
