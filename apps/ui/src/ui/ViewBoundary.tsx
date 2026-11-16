import { errorMessage } from "@tavi/contracts/util";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Failure } from "./Parts.js";
import { Button } from "./Button.js";

/**
 * A part of the page that throws while rendering (an owner answer it cannot
 * read, say) shows `fallback` — what failed, and a way to try again — in its
 * place instead of React unmounting the whole canvas to a blank page. A new
 * `resetOn` tries it again; `logAs` names it in the console. `onRetry` runs
 * just before each try again (a "Try again" or a new `resetOn`), for a child
 * that keeps a failure of its own to forget first.
 */
export class ErrorBoundary extends Component<
  {
    readonly children: ReactNode;
    readonly resetOn: unknown;
    readonly logAs: string;
    readonly onRetry?: (() => void) | undefined;
    readonly fallback: (failed: string, retry: () => void) => ReactNode;
  },
  { readonly failed: string | undefined }
> {
  override state: { readonly failed: string | undefined } = { failed: undefined };

  static getDerivedStateFromError(error: unknown): { readonly failed: string } {
    return { failed: errorMessage(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`tavi: ${this.props.logAs} could not be rendered`, error, info.componentStack);
  }

  override componentDidUpdate(previous: { readonly resetOn: unknown }): void {
    if (this.state.failed !== undefined && previous.resetOn !== this.props.resetOn) this.retry();
  }

  private readonly retry = (): void => {
    this.props.onRetry?.();
    this.setState({ failed: undefined });
  };

  override render(): ReactNode {
    const { failed } = this.state;
    return failed === undefined ? this.props.children : this.props.fallback(failed, this.retry);
  }
}

/**
 * A page's or a panel's own error boundary (`what` names it): the rest of the
 * shell stays usable, and moving elsewhere (`resetKey`) clears the failure.
 * `onRetry` runs before each try again.
 */
export function ViewBoundary({
  children,
  resetKey,
  what = "page",
  onRetry,
}: {
  readonly children: ReactNode;
  readonly resetKey: string;
  readonly what?: "page" | "panel" | "canvas";
  readonly onRetry?: (() => void) | undefined;
}) {
  return (
    <ErrorBoundary
      resetOn={resetKey}
      onRetry={onRetry}
      logAs={`a ${what}`}
      fallback={(failed, retry) => (
        <Failure>
          This {what} could not be shown ({failed}). <Button onClick={retry}>Try again</Button>
        </Failure>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
