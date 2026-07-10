import { memo, useEffect, useRef, useState } from "react";
import type { AssistProposal, ColorMapName, Dataset, ScalarSelection } from "../../types";
import { api } from "../../api";
import type { Job } from "../../types";
import { useMessages } from "../../i18n-context";

const VALID_COLOR_MAPS: ColorMapName[] = [
  "cool-to-warm",
  "viridis",
  "grayscale",
  "plasma",
  "turbo",
];

interface Props {
  dataset: Dataset;
  serverFilterAvailable: boolean;
  filterPending: boolean;
  onColorBy: (selection: ScalarSelection | null) => void;
  onColorMap: (name: ColorMapName) => void;
  onJobCreated: (job: Job) => void;
  onError: (message: string) => void;
}

interface ProposalState {
  value: AssistProposal;
  datasetId: string;
  prompt: string;
}

export const AssistantSection = memo(function AssistantSection({
  dataset,
  serverFilterAvailable,
  filterPending,
  onColorBy,
  onColorMap,
  onJobCreated,
  onError,
}: Props) {
  const messages = useMessages();
  const [assistantPrompt, setAssistantPrompt] = useState("");
  const [assistantProposal, setAssistantProposal] = useState<ProposalState | null>(null);
  const [assistantPending, setAssistantPending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [assistantError, setAssistantError] = useState<string | null>(null);
  const assistantRequestRef = useRef(0);
  const datasetIdRef = useRef(dataset.id);
  const assistantPromptRef = useRef(assistantPrompt);
  datasetIdRef.current = dataset.id;
  assistantPromptRef.current = assistantPrompt;

  useEffect(() => {
    assistantRequestRef.current += 1;
    setAssistantPrompt("");
    setAssistantProposal(null);
    setAssistantPending(false);
    setApplying(false);
    setAssistantError(null);
  }, [dataset.id]);

  const applyProposal = (proposal: ProposalState) => {
    if (
      proposal.datasetId !== dataset.id ||
      proposal.prompt !== assistantPrompt.trim() ||
      !proposal.value.requires_confirmation
    ) return;
    if (proposal.value.action === "filter_job") {
      const proposalId = proposal.value.id;
      if (!proposalId || applying) return;
      setApplying(true);
      void api.applyProposal(proposalId)
        .then((job) => {
          onJobCreated(job);
          setAssistantProposal((current) => (current === proposal ? null : current));
        })
        .catch((e) => onError(String(e)))
        .finally(() => setApplying(false));
      return;
    }
    const color = proposal.value.params.color_by as Partial<ScalarSelection> | undefined;
    const map = proposal.value.params.color_map;
    if (
      color?.name &&
      (color.association === "point" || color.association === "cell")
    ) onColorBy(color as ScalarSelection);
    if (VALID_COLOR_MAPS.includes(map as ColorMapName)) {
      onColorMap(map as ColorMapName);
    }
    setAssistantProposal(null);
  };

  const dismissProposal = (proposal: ProposalState) => {
    const proposalId = proposal.value.id;
    if (!proposalId) return;
    void api.dismissProposal(proposalId).catch((e) => onError(String(e)));
    setAssistantProposal((current) => (current === proposal ? null : current));
  };

  return (
    <>
      <h3>{messages.properties.assistant}</h3>
      <div className="display-controls">
        <label>
          {messages.properties.assistantPrompt}
          <textarea
            rows={3}
            value={assistantPrompt}
            placeholder={messages.properties.assistantPlaceholder}
            onChange={(event) => {
              assistantRequestRef.current += 1;
              setAssistantPrompt(event.target.value);
              setAssistantProposal(null);
              setAssistantPending(false);
            }}
          />
        </label>
        <button
          disabled={assistantPending || !assistantPrompt.trim()}
          onClick={() => {
            const requestId = ++assistantRequestRef.current;
            const requestedDatasetId = dataset.id;
            const requestedPrompt = assistantPrompt.trim();
            setAssistantPending(true);
            setAssistantError(null);
            void api.proposeAssistance(requestedDatasetId, requestedPrompt)
              .then((value) => {
                if (
                  assistantRequestRef.current === requestId &&
                  datasetIdRef.current === requestedDatasetId &&
                  assistantPromptRef.current.trim() === requestedPrompt
                ) setAssistantProposal({ value, datasetId: requestedDatasetId, prompt: requestedPrompt });
              })
              .catch((reason) => {
                if (assistantRequestRef.current === requestId) setAssistantError(String(reason));
              })
              .finally(() => {
                if (assistantRequestRef.current === requestId) setAssistantPending(false);
              });
          }}
        >
          {assistantPending ? messages.properties.assistantPending : messages.properties.assistantCreate}
        </button>
        {assistantError && <p className="validation-error">{assistantError}</p>}
        {assistantProposal && (
          <div className="proposal-diff">
            <p>{assistantProposal.value.reason}</p>
            <pre>{JSON.stringify(assistantProposal.value.params, null, 2)}</pre>
            <div className="row">
              {assistantProposal.value.action !== "none" && assistantProposal.value.requires_confirmation && (
                <button
                  disabled={
                    assistantProposal.value.action === "filter_job" &&
                    (!serverFilterAvailable ||
                      filterPending ||
                      applying ||
                      !assistantProposal.value.id)
                  }
                  onClick={() => applyProposal(assistantProposal)}
                >
                  {messages.properties.applyProposal}
                </button>
              )}
              {assistantProposal.value.action !== "none" && assistantProposal.value.id && (
                <button onClick={() => dismissProposal(assistantProposal)}>
                  {messages.properties.dismissProposal}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
});
