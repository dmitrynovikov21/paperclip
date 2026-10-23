import { describe, expect, it, vi } from "vitest";
import { cloudOnboarding, type CloudOnboardingInput } from "./cloud-onboarding.js";
import { onboardingFirstTask } from "./onboarding-first-task.js";

vi.mock("@playwright/test", () => ({ expect: (locator: { isVisible(): Promise<boolean> }) => ({
  toBeVisible: async () => { expect(await locator.isVisible()).toBe(true); },
  not: { toBeVisible: async () => { expect(await locator.isVisible()).toBe(false); } },
}) }));
vi.mock("./onboarding-first-task.js", () => ({ onboardingFirstTask: vi.fn(async () => ({ artifact: { originatingRunId: "artifact-run" } })) }));

type Entry = "first-run" | "portfolio" | "create-form";
type Control = { role: string; name: string; scope?: string; fill?(value: string): void; click?(): void; select?(value: string): void };

/** Visible control contracts only; no browser, Cloud API, or provider is started. */
function fixture(entry: Entry, options: { intentFailure?: boolean; qualificationFailure?: boolean } = {}) {
  let stage: string = entry, name = "", apiMode = false, source = false, advanced = false, runnerOpen = false;
  let modelsOpen = false, model = "", runner = "", saved = false, hired = false;
  const fields: Record<string, string> = {}, events: string[] = [];
  const gateway = { baseUrl: "https://owned-gateway.example.test/v1", model: "gpt-5.4-mini", apiKey: "synthetic-test-key" };
  const connection = { id: "connection", name: "My owned-gateway.example.test", provider: "openai", method: "api_key", status: "connected" };
  const create = () => {
    expect(events).toContain("intent:workspace");
    expect(name).toBe("Journey QA campaign");
    events.push("create:workspace"); stage = "agent";
  };
  const controls = (): Control[] => {
    if (stage === "portfolio") return [{ role: "link", name: "Create a new organization", click() { stage = "create-form"; } }];
    if (stage === "first-run" || stage === "create-form") return [
      { role: "textbox", name: stage === "first-run" ? "Name" : "Organization name", fill(value) { name = value; } },
      { role: "button", name: stage === "first-run" ? "Next" : "Create organization", click: create },
    ];
    if (stage === "agent") return [
      { role: "heading", name: "Create your first agent" },
      { role: "textbox", name: "Agent name", fill(value) { name = value; } },
      { role: "button", name: "Next", click() { stage = "connect"; } },
    ];
    if (stage === "started") return [];
    if (hired) return [{ role: "button", name: "Get started", click() { stage = "started"; } }];
    const result: Control[] = [
      { role: "button", name: apiMode ? "Use subscription instead" : "Use API key instead", click() { apiMode = !apiMode; } },
      { role: "radio", name: apiMode ? "OpenAI API key" : "OpenAI Subscription", click() { source = true; } },
    ];
    if (source && apiMode) result.push({ role: "button", name: "Use a custom gateway", click() { stage = "gateway"; } });
    if (stage === "gateway") {
      result.push({ role: "dialog", name: "Custom gateway connection" });
      for (const field of ["Provider URL", "API key", ...(modelsOpen ? ["Model IDs"] : [])]) result.push({
        role: "textbox", name: field, scope: "gateway", fill(value) { fields[field] = value; },
      });
      result.push({ role: "button", name: "Change", scope: "gateway", click() { modelsOpen = true; } },
        { role: "button", name: "Save connection", scope: "gateway", click() {
          expect(fields).toEqual({ "Provider URL": gateway.baseUrl, "API key": gateway.apiKey, "Model IDs": gateway.model });
          expect(events).toContain("intent:connection"); events.push("save:connection"); saved = true; stage = "connect";
        } });
    }
    if (saved) result.push({ role: "combobox", name: "Model", select(value) { expect(value).toBe(gateway.model); model = value; } });
    if (source) result.push({ role: "summary", name: "Advanced", click() { advanced = true; } });
    if (advanced) result.push({ role: "button", name: "Runner", click() { runnerOpen = true; } });
    if (runnerOpen) result.push({ role: "option", name: "Paperclip Runner (default)", click() { runner = "paperclip"; runnerOpen = false; } });
    if (saved && model && runner) result.push({ role: "button", name: "Connect", click() {
      expect(events).toContain("qualified"); events.push("paid:connect"); hired = true;
    } });
    return result;
  };
  const match = (value: string, expected: string | RegExp) => typeof expected === "string" ? value === expected : expected.test(value);
  const locator = (resolve: () => Control[]): any => ({
    first() { return locator(() => resolve().slice(0, 1)); },
    or(other: { resolve(): Control[] }) { return locator(() => [...resolve(), ...other.resolve()]); },
    resolve,
    async isVisible() { return resolve().length > 0; },
    async fill(value: string) { const control = resolve()[0]; if (!control?.fill) throw new Error("No visible text field"); control.fill(value); },
    async click() { const control = resolve()[0]; if (!control?.click) throw new Error("No visible action"); events.push(`click:${control.name}`); control.click(); },
    async selectOption(value: string) { const control = resolve()[0]; if (!control?.select) throw new Error("No visible native model picker"); control.select(value); },
    async waitFor() { expect(resolve().length).toBeGreaterThan(0); },
    filter({ hasText }: { hasText: string }) { return locator(() => resolve().filter(control => control.name.includes(hasText))); },
    getByLabel(label: string) { return locator(() => controls().filter(control => control.scope === "gateway" && control.name === label)); },
    getByRole(role: string, { name: label }: { name: string | RegExp }) {
      return locator(() => controls().filter(control => control.scope === "gateway" && control.role === role && match(control.name, label)));
    },
  });
  const page = {
    getByLabel(label: string) { return locator(() => controls().filter(control => control.name === label && control.role === "textbox")); },
    getByRole(role: string, { name: label }: { name: string | RegExp }) {
      return locator(() => controls().filter(control => control.role === role && match(control.name, label)));
    },
    locator(selector: string) { expect(selector).toBe("summary"); return locator(() => controls().filter(control => control.role === "summary")); },
  };
  const context = { page, company: { id: "company" }, identity: { kind: "cloud" }, startingState: "recipe", api: {
    async get(route: string) {
      if (route.endsWith("/ai-connections")) return { connections: saved ? [connection] : [] };
      if (route.endsWith("/agents")) return hired ? [{ id: "agent", name, adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: gateway.model } }] : [];
      throw new Error("Unexpected API read");
    },
  } };
  const input = { page, campaignId: "campaign", deadlineAt: Date.now() + 60_000, gateway, maxRuns: 8, evidence: { checks: [] },
    async beforeWorkspace() { if (options.intentFailure) throw new Error("ownership unavailable"); events.push("intent:workspace"); },
    async workspaceCreated() { expect(stage).toBe("agent"); return context; },
    async own(resource: { kind: string }) { events.push(`intent:${resource.kind}`); },
    async phase() {}, async observeRun() {},
    async qualify() { if (options.qualificationFailure) throw new Error("admission denied"); events.push("qualified"); },
    async verifyExecution(_context: unknown, runIds: string[]) { expect(runIds).toEqual(["artifact-run"]); events.push("native:verified"); },
  } as unknown as CloudOnboardingInput;
  return { input, events };
}

