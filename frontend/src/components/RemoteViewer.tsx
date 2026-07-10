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
  const [closed, setClosed] = useState(false);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const frameUrlRef = useRef<string | null>(null);
  // Superseded frame URLs are revoked only after the <img> finishes loading a
  // newer frame; revoking on arrival races the in-flight decode and flashes a
  // broken image under a sustained frame rate.
  const retiredUrlsRef = useRef<string[]>([]);

  const onFrameLoaded = () => {
    for (const url of retiredUrlsRef.current) URL.revokeObjectURL(url);
    retiredUrlsRef.current = [];
  };

  useEffect(() => {
    let disposed = false;
    const socket = new WebSocket(
      api.sessionWebSocketUrl(session.websocket_path),
      [session.websocket_protocol],
    );
    socket.binaryType = "blob";
    socket.onopen = () => {
      if (!disposed) {
        setConnected(true);
        setClosed(false);
      }
    };
    socket.onmessage = (event) => {
      if (disposed || !(event.data instanceof Blob)) return;
      const url = URL.createObjectURL(event.data);
      if (frameUrlRef.current) retiredUrlsRef.current.push(frameUrlRef.current);
      // Backstop if the <img> never fires load (e.g. hidden tab): keep the
      // retirement queue bounded rather than leaking blob URLs.
      while (retiredUrlsRef.current.length > 30) {
        URL.revokeObjectURL(retiredUrlsRef.current.shift()!);
      }
      frameUrlRef.current = url;
      setFrameUrl(url);
    };
    socket.onerror = () => {
      if (!disposed) onError(`${messages.viewer.renderError}: remote session socket error`);
    };
    socket.onclose = () => {
      if (!disposed) {
        setConnected(false);
        setClosed(true);
      }
    };
    return () => {
      disposed = true;
      socket.close();
      for (const url of retiredUrlsRef.current) URL.revokeObjectURL(url);
      retiredUrlsRef.current = [];
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
        <img
          className="remote-frame"
          src={frameUrl}
          alt={messages.properties.remoteSession}
          onLoad={onFrameLoaded}
          onError={onFrameLoaded}
        />
      ) : (
        <div className="viewer-overlay">
          {closed
            ? messages.properties.remoteSessionEnded
            : connected
              ? messages.properties.remoteSessionActive
              : messages.viewer.loading}
        </div>
      )}
      {closed && frameUrl && (
        <div className="viewer-overlay">{messages.properties.remoteSessionEnded}</div>
      )}
      <div className="remote-status">
        {messages.properties.remoteSession} ·{" "}
        {new Date(session.expires_at).toLocaleTimeString()}
      </div>
    </div>
  );
});
