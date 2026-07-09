import { useEffect, useRef, useState } from "react";
import type { Representation } from "../types";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import vtkXMLPolyDataReader from "@kitware/vtk.js/IO/XML/XMLPolyDataReader";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkColorTransferFunction from "@kitware/vtk.js/Rendering/Core/ColorTransferFunction";

const REPR_CODE: Record<Representation, number> = { points: 0, wireframe: 1, surface: 2 };

interface Props {
  url: string | null;
  datasetType?: string | null;
  representation: Representation;
  colorByArray: string | null;
  colorRange: [number, number] | null;
  /** bumped by the parent to request a screenshot download */
  screenshotNonce: number;
  /** bumped by the parent to request a camera reset */
  resetNonce: number;
}

// Browser-side rendering currently targets PolyData surfaces (work_plan 2.1).
const BROWSER_RENDERABLE = new Set(["PolyData"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyRepresentation(actor: any, representation: Representation) {
  actor.getProperty().setRepresentation(REPR_CODE[representation]);
  actor.getProperty().setEdgeVisibility(representation === "surface");
}

function applyColor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mapper: any,
  colorByArray: string | null,
  colorRange: [number, number] | null,
) {
  if (colorByArray && colorRange) {
    const lut = vtkColorTransferFunction.newInstance();
    lut.addRGBPoint(colorRange[0], 0.23, 0.3, 0.75);
    lut.addRGBPoint((colorRange[0] + colorRange[1]) / 2, 0.87, 0.87, 0.87);
    lut.addRGBPoint(colorRange[1], 0.71, 0.02, 0.15);
    mapper.setLookupTable(lut);
    mapper.setScalarModeToUsePointFieldData();
    mapper.setColorByArrayName(colorByArray);
    mapper.setScalarVisibility(true);
    mapper.setUseLookupTableScalarRange(true);
  } else {
    mapper.setScalarVisibility(false);
  }
}

export function VtkViewer({
  url,
  datasetType,
  representation,
  colorByArray,
  colorRange,
  screenshotNonce,
  resetNonce,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = useRef<any>(null);
  const [status, setStatus] = useState<string>("");

  // latest display settings, read by the async load without re-triggering it
  const displayRef = useRef({ representation, colorByArray, colorRange });
  displayRef.current = { representation, colorByArray, colorRange };

  const renderable = !!url && !!datasetType && BROWSER_RENDERABLE.has(datasetType);

  // Build the scene ONLY when the dataset (url/type) changes. Display-setting
  // changes are handled by the effects below without a rebuild or camera reset.
  useEffect(() => {
    if (!containerRef.current || !renderable || !url) return;
    let disposed = false;
    setStatus("読み込み中…");

    const grw = vtkGenericRenderWindow.newInstance({ background: [0.09, 0.11, 0.15] });
    grw.setContainer(containerRef.current);
    grw.resize();
    const renderer = grw.getRenderer();
    const renderWindow = grw.getRenderWindow();

    const reader = vtkXMLPolyDataReader.newInstance();
    const mapper = vtkMapper.newInstance();
    const actor = vtkActor.newInstance();
    actor.setMapper(mapper);
    ctx.current = { grw, renderer, renderWindow, actor, mapper };

    reader
      .setUrl(url)
      .then(() => {
        if (disposed) return;
        mapper.setInputConnection(reader.getOutputPort());
        // apply the current (possibly-changed-during-load) display settings
        const d = displayRef.current;
        applyRepresentation(actor, d.representation);
        applyColor(mapper, d.colorByArray, d.colorRange);
        renderer.addActor(actor);
        renderer.resetCamera(); // reset only on initial load of a dataset
        renderWindow.render();
        setStatus("");
      })
      .catch((err: unknown) => {
        if (!disposed) setStatus(`描画エラー: ${String(err)}`);
      });

    return () => {
      disposed = true;
      try {
        renderer.removeActor(actor);
        grw.delete();
      } catch {
        /* already torn down */
      }
      ctx.current = null;
    };
  }, [url, datasetType, renderable]);

  // representation change: mutate the actor in place, no rebuild / camera reset
  useEffect(() => {
    if (!ctx.current) return;
    applyRepresentation(ctx.current.actor, representation);
    ctx.current.renderWindow.render();
  }, [representation]);

  // color-by change: mutate the mapper in place
  useEffect(() => {
    if (!ctx.current) return;
    applyColor(ctx.current.mapper, colorByArray, colorRange);
    ctx.current.renderWindow.render();
  }, [colorByArray, colorRange]);

  // screenshot request
  useEffect(() => {
    if (!screenshotNonce || !ctx.current) return;
    ctx.current.renderWindow.captureImages().forEach((p: Promise<string>) =>
      p.then((dataUrl: string) => {
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = "screenshot.png";
        a.click();
      }),
    );
  }, [screenshotNonce]);

  // reset-camera request
  useEffect(() => {
    if (!resetNonce || !ctx.current) return;
    ctx.current.renderer.resetCamera();
    ctx.current.renderWindow.render();
  }, [resetNonce]);

  return (
    <div className="viewer">
      <div ref={containerRef} className="viewer-canvas" />
      {!renderable && (
        <div className="viewer-overlay">
          {url
            ? `「${datasetType}」はブラウザ直接描画の対象外です。サーバレンダリング（trame/VtkRemoteView）で表示する形式です。`
            : "データセットを選択してください。"}
        </div>
      )}
      {renderable && status && <div className="viewer-overlay">{status}</div>}
    </div>
  );
}
