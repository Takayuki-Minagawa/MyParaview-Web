import { memo, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { CameraState } from "../../types";
import { camerasEqual } from "../../lib/comparison";
import { useMessages } from "../../i18n-context";

interface Props {
  cameraState: CameraState | null;
  onApply: (camera: CameraState) => void;
  onResetCamera: () => void;
}

type Vector3 = [string, string, string];

interface Draft {
  position: Vector3;
  focal_point: Vector3;
  view_up: Vector3;
  parallel_scale: string;
  parallel_projection: boolean;
}

const AXES = ["X", "Y", "Z"] as const;

function format(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toPrecision(7))) : "";
}

function toDraft(camera: CameraState | null): Draft {
  return {
    position: camera ? camera.position.map(format) as Vector3 : ["", "", ""],
    focal_point: camera ? camera.focal_point.map(format) as Vector3 : ["", "", ""],
    view_up: camera ? camera.view_up.map(format) as Vector3 : ["", "", ""],
    parallel_scale: camera ? format(camera.parallel_scale) : "",
    parallel_projection: camera?.parallel_projection ?? false,
  };
}

function parseVector(values: Vector3): [number, number, number] | null {
  const parsed = values.map((value) => (value.trim() === "" ? NaN : Number(value)));
  return parsed.every(Number.isFinite) ? parsed as [number, number, number] : null;
}

/** Validate a numeric camera draft. Null when any field is unusable. */
export function parseCameraDraft(draft: Draft): CameraState | null {
  const position = parseVector(draft.position);
  const focalPoint = parseVector(draft.focal_point);
  const viewUp = parseVector(draft.view_up);
  const parallelScale = draft.parallel_scale.trim() === "" ? NaN : Number(draft.parallel_scale);
  if (!position || !focalPoint || !viewUp || !Number.isFinite(parallelScale)) return null;
  if (parallelScale <= 0) return null;
  if (Math.hypot(...viewUp) < 1e-12) return null;
  if (position.every((value, index) => value === focalPoint[index])) return null;
  return {
    position,
    focal_point: focalPoint,
    view_up: viewUp,
    parallel_scale: parallelScale,
    parallel_projection: draft.parallel_projection,
  };
}

export function cameraAsText(camera: CameraState): string {
  return [
    `position: ${camera.position.join(", ")}`,
    `focal_point: ${camera.focal_point.join(", ")}`,
    `view_up: ${camera.view_up.join(", ")}`,
    `parallel_scale: ${camera.parallel_scale}`,
    `parallel_projection: ${camera.parallel_projection ?? false}`,
  ].join("\n");
}

/** Numeric camera editor kept in sync with mouse interaction (feedback R-03). */
export const CameraSection = memo(function CameraSection({
  cameraState,
  onApply,
  onResetCamera,
}: Props) {
  const messages = useMessages();
  const errorId = useId();
  const [draft, setDraft] = useState<Draft>(() => toDraft(cameraState));
  const [invalid, setInvalid] = useState(false);
  const [copied, setCopied] = useState(false);

  // The viewer re-emits an identical camera on every scene load (e.g. each
  // playback frame); only a real change may overwrite what the user typed.
  const shownCameraRef = useRef(cameraState);
  useEffect(() => {
    if (camerasEqual(shownCameraRef.current, cameraState)) return;
    shownCameraRef.current = cameraState;
    setDraft(toDraft(cameraState));
    setInvalid(false);
  }, [cameraState]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = parseCameraDraft(draft);
    if (!next) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onApply(next);
  };

  const copy = () => {
    if (!cameraState) return;
    void navigator.clipboard?.writeText(cameraAsText(cameraState))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  };

  const vectorField = (key: "position" | "focal_point" | "view_up", label: string) => (
    <fieldset className="camera-vector">
      <legend>{label}</legend>
      <div className="camera-vector-inputs">
        {AXES.map((axis, index) => (
          <input
            key={axis}
            type="number"
            step="any"
            aria-label={`${label} ${axis}`}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            value={draft[key][index]}
            disabled={!cameraState}
            onChange={(event) => setDraft((current) => {
              const vector = [...current[key]] as Vector3;
              vector[index] = event.target.value;
              return { ...current, [key]: vector };
            })}
          />
        ))}
      </div>
    </fieldset>
  );

  return (
    <form className="camera-section" aria-label={messages.camera.title} onSubmit={submit}>
      <h3>{messages.camera.title}</h3>
      {!cameraState && <p className="muted">{messages.camera.noCamera}</p>}
      {vectorField("position", messages.camera.position)}
      {vectorField("focal_point", messages.camera.focalPoint)}
      {vectorField("view_up", messages.camera.viewUp)}
      <div className="camera-scalar">
        <label>
          <span>{messages.camera.parallelScale}</span>
          <input
            type="number"
            step="any"
            min={0}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            value={draft.parallel_scale}
            disabled={!cameraState}
            onChange={(event) => setDraft((current) => ({
              ...current,
              parallel_scale: event.target.value,
            }))}
          />
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={draft.parallel_projection}
            disabled={!cameraState}
            onChange={(event) => setDraft((current) => ({
              ...current,
              parallel_projection: event.target.checked,
            }))}
          />
          {messages.camera.parallelProjection}
        </label>
      </div>
      {invalid && (
        <p id={errorId} className="validation-error" role="alert">{messages.camera.invalid}</p>
      )}
      <div className="row">
        <button type="submit" disabled={!cameraState}>{messages.common.apply}</button>
        <button type="button" onClick={onResetCamera}>{messages.properties.resetCamera}</button>
        <button type="button" disabled={!cameraState} onClick={copy}>
          {copied ? messages.camera.copied : messages.common.copyText}
        </button>
      </div>
      <p className="muted">{messages.camera.applyHint} {messages.common.unitsUndefined}</p>
    </form>
  );
});
