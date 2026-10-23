import { describe, expect, it } from "vitest";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";

describe("agent session wake messages", () => {
  it("does not split an emoji at the inline issue description limit", async () => {
    const description = `${"a".repeat(11_999)}🟢tail`;
    const wakePayload = await buildPaperclipWakePayload({
      db: {
        select: () => ({
          from: () => ({ where: async () => [] }),
        }),
      } as never,
      companyId: "company-1",
      contextSnapshot: { issueId: "issue-1", wakeReason: "issue_assigned" },
      issueSummary: {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Unicode boundary",
        description,
        status: "todo",
        priority: "medium",
        workMode: "standard",
      },
    });

    expect(wakePayload?.issue?.description).toBe("a".repeat(11_999));
    expect(wakePayload?.issue?.descriptionTruncated).toBe(true);
    expect(wakePayload?.fallbackFetchNeeded).toBe(true);
  });

  it("includes the issue brief and requires fallback fetch when a long description is truncated", async () => {
    const description = [
      "Update launch-card.svg and change the CTA to Try Team free.",
      "x".repeat(13_000),
    ].join("\n");

    const wakePayload = await buildPaperclipWakePayload({
      db: {
        select: () => ({
          from: () => ({
            where: async () => [],
          }),
        }),
      } as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "issue_assigned",
        issueId: "issue-1",
      },
      issueSummary: {
        id: "issue-1",
        identifier: "PAP-15271",
        title: "Preserve the task brief",
        description,
        status: "in_progress",
        priority: "high",
        workMode: "standard",
      },
    });

    expect(wakePayload?.issue).toMatchObject({
      description: expect.stringContaining("launch-card.svg"),
      descriptionTruncated: true,
    });
    expect(wakePayload?.issue?.description).toContain("Try Team free");
    expect(wakePayload?.issue?.description).toHaveLength(12_000);
    expect(wakePayload).toMatchObject({
      truncated: true,
      fallbackFetchNeeded: true,
    });
  });

  it("turns the canonical session-message context into adapter prompt input", async () => {
    const wakePayload = await buildPaperclipWakePayload({
      db: {} as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "gateway_chat_message",
        paperclipAgentMessage: {
          text: "hello",
          source: "plugin_session",
          pluginKey: "paperclip.gateway",
          sessionId: "session-1",
        },
      },
    });

    expect(wakePayload).toMatchObject({
      reason: "gateway_chat_message",
      issue: null,
      agentMessage: {
        text: "hello",
        source: "plugin_session",
        pluginKey: "paperclip.gateway",
        sessionId: "session-1",
      },
    });
    expect(renderPaperclipWakePrompt(wakePayload)).toContain("hello");
  });

  it("leaves a normal context-only wake without a renderable payload", async () => {
    await expect(
      buildPaperclipWakePayload({
        db: {} as never,
        companyId: "company-1",
        contextSnapshot: {
          wakeReason: "timer",
        },
      }),
    ).resolves.toBeNull();
  });

  it("redacts and bounds session messages before materializing the wake payload", async () => {
    const secret = "do-not-render-this-value";
    const wakePayload = await buildPaperclipWakePayload({
      db: {} as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "gateway_chat_message",
        paperclipAgentMessage: {
          text: `OPENAI_API_KEY=${secret}\n${"x".repeat(13_000)}`,
          source: "plugin_session",
          pluginKey: "paperclip.gateway",
          sessionId: "session-1",
        },
      },
    });

    expect(wakePayload?.agentMessage?.text).not.toContain(secret);
    expect(wakePayload?.agentMessage?.text.length).toBeLessThanOrEqual(12_000);
  });
});
