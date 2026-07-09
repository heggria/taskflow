/** `taskflow-dsl new` skeleton generator. */

export function skeletonHello(name = "hello"): string {
	return `import { flow, agent } from "taskflow-dsl";

export default flow(${JSON.stringify(name)}, () => agent("Say hello to {args.name}"));
`;
}

export function skeletonJson(name = "hello"): string {
	return JSON.stringify(
		{
			name,
			phases: [
				{
					id: "main",
					type: "agent",
					agent: "executor",
					task: "Say hello to {args.name}",
					final: true,
				},
			],
		},
		null,
		2,
	) + "\n";
}
