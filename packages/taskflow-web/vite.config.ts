import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	build: {
		outDir: "dist/app",
		emptyOutDir: false,
		sourcemap: false,
		cssCodeSplit: true,
		assetsDir: "assets",
		rolldownOptions: {
			output: {
				entryFileNames: "assets/app-[hash].js",
				chunkFileNames: "assets/chunk-[hash].js",
				assetFileNames: "assets/[name]-[hash][extname]",
				codeSplitting: {
					groups: [
						{
							name: "typebox",
							test: /node_modules[\\/]typebox[\\/]/,
							priority: 50,
						},
						{
							name: "react-runtime",
							test:
								/node_modules[\\/](?:react|react-dom|scheduler|use-sync-external-store)[\\/]/,
							priority: 40,
						},
						{
							name: "tanstack",
							test: /node_modules[\\/]@tanstack[\\/]/,
							priority: 30,
						},
						{
							name: "react-aria",
							test:
								/node_modules[\\/](?:react-aria|react-aria-components|react-stately|@react-aria|@react-stately)[\\/]/,
							priority: 20,
						},
						{
							name: "icons",
							test: /node_modules[\\/]lucide-react[\\/]/,
							priority: 10,
						},
					],
				},
			},
		},
	},
	server: {
		host: "127.0.0.1",
		port: 4174,
	},
});
