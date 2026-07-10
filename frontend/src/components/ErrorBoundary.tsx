import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  fallbackTitle: string;
  fallbackHint: string;
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
