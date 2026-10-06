import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import {
  ISSUES_ROW_PRESENTATION,
  ISSUES_TOOLBAR_PRESENTATION,
  buildIssuesChatConversationsUrl,
  buildIssuesSearchUrl,
  getNextIssuesPageOffset,
  mergeIssuePagesStable,
  resolveIssuesPresentation,
} from "./Issues";

function createIssue(id: string, title: string): Issue {
  return { id, title } as Issue;
}

describe("buildIssuesSearchUrl", () => {
  it("preserves trailing spaces in the synced search param", () => {
    expect(buildIssuesSearchUrl("http://localhost:3100/issues?q=bug", "bug ")).toBe("/issues?q=bug+");
  });

  it("removes the search param when the input is cleared", () => {
    expect(buildIssuesSearchUrl("http://localhost:3100/issues?q=bug#details", "")).toBe("/issues#details");
  });

  it("returns null when the URL already matches the current search", () => {
    expect(buildIssuesSearchUrl("http://localhost:3100/issues?q=bug+", "bug ")).toBeNull();
  });
});

describe("buildIssuesChatConversationsUrl", () => {
  it("adds the chats param and keeps the other params", () => {
    expect(buildIssuesChatConversationsUrl("http://localhost:3100/issues?q=bug#top", true)).toBe("/issues?q=bug&chats=1#top");
  });

  it("removes the chats param when hidden again", () => {
    expect(buildIssuesChatConversationsUrl("http://localhost:3100/issues?chats=1", false)).toBe("/issues");
  });

  it("returns null when the URL already matches", () => {
    expect(buildIssuesChatConversationsUrl("http://localhost:3100/issues?chats=1", true)).toBeNull();
    expect(buildIssuesChatConversationsUrl("http://localhost:3100/issues", false)).toBeNull();
  });
});

describe("issues page pagination helpers", () => {
  it("opts the Tasks route into the canonical shared task-row presentation", () => {
    expect(ISSUES_ROW_PRESENTATION).toBe("task");
  });

  it("opts the Tasks route into the shared collection toolbar", () => {
    expect(ISSUES_TOOLBAR_PRESENTATION).toBe("collection");
  });

  it("restores the retained legacy list and toolbar when Streamlined UI is off", () => {
    expect(resolveIssuesPresentation(false)).toEqual({
      rowPresentation: "legacy",
      toolbarPresentation: "legacy",
    });
    expect(resolveIssuesPresentation(true)).toEqual({
      rowPresentation: "task",
      toolbarPresentation: "collection",
    });
  });

  it("advances to the next offset when the current page is full", () => {
    expect(getNextIssuesPageOffset(100, 0)).toBe(100);
    expect(getNextIssuesPageOffset(100, 100)).toBe(200);
    expect(getNextIssuesPageOffset(1000, 2000, 1000)).toBe(3000);
  });

  it("stops requesting issue pages when the current page is partial", () => {
    expect(getNextIssuesPageOffset(99, 0)).toBeUndefined();
    expect(getNextIssuesPageOffset(999, 2000, 1000)).toBeUndefined();
  });

  it("dedupes overlapping pages without moving the original issue position", () => {
    const first = createIssue("issue-1", "Original first");
    const second = createIssue("issue-2", "Second");
    const duplicateFirst = createIssue("issue-1", "Duplicate first");
    const third = createIssue("issue-3", "Third");

    expect(mergeIssuePagesStable([[first, second], [duplicateFirst, third]])).toEqual([
      first,
      second,
      third,
    ]);
  });
});
