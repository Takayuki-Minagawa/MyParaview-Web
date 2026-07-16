/** Per-dataset-kind scene builders.
 *
 * Each builder fetches the dataset (with the caller's abort signal), creates
 * the reader/mapper/prop chain, and mutates the passed Scene in place. The
 * orchestration effect in VtkViewer owns lifecycle, camera, and color.
 */
import vtkXMLPolyDataReader from "@kitware/vtk.js/IO/XML/XMLPolyDataReader";
import vtkXMLImageDataReader from "@kitware/vtk.js/IO/XML/XMLImageDataReader";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import vtkPoints from "@kitware/vtk.js/Common/Core/Points";
import vtkCellArray from "@kitware/vtk.js/Common/Core/CellArray";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import vtkImageMapper from "@kitware/vtk.js/Rendering/Core/ImageMapper";
import vtkImageSlice from "@kitware/vtk.js/Rendering/Core/ImageSlice";
import vtkVolume from "@kitware/vtk.js/Rendering/Core/Volume";
import vtkVolumeMapper from "@kitware/vtk.js/Rendering/Core/VolumeMapper";
import vtkGlyph3DMapper from "@kitware/vtk.js/Rendering/Core/Glyph3DMapper";
import vtkSphereSource from "@kitware/vtk.js/Filters/Sources/SphereSource";
import type { ImageMode, SliceAxis, TableCoordinates } from "../../types";
import type { Messages } from "../../i18n";
import { authorizedFetch } from "../../api";
import { csvToPointData } from "../csvToPoints";
import { parseVtuSurface } from "../vtu";
import type { Scene, VtkDataSet, VtkMapper, VtkProp } from "./vtkTypes";
import { SLICE_MODE } from "./vtkTypes";

async function fetchOk(url: string, signal: AbortSignal): Promise<Response> {
  const response = await authorizedFetch(url, { signal });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response;
}

export function tableToPolyData(text: string, coordinates: TableCoordinates) {
  const parsed = csvToPointData(text, coordinates);
  const polyData = vtkPolyData.newInstance();
  const points = vtkPoints.newInstance();
  points.setData(parsed.points, 3);
  polyData.setPoints(points);
  const connectivity = new Uint32Array(parsed.numberOfPoints * 2);
  for (let index = 0; index < parsed.numberOfPoints; index += 1) {
    connectivity[index * 2] = 1;
    connectivity[index * 2 + 1] = index;
  }
  const verts = vtkCellArray.newInstance({ values: connectivity });
  polyData.setVerts(verts);
  for (const source of parsed.arrays) {
    polyData.getPointData().addArray(vtkDataArray.newInstance({
      name: source.name,
      numberOfComponents: 1,
      values: source.values,
    }));
  }
  return {
    output: polyData,
    invalidScalarCells: parsed.invalidScalarCells,
    skippedRows: parsed.skippedRows,
  };
}

export function csvDiagnostics(
  messages: Messages,
  invalidScalarCells: number,
  skippedRows: number,
): string {
  const parts: string[] = [];
  if (skippedRows > 0) {
    parts.push(
      `${messages.viewer.csvSkippedRowsPrefix}${skippedRows}${messages.viewer.csvSkippedRowsSuffix}`,
    );
  }
  if (invalidScalarCells > 0) {
    parts.push(
      `${messages.viewer.csvInvalidCellsPrefix}${invalidScalarCells}${messages.viewer.csvInvalidCellsSuffix}`,
    );
  }
  return parts.join(" ");
}

/** Fetch + parse a VTP into a standard actor/mapper chain. */
export async function buildPolyDataScene(
  scene: Scene,
  url: string,
  signal: AbortSignal,
  isDisposed: () => boolean,
): Promise<void> {
  const reader = vtkXMLPolyDataReader.newInstance();
  const mapper = vtkMapper.newInstance();
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  scene.reader = reader;
  // vtk.js upstream typings are partial; cast once where concrete instances
  // enter the Scene contract (see vtkTypes.ts).
  scene.mapper = mapper as unknown as VtkMapper;
  scene.prop = actor as unknown as VtkProp;
  const response = await fetchOk(url, signal);
  reader.parseAsArrayBuffer(await response.arrayBuffer());
  if (isDisposed()) return;
  scene.output = reader.getOutputData() as unknown as VtkDataSet;
  mapper.setInputConnection(reader.getOutputPort());
}

/** Fetch a VTU, extract its external surface, and build a polydata scene.
 * vtk.js has no UnstructuredGrid reader; lib/vtu.ts does the parsing. */
