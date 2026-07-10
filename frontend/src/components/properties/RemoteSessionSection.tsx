import { memo } from "react";
import type { Dataset, RenderSession } from "../../types";
import { useMessages } from "../../i18n-context";

interface Props {
  dataset: Dataset | null;
  remoteAvailable: boolean;
  remoteSession: RenderSession | null;
  remotePending: boolean;
  onStartRemote: () => void;
  onStopRemote: () => void;
}

export const RemoteSessionSection = memo(function RemoteSessionSection({
  dataset,
  remoteAvailable,
  remoteSession,
  remotePending,
  onStartRemote,
  onStopRemote,
}: Props) {
  const messages = useMessages();
  return (
    <>
      <h3>{messages.properties.remoteSession}</h3>
      <div className="display-controls">
        {!remoteAvailable ? (
          <p className="muted">{messages.properties.remoteSessionUnavailable}</p>
        ) : remoteSession ? (
          <>
            <p>
              {messages.properties.remoteSessionActive}
              {" · "}
              {new Date(remoteSession.expires_at).toLocaleString()}
            </p>
            <button disabled={remotePending} onClick={onStopRemote}>
              {messages.properties.remoteSessionStop}
            </button>
          </>
        ) : (
          <button disabled={remotePending || !dataset} onClick={onStartRemote}>
            {messages.properties.remoteSessionStart}
          </button>
        )}
      </div>
    </>
  );
});
