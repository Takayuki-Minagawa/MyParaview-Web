import type {
  ColorMapName,
  ColorMapStopDefinition,
  CustomColorMapDefinition,
  CustomColorMapName,
} from "../types";

export type { ColorMapName };
export type RGB = [number, number, number];
export type ColorStop = ColorMapStopDefinition;

export const MAX_CUSTOM_COLOR_MAP_STOPS = 4096;
export const MAX_REGISTERED_CUSTOM_COLOR_MAPS = 64;
const CUSTOM_COLOR_MAP_ID = /^custom:[A-Za-z0-9_.!~*'()%-]+:[a-z0-9]{1,16}$/;

const MAPS: Record<string, ColorStop[]> = {
  "cool-to-warm": [
    { position: 0, rgb: [0.23, 0.3, 0.75] },
    { position: 0.5, rgb: [0.87, 0.87, 0.87] },
    { position: 1, rgb: [0.71, 0.02, 0.15] },
  ],
  viridis: [
    { position: 0, rgb: [0.267, 0.005, 0.329] },
    { position: 0.25, rgb: [0.23, 0.322, 0.546] },
    { position: 0.5, rgb: [0.128, 0.567, 0.551] },
    { position: 0.75, rgb: [0.369, 0.789, 0.383] },
    { position: 1, rgb: [0.993, 0.906, 0.144] },
  ],
  grayscale: [
    { position: 0, rgb: [0.08, 0.08, 0.08] },
    { position: 1, rgb: [0.95, 0.95, 0.95] },
  ],
  plasma: [
    { position: 0, rgb: [0.05, 0.03, 0.528] },
    { position: 0.25, rgb: [0.494, 0.012, 0.658] },
    { position: 0.5, rgb: [0.798, 0.28, 0.47] },
    { position: 0.75, rgb: [0.973, 0.585, 0.252] },
    { position: 1, rgb: [0.94, 0.975, 0.131] },
  ],
  turbo: [
    { position: 0, rgb: [0.19, 0.072, 0.232] },
    { position: 0.25, rgb: [0.098, 0.708, 0.884] },
    { position: 0.5, rgb: [0.633, 0.991, 0.237] },
    { position: 0.75, rgb: [0.984, 0.49, 0.083] },
    { position: 1, rgb: [0.48, 0.016, 0.011] },
  ],
};

const CUSTOM_LABELS = new Map<CustomColorMapName, string>();
const RETAINED_CUSTOM_COLOR_MAPS = new Map<CustomColorMapName, number>();
const CUSTOM_COLOR_MAP_LISTENERS = new Set<() => void>();
let customColorMapRegistryVersion = 0;

function notifyCustomColorMapRegistryChanged(): void {
  customColorMapRegistryVersion += 1;
  for (const listener of CUSTOM_COLOR_MAP_LISTENERS) listener();
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function validatedStops(stops: readonly ColorStop[]): ColorStop[] {
  if (stops.length < 2 || stops.length > MAX_CUSTOM_COLOR_MAP_STOPS) {
    throw new Error(
      `A colormap requires between 2 and ${MAX_CUSTOM_COLOR_MAP_STOPS} stops`,
    );
  }
  const copied = stops.map((stop) => {
    if (
      !Number.isFinite(stop.position)
      || stop.position < 0
      || stop.position > 1
      || !Array.isArray(stop.rgb)
      || stop.rgb.length !== 3
      || stop.rgb.some((channel) => (
        !Number.isFinite(channel) || channel < 0 || channel > 1
      ))
    ) {
      throw new Error("Colormap positions and RGB channels must be finite values from 0 to 1");
    }
    return {
      position: stop.position,
      rgb: [...stop.rgb] as RGB,
    };
  });
  if (copied[0].position !== 0 || copied[copied.length - 1].position !== 1) {
    throw new Error("A colormap must start at position 0 and end at position 1");
  }
  if (copied.some((stop, index) => index > 0 && stop.position <= copied[index - 1].position)) {
    throw new Error("Colormap stop positions must be strictly increasing");
  }
  return copied;
}

/** Parse an untrusted embedded definition without mutating the registry. */
export function parseCustomColorMapDefinition(
  value: unknown,
): CustomColorMapDefinition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const definition = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(definition, ["id", "label", "stops"])
    || typeof definition.id !== "string"
    || definition.id.length > 1024
    || !CUSTOM_COLOR_MAP_ID.test(definition.id)
    || typeof definition.label !== "string"
  ) return null;
  const label = definition.label.trim();
  if (!label || label.length > 200 || !Array.isArray(definition.stops)) return null;
  if (definition.stops.some((stop) => (
    !stop
    || typeof stop !== "object"
    || Array.isArray(stop)
    || !hasOnlyKeys(stop as Record<string, unknown>, ["position", "rgb"])
  ))) return null;
  try {
    const stops = validatedStops(definition.stops as ColorStop[]);
    return {
      id: definition.id as CustomColorMapName,
      label,
      stops,
    };
  } catch {
    return null;
  }
}

