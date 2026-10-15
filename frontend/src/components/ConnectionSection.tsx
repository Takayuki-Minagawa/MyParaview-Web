import { memo, useEffect, useId, useState, type FormEvent } from "react";
import { useMessages } from "../i18n-context";
import type { ServerConnection } from "../hooks/useServerConnection";

interface Props {
  connection: ServerConnection;
  /** Diagnostics payload (no user data) written to the clipboard. */
  buildDiagnostics: () => Record<string, unknown>;
}

export const ConnectionSection = memo(function ConnectionSection({
  connection,
  buildDiagnostics,
}: Props) {
  const t = useMessages();
  const inputId = useId();
  const helpId = useId();
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState(connection.suggestedApiBase);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setDraft(connection.suggestedApiBase);
  }, [connection.suggestedApiBase]);

  useEffect(() => {
    if (connection.status === "failed") setFormOpen(true);
  }, [connection.status]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void connection.connect(draft);
  };

  const copyDiagnostics = () => {
    const text = JSON.stringify(buildDiagnostics(), null, 2);
    void navigator.clipboard?.writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  };

  const statusText = {
    disconnected: t.connection.statusDisconnected,
    connecting: t.connection.statusConnecting,
    connected: t.connection.statusConnected,
    failed: t.connection.statusFailed,
  }[connection.status];
  const failureText = connection.failure
    ? connection.failure.kind === "invalid-url"
      ? t.connection.invalidApiBase
      : connection.failure.kind === "unreachable"
        ? t.connection.failureUnreachable
        : connection.failure.kind === "http"
          ? t.connection.failureHttp
          : connection.failure.kind === "timeout"
            ? t.connection.failureTimeout
            : t.connection.failureUnknown
    : null;
  const serverMode = connection.mode === "server";

  return (
    <section className="connection" aria-labelledby="connection-title">
      <h2 id="connection-title">{t.connection.title}</h2>
      <dl className="connection-summary">
        <div>
          <dt>{t.connection.modeLabel}</dt>
          <dd data-testid="connection-mode">
            {serverMode ? t.connection.modeServer : t.connection.modeStatic}
          </dd>
        </div>
        {serverMode && (
          <div>
            <dt>{t.connection.apiBaseLabel}</dt>
            <dd className="mono" data-testid="connection-api-base">{connection.apiBase ?? "-"}</dd>
          </div>
        )}
        <div>
          <dt>{t.connection.statusLabel}</dt>
          <dd role="status" data-testid="connection-status">{statusText}</dd>
        </div>
      </dl>
      {!serverMode && <p className="muted">{t.connection.staticHint}</p>}
      {failureText && (
        <div className="connection-failure" role="alert">
          <p>{failureText}</p>
          {connection.status !== "connected" && (
            <p className="muted">{t.connection.nextSteps}</p>
          )}
          {connection.failure?.detail && (
            <p className="muted mono connection-detail">
              {t.connection.detailLabel}: {connection.failure.detail}
            </p>
          )}
        </div>
      )}
      <div className="row connection-actions">
        {connection.status === "failed" && (
          <button type="button" onClick={() => void connection.retry()}>
            {t.common.retry}
          </button>
        )}
        {connection.status === "connected" && (
          <button type="button" onClick={connection.disconnect}>{t.common.disconnect}</button>
        )}
        <button
          type="button"
          aria-expanded={formOpen}
          aria-controls={`${inputId}-form`}
          onClick={() => setFormOpen((value) => !value)}
        >
          {formOpen ? t.connection.hideConnectForm : t.connection.showConnectForm}
        </button>
        <button type="button" onClick={copyDiagnostics} title={t.connection.diagnosticsHint}>
          {copied ? t.connection.diagnosticsCopied : t.connection.copyDiagnostics}
        </button>
      </div>
      {formOpen && (
        <form id={`${inputId}-form`} className="connection-form" onSubmit={submit}>
          <label htmlFor={inputId}>{t.connection.apiBaseLabel}</label>
          <p id={helpId} className="muted">{t.connection.connectHelp}</p>
          <div className="row">
            <input
              id={inputId}
              type="text"
              inputMode="url"
              aria-describedby={helpId}
              placeholder={t.connection.apiBasePlaceholder}
              value={draft}
              disabled={connection.status === "connecting"}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" disabled={connection.status === "connecting" || !draft.trim()}>
              {connection.status === "connecting" ? t.connection.statusConnecting : t.common.connect}
            </button>
          </div>
        </form>
      )}
    </section>
  );
});
