import { closeInspectorAndInstallSignalGuard } from "./server-secret-hardening.js";

// Imported first by the CLI entry point, before any command loads an instance .env file.
closeInspectorAndInstallSignalGuard();
