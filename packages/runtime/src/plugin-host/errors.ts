import { TaviError } from "@tavi/contracts";

/** Typed failures raised by the plugin host itself. */
export class PluginHostError extends TaviError {
  constructor(
    code:
      | "DUPLICATE_PLUGIN"
      | "DUPLICATE_SERVICE"
      | "MISSING_DEPENDENCY"
      | "DEPENDENCY_CYCLE"
      | "STARTUP_FAILED"
      | "INTERNAL"
      | "INVALID_INPUT",
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, details === undefined ? {} : { details });
    this.name = "PluginHostError";
  }
}
