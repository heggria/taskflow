import { type TUnsafe, Type } from "typebox";

/**
 * Creates a string enum schema compatible with Google's API and other providers
 * that don't support anyOf/const patterns. Vendored (8 lines) so taskflow-core
 * depends only on typebox, not on a host SDK.
 *
 * @example
 * const OperationSchema = StringEnum(["add", "subtract"], { description: "..." });
 * type Operation = Static<typeof OperationSchema>; // "add" | "subtract"
 */
export function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values as unknown as string[],
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}
