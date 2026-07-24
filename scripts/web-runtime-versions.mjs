export const WEB_NODE_MATRIX_VERSIONS = Object.freeze([
	"22.19.0",
	"24.18.0",
	"26.5.0",
]);

export const WEB_PRIMARY_NODE_VERSION = "24.18.0";

if (
	!WEB_NODE_MATRIX_VERSIONS.includes(
		WEB_PRIMARY_NODE_VERSION,
	)
) {
	throw new TypeError(
		"The primary Web runtime must be present in the pinned Node matrix.",
	);
}
