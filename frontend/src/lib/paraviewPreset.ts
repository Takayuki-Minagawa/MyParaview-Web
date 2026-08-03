import type { CustomColorMapDefinition, CustomColorMapName } from "../types";
import {
  MAX_CUSTOM_COLOR_MAP_STOPS,
  registerCustomColorMap,
  type ColorStop,
  type RGB,
} from "./colormap";

export type ImportedColorMapPreset = CustomColorMapDefinition;

function presetObject(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    if (value.length === 0) throw new Error("The preset array is empty");
    return presetObject(value[0]);
  }
  if (!value || typeof value !== "object") {
    throw new Error("The preset must be a JSON object or array");
  }
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.Presets)) return presetObject(object.Presets);
  return object;
}

function numericArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    throw new Error(`${field} must be an array of finite numbers`);
  }
  return value;
}

function validateRgb(rgb: number[], field: string): RGB {
  if (rgb.some((channel) => channel < 0 || channel > 1)) {
    throw new Error(`${field} RGB channels must be between 0 and 1`);
  }
  return [rgb[0], rgb[1], rgb[2]];
}

function rgbPointStops(value: unknown): ColorStop[] {
  const values = numericArray(value, "RGBPoints");
  if (values.length < 8 || values.length % 4 !== 0) {
    throw new Error("RGBPoints must contain at least two x/r/g/b entries");
  }
  if (values.length / 4 > MAX_CUSTOM_COLOR_MAP_STOPS) {
    throw new Error(`RGBPoints may contain at most ${MAX_CUSTOM_COLOR_MAP_STOPS} entries`);
  }
  const entries = Array.from({ length: values.length / 4 }, (_, index) => ({
    scalar: values[index * 4],
    rgb: validateRgb(values.slice(index * 4 + 1, index * 4 + 4), "RGBPoints"),
  })).sort((left, right) => left.scalar - right.scalar);
  const minimum = entries[0].scalar;
  const maximum = entries[entries.length - 1]?.scalar ?? minimum;
  if (minimum === maximum) throw new Error("RGBPoints scalar positions must span a range");
  if (entries.some((entry, index) => index > 0 && entry.scalar === entries[index - 1].scalar)) {
    throw new Error("RGBPoints scalar positions must be unique");
  }
  return entries.map((entry) => ({
    position: (entry.scalar - minimum) / (maximum - minimum),
    rgb: entry.rgb,
  }));
}

function indexedColorStops(value: unknown): ColorStop[] {
  const values = numericArray(value, "IndexedColors");
  if (values.length < 6 || values.length % 3 !== 0) {
    throw new Error("IndexedColors must contain at least two RGB entries");
  }
  const count = values.length / 3;
  if (count > MAX_CUSTOM_COLOR_MAP_STOPS) {
    throw new Error(`IndexedColors may contain at most ${MAX_CUSTOM_COLOR_MAP_STOPS} entries`);
  }
  return Array.from({ length: count }, (_, index) => ({
    position: index / (count - 1),
    rgb: validateRgb(values.slice(index * 3, index * 3 + 3), "IndexedColors"),
  }));
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function encodedIdPrefix(label: string): string {
  const prefix = Array.from(label).slice(0, 80).join("");
  return Array.from(new TextEncoder().encode(prefix), (byte) => {
    const character = String.fromCharCode(byte);
    return /^[A-Za-z0-9_.!~*'()-]$/.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

function fnv1a32(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function fnv1a64(source: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= BigInt(source.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36);
}

function presetId(label: string, stops: readonly ColorStop[]): CustomColorMapName {
  // Preserve IDs produced by the original implementation for ordinary labels.
  // Long labels need the full label in the hash because their visible prefix
  // can be identical; malformed surrogate input also takes the safe path.
  const legacyCompatible = label.length <= 80 && !hasUnpairedSurrogate(label);
  const source = legacyCompatible
    ? JSON.stringify(stops)
    : JSON.stringify([label, stops]);
  const hash = legacyCompatible ? fnv1a32(source) : fnv1a64(source);
  return `custom:${encodedIdPrefix(label)}:${hash}`;
}

export function parseParaViewColorMapPreset(text: string): ImportedColorMapPreset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The colormap preset is not valid JSON");
  }
  const object = presetObject(parsed);
  const rawName = object.Name ?? object.name;
  if (typeof rawName !== "string" || !rawName.trim() || rawName.trim().length > 200) {
    throw new Error("The colormap preset requires a Name of at most 200 characters");
  }
  const label = rawName.trim();
  const stops = object.RGBPoints !== undefined
    ? rgbPointStops(object.RGBPoints)
    : indexedColorStops(object.IndexedColors);
  return { id: presetId(label, stops), label, stops };
}

export function importParaViewColorMapPreset(text: string): ImportedColorMapPreset {
  const preset = parseParaViewColorMapPreset(text);
  if (!registerCustomColorMap(preset.id, preset.label, preset.stops)) {
    throw new Error("The custom colormap registry is full with maps currently in use");
  }
  return preset;
}
