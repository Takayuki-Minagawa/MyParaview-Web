import { useCallback, useState } from "react";
import { api } from "../api";
import type { RenderSessionCreated } from "../types";
import type { ProjectScope } from "./useProjectScope";

interface Options {
  scope: ProjectScope;
  onError: (message: string) => void;
}

/** Owns the trame remote-render session lifecycle: start/stop plus the
 * cleanup rules for project switches and dataset re-selection. */
export function useRemoteSession({ scope, onError }: Options) {
  const [remoteSession, setRemoteSession] = useState<RenderSessionCreated | null>(null);
  const [remotePending, setRemotePending] = useState(false);

  const stopRemoteSession = useCallback((session: RenderSessionCreated | null) => {
    if (!session) return;
    void api.deleteSession(session.id).catch(() => {
      // best-effort: expiry cleans up server-side
    });
  }, []);

  /** Project switch invalidates the session unconditionally. */
  const clearOnProjectSwitch = useCallback(() => {
    setRemoteSession((session) => {
      stopRemoteSession(session);
      return null;
    });
  }, [stopRemoteSession]);

  /** A remote session streams the previous dataset; keeping it mounted would
   * leave the viewer showing stale content for the new selection. */
  const stopIfDatasetChanged = useCallback((datasetId: string) => {
    setRemoteSession((session) => {
      if (session && session.dataset_id !== datasetId) {
        stopRemoteSession(session);
        return null;
      }
      return session;
    });
  }, [stopRemoteSession]);

  const startRemote = useCallback(() => {
    const ticket = scope.capture();
    const datasetId = scope.selectedDatasetRef.current;
    if (!ticket || !datasetId || remotePending) return;
    setRemotePending(true);
    void api.createSession(ticket.projectId, datasetId)
      .then((session) => {
        if (ticket.stillCurrent()) setRemoteSession(session);
        else stopRemoteSession(session);
      })
      .catch((e) => {
        if (ticket.stillCurrent()) onError(String(e));
      })
      .finally(() => setRemotePending(false));
  }, [scope, remotePending, onError, stopRemoteSession]);

  const stopRemote = useCallback(() => {
    if (!remoteSession || remotePending) return;
    setRemotePending(true);
    void api.deleteSession(remoteSession.id)
      .catch((e) => onError(String(e)))
      .finally(() => {
        setRemoteSession(null);
        setRemotePending(false);
      });
  }, [remoteSession, remotePending, onError]);

  return {
    remoteSession,
    remotePending,
    startRemote,
    stopRemote,
    clearOnProjectSwitch,
    stopIfDatasetChanged,
  };
}
