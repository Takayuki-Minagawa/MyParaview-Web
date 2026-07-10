import { memo, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { RenderSessionCreated } from "../types";
import { useMessages } from "../i18n-context";

interface Props {
  session: RenderSessionCreated;
  onError: (message: string) => void;
}

/** Connects to the backend's authenticated WebSocket proxy for a trame render
 * session. The wire format is defined by the deployed broker; binary frames
 * are displayed as images (the common trame image-streaming shape), other
 * traffic only drives the connection indicator. */
export const RemoteViewer = memo(function RemoteViewer({ session, onError }: Props) {
  const messages = useMessages();
  const [connected, setConnected] = useState(false);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const frameUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const socket = new WebSocket(
      api.sessionWebSocketUrl(session.websocket_path),
      [session.websocket_protocol],
    );
    socket.binaryType = "blob";
    socket.onopen = () => {
      if (!disposed) setConnected(true);
    };
    socket.onmessage = (event) => {
      if (disposed || !(event.data instanceof Blob)) return;
      const url = URL.createObjectURL(event.data);
      if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
      frameUrlRef.current = url;
      setFrameUrl(url);
    };
    socket.onerror = () => {
      if (!disposed) onError(`${messages.viewer.renderError}: remote session socket error`);
    };
    socket.onclose = () => {
      if (!disposed) setConnected(false);
    };
    return () => {
      disposed = true;
      socket.close();
      if (frameUrlRef.current) {
        URL.revokeObjectURL(frameUrlRef.current);
        frameUrlRef.current = null;
      }
    };
    // messages/onError are stable enough for the session lifetime; reconnect
    // only when the session itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  return (
    <div className="viewer remote-viewer">
      {frameUrl ? (
        <img className="remote-frame" src={frameUrl} alt={messages.properties.remoteSession} />
      ) : (
        <div className="viewer-overlay">
          {connected
            ? messages.properties.remoteSessionActive
            : messages.viewer.loading}
        </div>
      )}
      <div className="remote-status">
        {messages.properties.remoteSession} ·{" "}
        {new Date(session.expires_at).toLocaleTimeString()}
      </div>
    </div>
  );
});
