import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { AppProvider } from "./app-context.tsx";
import { router } from "./router.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("Taskflow application root is missing");

createRoot(root).render(
	<StrictMode>
		<AppProvider>
			<RouterProvider router={router} />
		</AppProvider>
	</StrictMode>,
);