describe("Cloud onboarding visible controls", () => {
  it.each(["first-run", "portfolio", "create-form"] as const)("creates from %s with intent before dispatch and qualification before paid Connect", async entry => {
    const f = fixture(entry);
    const result = await cloudOnboarding(f.input);
    expect(result.startingState).toBe("onboarding");
    expect(f.events.indexOf("intent:workspace")).toBeLessThan(f.events.indexOf("create:workspace"));
    expect(f.events.indexOf("intent:connection")).toBeLessThan(f.events.indexOf("save:connection"));
    expect(f.events.indexOf("qualified")).toBeLessThan(f.events.indexOf("paid:connect"));
    expect(f.events).toContain("native:verified");
  });
  it("does not dispatch workspace creation without durable ownership", async () => {
    const f = fixture("first-run", { intentFailure: true });
    await expect(cloudOnboarding(f.input)).rejects.toThrow("ownership unavailable");
    expect(f.events).not.toContain("create:workspace");
  });
  it("never presses paid Connect when route admission fails", async () => {
    const f = fixture("portfolio", { qualificationFailure: true });
    const previous = vi.mocked(onboardingFirstTask).mock.calls.length;
    await expect(cloudOnboarding(f.input)).rejects.toThrow("admission denied");
    expect(f.events).not.toContain("paid:connect");
    expect(vi.mocked(onboardingFirstTask).mock.calls).toHaveLength(previous);
  });
});
