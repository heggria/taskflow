import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	act,
	cleanup,
	renderHook,
} from "@testing-library/react";
import { JSDOM } from "jsdom";
import {
	createElement,
	StrictMode,
	useEffect,
	type PropsWithChildren,
} from "react";
import type {
	WebBootstrapView,
	WebGeneratedClient,
	WebSessionView,
} from "taskflow-control/web-protocol";
import { useWebBootRequest } from "../src/web-boot.ts";

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalNavigator = globalThis.navigator;

function installDom(url: string): void {
	const dom = new JSDOM(
		"<!doctype html><html><body></body></html>",
		{ url },
	);
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: dom.window,
	});
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: dom.window.document,
	});
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: dom.window.navigator,
	});
}

afterEach(() => {
	cleanup();
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: originalWindow,
	});
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: originalDocument,
	});
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: originalNavigator,
	});
});

test("launch exchange is single-flight across StrictMode effect replay", async () => {
	const launchToken = "a".repeat(43);
	installDom(`http://127.0.0.1/#launch=${launchToken}`);
	let exchanges = 0;
	let bootstraps = 0;
	let releaseExchange:
		| (() => void)
		| undefined;
	const exchangeGate = new Promise<void>((resolve) => {
		releaseExchange = resolve;
	});
	const session = {
		csrfToken: "s".repeat(32),
		idleExpiresAt: 10_000,
		absoluteExpiresAt: 20_000,
		hostNonce: "a".repeat(26),
	} satisfies WebSessionView;
	const bootstrap = {
		csrfToken: "b".repeat(32),
	} as WebBootstrapView;
	const client = {
		async sessionExchange() {
			exchanges += 1;
			await exchangeGate;
			return session;
		},
		async bootstrap() {
			bootstraps += 1;
			return bootstrap;
		},
	} as unknown as Pick<
		WebGeneratedClient,
		"bootstrap" | "sessionExchange"
	>;
	const settled: WebSessionView[] = [];
	const wrapper = ({ children }: PropsWithChildren) =>
		createElement(StrictMode, null, children);

	renderHook(
		() => {
			const request = useWebBootRequest(client, 0);
			useEffect(() => {
				let disposed = false;
				void request().then((result) => {
					if (!disposed && result.session) {
						settled.push(result.session);
					}
				});
				return () => {
					disposed = true;
				};
			}, [request]);
		},
		{ wrapper },
	);
	assert.equal(window.location.hash, "");
	assert.equal(exchanges, 1);
	await act(async () => {
		releaseExchange?.();
		await exchangeGate;
	});
	await act(async () => {
		await new Promise<void>((resolve) =>
			window.setTimeout(resolve, 0),
		);
	});
	assert.equal(exchanges, 1);
	assert.equal(bootstraps, 1);
	assert.deepEqual(settled, [session]);
});
