import { memo } from "react";
import { useMessages } from "../../i18n-context";

interface Props {
  isClientExportable: boolean;
  onScreenshot: () => void;
  onClientExport: () => void;
  clientExportPending: boolean;
  onDownloadOriginal: () => void;
}

/** Actions for browser-local datasets. Everything here stays on the client:
 * screenshots and exports download to the user's device. */
export const LocalActionsSection = memo(function LocalActionsSection({
  isClientExportable,
  onScreenshot,
  onClientExport,
  clientExportPending,
  onDownloadOriginal,
}: Props) {
  const messages = useMessages();
  return (
    <section aria-label={messages.local.actions}>
      <h3>{messages.local.actions}</h3>
      <p className="muted">{messages.connection.processingBrowser}</p>
      <div className="row actions">
        <button type="button" onClick={onScreenshot}>{messages.properties.screenshot}</button>
        {isClientExportable && (
          <button type="button" disabled={clientExportPending} onClick={onClientExport}>
            {clientExportPending ? messages.common.running : messages.properties.clientExport}
          </button>
        )}
        <button type="button" onClick={onDownloadOriginal}>{messages.local.downloadOriginal}</button>
      </div>
      <p className="muted">{messages.local.localMetadataHint}</p>
      <p className="muted">{messages.local.serverSectionsHidden}</p>
    </section>
  );
});