export function customColorMapDefinition(
  id: ColorMapName,
): CustomColorMapDefinition | null {
  if (!id.startsWith("custom:") || !Object.prototype.hasOwnProperty.call(MAPS, id)) return null;
  const customId = id as CustomColorMapName;
  const label = CUSTOM_LABELS.get(customId);
  if (!label) return null;
  return {
    id: customId,
    label,
    stops: MAPS[id].map((stop) => ({
      position: stop.position,
      rgb: [...stop.rgb] as RGB,
    })),
  };
}

export function customColorMapDefinitionsEqual(
  left: CustomColorMapDefinition,
  right: CustomColorMapDefinition,
): boolean {
  return left.id === right.id
    && left.label === right.label
    && left.stops.length === right.stops.length
    && left.stops.every((stop, index) => (
      stop.position === right.stops[index]?.position
      && stop.rgb.every((channel, channelIndex) => (
        channel === right.stops[index]?.rgb[channelIndex]
      ))
    ));
}

function registeredStops(name: ColorMapName): ColorStop[] {
  const stops = MAPS[name];
  if (!stops) throw new Error(`Unknown colormap: ${name}`);
  return stops;
}

export function hasColorMap(name: unknown): name is ColorMapName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(MAPS, name);
}

/** Prevent a custom colormap used by a mounted viewer from being evicted. */
export function retainColorMap(name: ColorMapName): () => void {
  if (!name.startsWith("custom:")) return () => undefined;
  const id = name as CustomColorMapName;
  RETAINED_CUSTOM_COLOR_MAPS.set(id, (RETAINED_CUSTOM_COLOR_MAPS.get(id) ?? 0) + 1);
  return () => {
    const remaining = (RETAINED_CUSTOM_COLOR_MAPS.get(id) ?? 1) - 1;
    if (remaining > 0) RETAINED_CUSTOM_COLOR_MAPS.set(id, remaining);
    else RETAINED_CUSTOM_COLOR_MAPS.delete(id);
  };
}

export function registerCustomColorMap(
  id: CustomColorMapName,
  label: string,
  stops: readonly ColorStop[],
): boolean {
  if (id.length > 1024 || !CUSTOM_COLOR_MAP_ID.test(id)) {
    throw new Error("A custom colormap id has an invalid format");
  }
  const normalizedLabel = label.trim();
  if (!normalizedLabel || normalizedLabel.length > 200) {
    throw new Error("A custom colormap label must contain 1 to 200 characters");
  }
  const validated = validatedStops(stops);
  // Refresh existing entries in insertion order and bound memory for
  // long-lived tabs that open many embedded ViewStates. Mounted viewers retain
  // their active maps, so only entries that are not being rendered may leave.
  if (CUSTOM_LABELS.has(id)) CUSTOM_LABELS.delete(id);
  while (CUSTOM_LABELS.size >= MAX_REGISTERED_CUSTOM_COLOR_MAPS) {
    const oldestUnused = Array.from(CUSTOM_LABELS.keys()).find(
      (candidate) => !RETAINED_CUSTOM_COLOR_MAPS.has(candidate),
    );
    if (oldestUnused === undefined) {
      return false;
    }
    CUSTOM_LABELS.delete(oldestUnused);
    delete MAPS[oldestUnused];
  }
  MAPS[id] = validated;
  CUSTOM_LABELS.set(id, normalizedLabel);
  notifyCustomColorMapRegistryChanged();
  return true;
}

/** Subscribe UI snapshots to registration, refresh, and eviction changes. */
export function subscribeCustomColorMapRegistry(listener: () => void): () => void {
  CUSTOM_COLOR_MAP_LISTENERS.add(listener);
  return () => { CUSTOM_COLOR_MAP_LISTENERS.delete(listener); };
}

/** Stable scalar snapshot for React's useSyncExternalStore. */
export function getCustomColorMapRegistryVersion(): number {
  return customColorMapRegistryVersion;
}

export function registeredCustomColorMaps(): Array<{
  id: CustomColorMapName;
  label: string;
}> {
  return Array.from(CUSTOM_LABELS, ([id, label]) => ({ id, label }));
}

export function colorMapStops(name: ColorMapName): ColorStop[] {
  return registeredStops(name).map((stop) => ({ ...stop, rgb: [...stop.rgb] as RGB }));
}

export function colorMapCssGradient(name: ColorMapName): string {
  const stops = registeredStops(name).map(({ position, rgb }) => {
    const channel = rgb.map((value) => Math.round(value * 255)).join(", ");
    return `rgb(${channel}) ${Math.round(position * 100)}%`;
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/** Sample any registered colormap using piecewise-linear interpolation. */
export function sampleColorMap(name: ColorMapName, t: number): RGB {
  const x = Math.max(0, Math.min(1, t));
  const stops = registeredStops(name);
  const rightIndex = stops.findIndex((stop) => stop.position >= x);
  if (rightIndex <= 0) return [...stops[0].rgb] as RGB;
  const right = stops[rightIndex];
  const left = stops[rightIndex - 1];
  const width = right.position - left.position;
  const u = width > 0 ? (x - left.position) / width : 0;
  return left.rgb.map((value, index) => value + (right.rgb[index] - value) * u) as RGB;
}
