export type WebSessionEndScope = "current" | "all";

export type WebSessionLifecycleState = {
	readonly pendingScope?: WebSessionEndScope;
	readonly terminatedScope?: WebSessionEndScope;
};

export type WebSessionLifecycleEvent =
	| {
			readonly type: "termination-started";
			readonly scope: WebSessionEndScope;
	  }
	| {
			readonly type: "termination-cancelled";
			readonly scope: WebSessionEndScope;
	  }
	| {
			readonly type: "termination-succeeded";
			readonly scope: WebSessionEndScope;
	  }
	| { readonly type: "unauthorized" };

export const INITIAL_WEB_SESSION_LIFECYCLE_STATE: WebSessionLifecycleState =
	Object.freeze({});

/**
 * A bootstrap request can observe 401 and notify the session reducer before
 * its rejected promise reaches the boot catch. The terminal session screen is
 * authoritative and must not be overwritten by a generic boot failure.
 */
export function shouldSurfaceWebBootFailure(
	state: WebSessionLifecycleState,
): boolean {
	return state.terminatedScope === undefined;
}

export function reduceWebSessionLifecycle(
	state: WebSessionLifecycleState,
	event: WebSessionLifecycleEvent,
): WebSessionLifecycleState {
	switch (event.type) {
		case "termination-started":
			return {
				...state,
				pendingScope: event.scope,
			};
		case "termination-cancelled":
			if (state.pendingScope !== event.scope) return state;
			return {
				...(state.terminatedScope
					? {
							terminatedScope:
								state.terminatedScope,
						}
					: {}),
			};
		case "termination-succeeded":
			return {
				terminatedScope:
					state.terminatedScope === "all"
						? "all"
						: event.scope,
			};
		case "unauthorized":
			return {
				terminatedScope:
					state.terminatedScope === "all"
						? "all"
						: "current",
			};
	}
}
