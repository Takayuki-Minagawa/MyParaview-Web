/** Shared VTK XML DataArray decoding for the browser-native readers.
 *
 * Supported encodings intentionally match the direct VTU reader: ASCII,
 * inline base64 binary, and raw appended data. UInt32/UInt64 headers and the
 * vtkZLibDataCompressor block layout are accepted, with little-endian byte
 * order only. Format-specific parsers remain responsible for topology.
 */

type TypedArray =
  | Float32Array | Float64Array
  | Int8Array | Int16Array | Int32Array
  | Uint8Array | Uint16Array | Uint32Array;

const VTK_TYPE_BYTES: Record<string, number> = {
  Int8: 1, UInt8: 1, Int16: 2, UInt16: 2, Int32: 4, UInt32: 4,
  Int64: 8, UInt64: 8, Float32: 4, Float64: 8,
};

export interface VtkXmlParserContext {
  fileType: string;
  headerType: "UInt32" | "UInt64";
  compressed: boolean;
  appended: Uint8Array | null;
}

export interface ParsedVtkXml {
  document: Document;
  vtkFile: Element;
  context: VtkXmlParserContext;
}

function indexOfSequence(bytes: Uint8Array, text: string, from = 0): number {
  const target = Array.from(text, (character) => character.charCodeAt(0));
  outer: for (let index = from; index <= bytes.length - target.length; index += 1) {
    for (let offset = 0; offset < target.length; offset += 1) {
      if (bytes[index + offset] !== target[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("zlib-compressed VTK XML requires DecompressionStream support");
  }
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readHeaderInts(
  bytes: Uint8Array,
  count: number,
  headerType: VtkXmlParserContext["headerType"],
): number[] {
  const headerBytes = VTK_TYPE_BYTES[headerType];
  if (bytes.byteLength < count * headerBytes) {
    throw new Error("truncated VTK XML binary header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(
      headerType === "UInt64"
        ? Number(view.getBigUint64(index * 8, true))
        : view.getUint32(index * 4, true),
    );
  }
  return values;
}

/** Decode one storage blob: [header][payload], zlib multi-block when compressed. */
async function decodeBlock(
  bytes: Uint8Array,
  headerType: VtkXmlParserContext["headerType"],
  compressed: boolean,
): Promise<Uint8Array> {
  const headerBytes = VTK_TYPE_BYTES[headerType];
  if (!compressed) {
    const [byteCount] = readHeaderInts(bytes, 1, headerType);
    if (bytes.byteLength < headerBytes + byteCount) {
      throw new Error("truncated VTK XML binary payload");
    }
    return bytes.subarray(headerBytes, headerBytes + byteCount);
  }
  const [blockCount] = readHeaderInts(bytes, 1, headerType);
  if (blockCount < 1) throw new Error("invalid VTK XML compressed block count");
  const header = readHeaderInts(bytes, 3 + blockCount, headerType);
  const [, blockSize, lastBlockSize] = header;
  const compressedSizes = header.slice(3);
  let cursor = headerBytes * (3 + blockCount);
  const output = new Uint8Array(
    blockSize * (blockCount - 1) + (lastBlockSize || blockSize),
  );
  let written = 0;
  for (let index = 0; index < blockCount; index += 1) {
    const compressedSize = compressedSizes[index];
    if (bytes.byteLength < cursor + compressedSize) {
      throw new Error("truncated VTK XML compressed payload");
    }
    const chunk = await inflate(bytes.subarray(cursor, cursor + compressedSize));
    output.set(chunk, written);
    written += chunk.length;
    cursor += compressedSize;
  }
  return output.subarray(0, written);
}

/** Base64 inline content with compression stores header and payload as two
 * separately encoded streams; without compression it is a single stream. */
async function decodeInline(
  text: string,
  headerType: VtkXmlParserContext["headerType"],
  compressed: boolean,
): Promise<Uint8Array> {
  const cleaned = text.replace(/\s+/g, "");
  if (!cleaned) throw new Error("empty VTK XML binary DataArray");
  if (!compressed) return decodeBlock(base64ToBytes(cleaned), headerType, false);
  const headerBytes = VTK_TYPE_BYTES[headerType];
  const firstChunkChars = 4 * Math.ceil(headerBytes / 3);
  const [blockCount] = readHeaderInts(
    base64ToBytes(cleaned.slice(0, firstChunkChars)), 1, headerType,
  );
  const fullHeaderChars = 4 * Math.ceil((headerBytes * (3 + blockCount)) / 3);
  const header = base64ToBytes(cleaned.slice(0, fullHeaderChars));
  const payload = base64ToBytes(cleaned.slice(fullHeaderChars));
  const joined = new Uint8Array(header.length + payload.length);
  joined.set(header, 0);
  joined.set(payload, header.length);
  return decodeBlock(joined, headerType, true);
}

function bytesToTyped(bytes: Uint8Array, type: string): TypedArray {
  const byteWidth = VTK_TYPE_BYTES[type];
  if (!byteWidth) throw new Error(`unsupported VTK XML data type ${type}`);
  if (bytes.byteLength % byteWidth !== 0) {
    throw new Error(`misaligned ${type} VTK XML DataArray payload`);
  }
  // Copy to an aligned buffer: appended subarray offsets are not guaranteed aligned.
  const copy = bytes.slice();
  switch (type) {
    case "Float32": return new Float32Array(copy.buffer);
    case "Float64": return new Float64Array(copy.buffer);
    case "Int8": return new Int8Array(copy.buffer);
    case "UInt8": return copy;
    case "Int16": return new Int16Array(copy.buffer);
    case "UInt16": return new Uint16Array(copy.buffer);
    case "Int32": return new Int32Array(copy.buffer);
    case "UInt32": return new Uint32Array(copy.buffer);
    case "Int64": {
      const big = new BigInt64Array(copy.buffer);
      const values = new Float64Array(big.length);
      for (let index = 0; index < big.length; index += 1) values[index] = Number(big[index]);
      return values;
    }
    case "UInt64": {
      const big = new BigUint64Array(copy.buffer);
      const values = new Float64Array(big.length);
      for (let index = 0; index < big.length; index += 1) values[index] = Number(big[index]);
      return values;
    }
    default:
      throw new Error(`unsupported VTK XML data type ${type}`);
  }
}

/** Split the XML envelope from an optional raw-appended binary tail and build
 * a validated decoder context for a format-specific parser. */
export function parseVtkXmlDocument(
  buffer: ArrayBuffer,
  expectedTypes: string | readonly string[],
): ParsedVtkXml {
  const bytes = new Uint8Array(buffer);
  let appended: Uint8Array | null = null;
  let xmlText: string;
  const appendedTag = indexOfSequence(bytes, "<AppendedData");
  if (appendedTag >= 0) {
    const window = new TextDecoder().decode(
      bytes.subarray(appendedTag, Math.min(appendedTag + 200, bytes.length)),
    );
    const encoding = /encoding="([^"]+)"/.exec(window)?.[1] ?? "raw";
    if (encoding !== "raw") {
      throw new Error("base64-encoded AppendedData is not supported; use raw or inline binary");
    }
    const underscore = indexOfSequence(bytes, "_", appendedTag);
    if (underscore < 0) throw new Error("malformed AppendedData section");
    appended = bytes.subarray(underscore + 1);
    xmlText = `${new TextDecoder().decode(bytes.subarray(0, appendedTag))}</VTKFile>`;
  } else {
    xmlText = new TextDecoder().decode(bytes);
  }

  const document = new DOMParser().parseFromString(xmlText, "application/xml");
  const parserError = document.querySelector("parsererror");
  if (parserError) throw new Error("malformed VTK XML document");
  const vtkFile = document.querySelector("VTKFile");
  const accepted = typeof expectedTypes === "string" ? [expectedTypes] : expectedTypes;
  const fileType = vtkFile?.getAttribute("type") ?? "";
  if (!vtkFile || !accepted.includes(fileType)) {
    throw new Error(`expected ${accepted.join(" or ")} VTK XML, received ${fileType || "unknown"}`);
  }
  if ((vtkFile.getAttribute("byte_order") ?? "LittleEndian") !== "LittleEndian") {
    throw new Error("big-endian VTK XML files are not supported");
  }
  const compressor = vtkFile.getAttribute("compressor") ?? "";
  if (compressor && compressor !== "vtkZLibDataCompressor") {
    throw new Error(`unsupported VTK XML compressor ${compressor}`);
  }
  const headerType = vtkFile.getAttribute("header_type") ?? "UInt32";
  if (headerType !== "UInt32" && headerType !== "UInt64") {
    throw new Error(`unsupported VTK XML header type ${headerType}`);
  }
  return {
    document,
    vtkFile,
    context: {
      fileType,
      headerType,
      compressed: !!compressor,
      appended,
    },
  };
}

/** Decode one XML DataArray to the numeric representation used by the
 * topology parsers. */
export async function readVtkDataArray(
  element: Element,
  context: VtkXmlParserContext,
): Promise<Float64Array> {
  const type = element.getAttribute("type") ?? "Float64";
  const format = element.getAttribute("format") ?? "ascii";
  if (format === "ascii") {
    const parts = (element.textContent ?? "").trim().split(/\s+/).filter(Boolean);
    const values = new Float64Array(parts.length);
    for (let index = 0; index < parts.length; index += 1) {
      // Preserve the VTU reader's permissive handling of NaN/Inf simulation
      // values; scalar range/color code already ignores non-finite tuples.
      values[index] = Number(parts[index]);
    }
    return values;
  }
  let raw: Uint8Array;
  if (format === "binary") {
    raw = await decodeInline(element.textContent ?? "", context.headerType, context.compressed);
  } else if (format === "appended") {
    if (!context.appended) {
      throw new Error(`${context.fileType} references appended data but none is present`);
    }
    const offset = Number(element.getAttribute("offset") ?? "0");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= context.appended.length) {
      throw new Error(`invalid ${context.fileType} appended-data offset`);
    }
    raw = await decodeBlock(
      context.appended.subarray(offset), context.headerType, context.compressed,
    );
  } else {
    throw new Error(`unsupported ${context.fileType} DataArray format "${format}"`);
  }
  const typed = bytesToTyped(raw, type);
  return typed instanceof Float64Array ? typed : Float64Array.from(typed);
}
