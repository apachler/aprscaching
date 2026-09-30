// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ErrorBoundary — the last line for an error thrown while rendering. Without it React unmounts the
 * whole tree and the user is left with an empty dark page; with it they see what broke, the error's
 * own message, and a Reload (ui-ux.md §1 "always feedback").
 */
import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./Button.js";
import { Card } from "./Card.js";

function CrashCard(props: { error: Error; onRetry: () => void }) {
  const [reloading, setReloading] = useState(false);
  return (
    <main className="crash">
      <Card className="crash-card" role="alert">
        <h1 className="crash-title">The app stopped with an error</h1>
        <p>Something on this page failed while drawing. Reloading usually fixes it.</p>
        <p className="mono crash-msg">{props.error.message || String(props.error)}</p>
        <div className="row gap-2">
          <Button
            variant="primary"
            disabled={reloading}
            onClick={() => {
              setReloading(true);
              location.reload();
            }}
          >
            {reloading ? "Reloading…" : "Reload"}
          </Button>
          <Button onClick={props.onRetry}>Try again</Button>
        </div>
      </Card>
    </main>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (this.state.error) return <CrashCard error={this.state.error} onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}
