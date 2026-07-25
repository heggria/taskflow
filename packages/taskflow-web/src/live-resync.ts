import type { QueryClient } from "@tanstack/react-query";

export async function refetchActiveWebQueries(
	queryClient: Pick<QueryClient, "refetchQueries">,
): Promise<void> {
	await queryClient.refetchQueries(
		{ type: "active" },
		{ throwOnError: true },
	);
}
