import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessagesProvider } from "../i18n-context";
import { MESSAGES } from "../i18n";
import type { ServerConnection } from "../hooks/useServerConnection";
import { ConnectionSection } from "./ConnectionSection";

const messages = MESSAGES.en;

function connection(overrides: Partial<ServerConnection> = {}): ServerConnection {
  return {
    config: { mode: "static", apiBase: null, autoConnect: false, source: "static-default" },
    mode: "static",
    apiBase: null,
    status: "disconnected",
    failure: null,
    capabilities: null,
    suggestedApiBase: "",
    epoch: 0,
    connect: vi.fn(async () => true),
    retry: vi.fn(async () => true),
    disconnect: vi.fn(),
    ...overrides,
  };
}

function renderSection(
  value: ServerConnection,
  diagnostics: () => Record<string, unknown> = () => ({ ok: true }),
) {
  render(
    <MessagesProvider language="en">
      <ConnectionSection connection={value} buildDiagnostics={diagnostics} />
    </MessagesProvider>,
  );
}

describe("ConnectionSection", () => {
  it("shows static mode without contacting anything and connects on request", async () => {
    const user = userEvent.setup();
    const value = connection();
    renderSection(value);
    expect(screen.getByTestId("connection-mode")).toHaveTextContent(messages.connection.modeStatic);
    expect(screen.getByTestId("connection-status")).toHaveTextContent(messages.connection.statusDisconnected);
    expect(screen.queryByTestId("connection-api-base")).toBeNull();
    await user.click(screen.getByRole("button", { name: messages.connection.showConnectForm }));
    const input = screen.getByLabelText(messages.connection.apiBaseLabel);
    await user.type(input, "http://localhost:8000");
    await user.click(screen.getByRole("button", { name: messages.common.connect }));
    expect(value.connect).toHaveBeenCalledWith("http://localhost:8000");
  });

  it("explains an unreachable server, offers retry, and keeps the detail", async () => {
    const user = userEvent.setup();
    const value = connection({
      mode: "server",
      apiBase: "http://localhost:8000",
      status: "failed",
      failure: { kind: "unreachable", detail: "TypeError: Failed to fetch" },
      suggestedApiBase: "http://localhost:8000",
    });
    renderSection(value);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(messages.connection.failureUnreachable);
    expect(alert).toHaveTextContent(messages.connection.nextSteps);
    expect(alert).toHaveTextContent("TypeError: Failed to fetch");
    expect(screen.getByTestId("connection-api-base")).toHaveTextContent("http://localhost:8000");
    // The form opens automatically on failure with the previous target filled in.
    expect(screen.getByLabelText(messages.connection.apiBaseLabel)).toHaveValue("http://localhost:8000");
    await user.click(screen.getByRole("button", { name: messages.common.retry }));
    expect(value.retry).toHaveBeenCalled();
  });

  it("reports an invalid URL while connected without the retry guidance", () => {
    renderSection(connection({
      mode: "server",
      apiBase: "http://localhost:8000",
      status: "connected",
      failure: { kind: "invalid-url", detail: "localhost:8000" },
    }));
    expect(screen.getByRole("alert")).toHaveTextContent(messages.connection.invalidApiBase);
    expect(screen.queryByText(messages.connection.nextSteps)).toBeNull();
    expect(screen.getByTestId("connection-status")).toHaveTextContent(messages.connection.statusConnected);
  });

  it("copies diagnostics as JSON and offers disconnect when connected", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const value = connection({ mode: "server", apiBase: "https://api.example.com", status: "connected" });
    renderSection(value, () => ({ mode: "server" }));
    await user.click(screen.getByRole("button", { name: messages.connection.copyDiagnostics }));
    expect(writeText).toHaveBeenCalledWith(JSON.stringify({ mode: "server" }, null, 2));
    expect(await screen.findByRole("button", { name: messages.connection.diagnosticsCopied })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: messages.common.disconnect }));
    expect(value.disconnect).toHaveBeenCalled();
  });
});
