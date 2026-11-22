import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Component, createRef, Suspense, type ReactElement, type ReactNode } from "react";

type LazyLoadErrorBoundaryProps = {
  readonly children: ReactNode;
  readonly description: string;
  readonly title: string;
  readonly onRetry?: () => void;
};

type LazyLoadErrorBoundaryState = {
  readonly hasError: boolean;
};

export class LazyLoadErrorBoundary extends Component<
  LazyLoadErrorBoundaryProps,
  LazyLoadErrorBoundaryState
> {
  public override readonly state: LazyLoadErrorBoundaryState = { hasError: false };
  private readonly recoveryRef = createRef<HTMLDivElement>();

  public static getDerivedStateFromError(): LazyLoadErrorBoundaryState {
    return { hasError: true };
  }

  public override componentDidMount(): void {
    if (this.state.hasError) {
      requestAnimationFrame(() => {
        this.focusRetry();
      });
    }
  }

  public override componentDidUpdate(
    _previousProps: LazyLoadErrorBoundaryProps,
    previousState: LazyLoadErrorBoundaryState,
  ): void {
    if (!previousState.hasError && this.state.hasError) {
      requestAnimationFrame(() => {
        this.focusRetry();
      });
    }
  }

  private retry(): void {
    try {
      if (this.props.onRetry === undefined) {
        window.location.reload();
      } else {
        this.props.onRetry();
      }
    } catch {
      this.focusRetry();
    }
  }

  private focusRetry(): void {
    this.recoveryRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }

  public override render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }
    return (
      <Banner
        aria-label={this.props.title}
        ref={this.recoveryRef}
        endContent={
          <Button
            label="Retry"
            variant="ghost"
            onClick={() => {
              this.retry();
            }}
          />
        }
        description={this.props.description}
        role="alert"
        status="error"
        title={this.props.title}
      />
    );
  }
}

export function CatalogueLoadBoundary({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  return (
    <LazyLoadErrorBoundary
      description="Reload the latest application files and try again."
      title="Catalogue could not be loaded"
    >
      <Suspense fallback={<p role="status">Loading catalogue…</p>}>{children}</Suspense>
    </LazyLoadErrorBoundary>
  );
}
