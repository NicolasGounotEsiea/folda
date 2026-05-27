import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./index.css";
import "highlight.js/styles/github-dark.css";
import { logError } from "./utils/errorLog";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    logError(
      error.message,
      (error.stack ?? "") + "\n--- Component Stack ---\n" + (info.componentStack ?? ""),
    );
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-surface-0 text-text-primary p-8">
          <p className="text-[15px] font-semibold">Something went wrong</p>
          <p className="text-[12px] text-text-muted text-center max-w-md font-mono">
            {this.state.error.message}
          </p>
          <p className="text-[11px] text-text-muted text-center max-w-md">
            The error has been saved to the local log file (Settings → About → Open log file).
          </p>
          <button
            onClick={() => this.setState({ error: null })}
            className="px-4 py-1.5 rounded bg-accent text-white text-[12px] hover:bg-accent/80"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
