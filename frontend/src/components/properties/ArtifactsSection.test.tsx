import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessagesProvider } from "../../i18n-context";
import { MESSAGES } from "../../i18n";
import type { Dataset, MovieParams } from "../../types";
import { ArtifactsSection } from "./ArtifactsSection";

const messages = MESSAGES.en;

function dataset(): Dataset {
  return {
    id: "d1",
    project_id: "p1",
    filename: "series.pvd",
    ext: ".pvd",
    size_bytes: 10,
    status: "ready",
    dataset_type: "Collection",
    timesteps: [0, 1],
    created_at: "",
  };
}

function renderSection(overrides: {
  serverFilterAvailable?: boolean;
  videoExportAvailable?: boolean;
  onMovieExport?: (params: MovieParams) => void;
} = {}) {
  const onMovieExport = overrides.onMovieExport ?? vi.fn<(params: MovieParams) => void>();
  render(
    <MessagesProvider language="en">
      <ArtifactsSection
        dataset={dataset()}
        isClientExportable={false}
        artifacts={[]}
        onExport={vi.fn()}
        exportPending={false}
        onConvert={vi.fn()}
        convertPending={false}
        serverFilterAvailable={overrides.serverFilterAvailable ?? true}
        videoExportAvailable={overrides.videoExportAvailable ?? true}
        onRunStats={vi.fn()}
        statsPending={false}
        onClientExport={vi.fn()}
        clientExportPending={false}
        onMovieExport={onMovieExport}
        moviePending={false}
        onPromoteArtifact={vi.fn()}
        promotePendingIds={new Set()}
        onError={vi.fn()}
      />
    </MessagesProvider>,
  );
  return onMovieExport;
}

describe("ArtifactsSection movie export", () => {
  it("keeps PNG ZIP as the compatibility default", async () => {
    const user = userEvent.setup();
    const onMovieExport = renderSection();

    const format = screen.getByLabelText(messages.properties.movieFormat) as HTMLSelectElement;
    expect(format.value).toBe("zip");
    expect((screen.getByLabelText(messages.properties.movieFps) as HTMLInputElement).disabled)
      .toBe(true);
    await user.click(screen.getByRole("button", { name: messages.properties.movieRun }));

    expect(onMovieExport).toHaveBeenCalledWith({
      format: "zip",
      fps: 24,
      width: 1280,
      height: 720,
    });
  });

  it("submits validated WebM settings", async () => {
    const user = userEvent.setup();
    const onMovieExport = renderSection();

    await user.selectOptions(screen.getByLabelText(messages.properties.movieFormat), "webm");
    const fps = screen.getByLabelText(messages.properties.movieFps);
    const width = screen.getByLabelText(messages.properties.movieWidth);
    const height = screen.getByLabelText(messages.properties.movieHeight);
    await user.clear(fps);
    await user.type(fps, "60");
    await user.clear(width);
    await user.type(width, "1920");
    await user.clear(height);
    await user.type(height, "1080");
    await user.click(screen.getByRole("button", { name: messages.properties.movieRun }));

    expect(onMovieExport).toHaveBeenCalledWith({
      format: "webm",
      fps: 60,
      width: 1920,
      height: 1080,
    });
  });

  it("disables video choices without ffmpeg and all export without pvpython", () => {
    const { unmount } = render(
      <MessagesProvider language="en">
        <ArtifactsSection
          dataset={dataset()}
          isClientExportable={false}
          artifacts={[]}
          onExport={vi.fn()}
          exportPending={false}
          onConvert={vi.fn()}
          convertPending={false}
          serverFilterAvailable={true}
          videoExportAvailable={false}
          onRunStats={vi.fn()}
          statsPending={false}
          onClientExport={vi.fn()}
          clientExportPending={false}
          onMovieExport={vi.fn()}
          moviePending={false}
          onPromoteArtifact={vi.fn()}
          promotePendingIds={new Set()}
          onError={vi.fn()}
        />
      </MessagesProvider>,
    );
    const format = screen.getByLabelText(messages.properties.movieFormat) as HTMLSelectElement;
    expect((format.querySelector('option[value="mp4"]') as HTMLOptionElement).disabled).toBe(true);
    expect((format.querySelector('option[value="webm"]') as HTMLOptionElement).disabled).toBe(true);
    unmount();

    renderSection({ serverFilterAvailable: false, videoExportAvailable: false });
    expect(
      (screen.getByRole("button", { name: messages.properties.movieRun }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(messages.properties.movieWorkerUnavailable)).toBeDefined();
  });
});
