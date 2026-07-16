/** Screenshot composition: captured frame + optional legend overlay. */
import type { ColorMapName, ScalarSelection } from "../../types";
import { colorMapStops } from "../colormap";

export interface ScreenshotSettings {
  colorBy: ScalarSelection | null;
  colorRange: [number, number] | null;
  colorMap: ColorMapName;
  legendVisible: boolean;
}

export async function createScreenshotBlob(
  dataUrl: string,
  settings: ScreenshotSettings,
): Promise<Blob> {
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("captured image could not be decoded"));
  });
  image.src = dataUrl;
  await loaded;
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");
  context.drawImage(image, 0, 0);
  if (settings.legendVisible && settings.colorBy && settings.colorRange) {
    const width = Math.min(280, Math.max(180, canvas.width * 0.28));
    const x = canvas.width - width - 18;
    const y = canvas.height - 86;
    context.fillStyle = "rgba(15, 17, 23, 0.86)";
    context.fillRect(x, y, width, 68);
    context.fillStyle = "#f3f4f6";
    context.font = "12px system-ui, sans-serif";
    context.fillText(`${settings.colorBy.association} · ${settings.colorBy.name}`, x + 10, y + 18);
    const gradient = context.createLinearGradient(x + 10, 0, x + width - 10, 0);
    for (const stop of colorMapStops(settings.colorMap)) {
      const [r, g, b] = stop.rgb.map((value) => Math.round(value * 255));
      gradient.addColorStop(stop.position, `rgb(${r}, ${g}, ${b})`);
    }
    context.fillStyle = gradient;
    context.fillRect(x + 10, y + 26, width - 20, 12);
    context.fillStyle = "#f3f4f6";
    context.font = "10px ui-monospace, monospace";
    context.fillText(settings.colorRange[0].toPrecision(5), x + 10, y + 54);
    const maximum = settings.colorRange[1].toPrecision(5);
    context.fillText(maximum, x + width - 10 - context.measureText(maximum).width, y + 54);
  }
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG encoding failed")), "image/png"),
  );
}