export async function buildUnstructuredScene(
  scene: Scene,
  url: string,
  messages: Messages,
  signal: AbortSignal,
  isDisposed: () => boolean,
): Promise<void> {
  const response = await fetchOk(url, signal);
  const surface = await parseVtuSurface(await response.arrayBuffer());
  if (isDisposed()) return;
  const polyData = vtkPolyData.newInstance();
  const points = vtkPoints.newInstance();
  points.setData(surface.points, 3);
  polyData.setPoints(points);
  if (surface.polys.length) {
    polyData.setPolys(vtkCellArray.newInstance({ values: surface.polys }));
  }
  if (surface.lines.length) {
    polyData.setLines(vtkCellArray.newInstance({ values: surface.lines }));
  }
  if (surface.verts.length) {
    polyData.setVerts(vtkCellArray.newInstance({ values: surface.verts }));
  }
  for (const array of surface.pointArrays) {
    polyData.getPointData().addArray(vtkDataArray.newInstance({
      name: array.name,
      numberOfComponents: array.numberOfComponents,
      values: array.values,
    }));
  }
  for (const array of surface.cellArrays) {
    polyData.getCellData().addArray(vtkDataArray.newInstance({
      name: array.name,
      numberOfComponents: array.numberOfComponents,
      values: array.values,
    }));
  }
  scene.dataDiagnostic =
    `${messages.viewer.vtuSurfacePrefix}${surface.polyCount}` +
    `${messages.viewer.vtuSurfaceInfix}${surface.sourceCellCount}` +
    messages.viewer.vtuSurfaceSuffix;
  const mapper = vtkMapper.newInstance();
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  mapper.setInputData(polyData);
  scene.mapper = mapper as unknown as VtkMapper;
  scene.prop = actor as unknown as VtkProp;
  scene.output = polyData as unknown as VtkDataSet;
  scene.createdOutput = true;
}

/** Fetch a CSV and build a point cloud (spheres for small clouds, verts otherwise). */
export async function buildTableScene(
  scene: Scene,
  url: string,
  coordinates: TableCoordinates,
  messages: Messages,
  signal: AbortSignal,
  isDisposed: () => boolean,
): Promise<void> {
  const response = await fetchOk(url, signal);
  const { output, invalidScalarCells, skippedRows } = tableToPolyData(
    await response.text(), coordinates,
  );
  if (isDisposed()) return;
  const diagnostic = csvDiagnostics(messages, invalidScalarCells, skippedRows);
  if (diagnostic) scene.dataDiagnostic = diagnostic;
  const useGlyphs = output.getNumberOfPoints() <= 2_000;
  const bounds = output.getBounds();
  const diagonal = Math.hypot(
    bounds[1] - bounds[0], bounds[3] - bounds[2], bounds[5] - bounds[4],
  );
  const glyphSource = useGlyphs ? vtkSphereSource.newInstance({
    radius: Math.max(diagonal * 0.035, 0.01),
    thetaResolution: 8,
    phiResolution: 8,
  }) : null;
  const mapper = useGlyphs
    ? vtkGlyph3DMapper.newInstance({ scaling: false })
    : vtkMapper.newInstance();
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  mapper.setInputData(output);
  if (glyphSource) {
    (mapper as ReturnType<typeof vtkGlyph3DMapper.newInstance>)
      .setSourceConnection(glyphSource.getOutputPort());
  }
  scene.mapper = mapper as unknown as VtkMapper;
  scene.prop = actor as unknown as VtkProp;
  scene.output = output as unknown as VtkDataSet;
  scene.createdOutput = true;
  scene.glyphSource = glyphSource;
  scene.pointGlyph = useGlyphs;
}

/** Fetch + parse a VTI into a slice actor or a volume, per the image mode. */
export async function buildImageScene(
  scene: Scene,
  url: string,
  imageMode: ImageMode,
  sliceAxis: SliceAxis,
  sliceIndex: number,
  signal: AbortSignal,
  isDisposed: () => boolean,
): Promise<void> {
  const reader = vtkXMLImageDataReader.newInstance();
  scene.reader = reader;
  const response = await fetchOk(url, signal);
  reader.parseAsArrayBuffer(await response.arrayBuffer());
  if (isDisposed()) return;
  scene.output = reader.getOutputData() as unknown as VtkDataSet;
  if (imageMode === "slice") {
    const mapper = vtkImageMapper.newInstance();
    const image = vtkImageSlice.newInstance();
    image.setMapper(mapper);
    mapper.setInputConnection(reader.getOutputPort());
    mapper.setSlicingMode(vtkImageMapper.SlicingMode[SLICE_MODE[sliceAxis]]);
    mapper.setSlice(sliceIndex);
    scene.kind = "slice";
    scene.mapper = mapper as unknown as VtkMapper;
    scene.prop = image as unknown as VtkProp;
  } else {
    const mapper = vtkVolumeMapper.newInstance();
    const volume = vtkVolume.newInstance();
    volume.setMapper(mapper);
    mapper.setInputConnection(reader.getOutputPort());
    scene.kind = "volume";
    scene.mapper = mapper as unknown as VtkMapper;
    scene.prop = volume as unknown as VtkProp;
  }
}
