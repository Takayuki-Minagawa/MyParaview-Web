import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  fallbackTitle: string;
  fallbackHint: string;
  /** Changing this value clears a caught error, letting the user recover by
   * e.g. selecting another dataset instead of reloading the page. */
  resetKey?: string | number | null;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Keeps a render-time crash (typically inside the vtk.js viewer) from blanking the page. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("unhandled render error", error, info.componentStack);
  }

  componentDidUpdate(previousProps: Props) {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary" role="alert">
          <strong>{this.props.fallbackTitle}</strong>
          <pre>{String(this.state.error)}</pre>
          <p className="muted">{this.props.fallbackHint}</p>
        </div>
      );
    }
    return this.props.children;
  }
}
