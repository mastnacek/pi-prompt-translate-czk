// goal/index.ts — the goal slice barrel.
//
// The prototype patch is a process-wide resource, so its install/uninstall pair is
// the whole public surface; the translation logic behind it stays private to the
// slice.

export {
	installPromptInterceptor,
	uninstallPromptInterceptor,
} from "./interceptor.js";
