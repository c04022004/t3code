import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { AgentSessionSummary } from "@t3tools/contracts";
import { DownloadIcon, HistoryIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { agentSessionImportSessions, agentSessionListSessions } from "../../state/agentSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

type SessionFilter = "all" | "new" | "outdated" | "imported";

const FILTER_LABELS: Readonly<Record<SessionFilter, string>> = {
  all: "All",
  new: "New",
  outdated: "Outdated",
  imported: "Imported",
};

function formatSessionDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/** Coarse recency group so long histories stay scannable. */
function recencyGroup(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfWeek = startOfToday - 6 * 24 * 60 * 60 * 1000;
  const time = date.getTime();
  if (time >= startOfToday) return "Today";
  if (time >= startOfYesterday) return "Yesterday";
  if (time >= startOfWeek) return "This week";
  return "Earlier";
}

function sessionState(session: AgentSessionSummary): SessionFilter {
  if (!session.alreadyImported) return "new";
  return session.stale === true ? "outdated" : "imported";
}

function sessionBadge(session: AgentSessionSummary): {
  label: string;
  className: string;
} | null {
  const state = sessionState(session);
  if (state === "new") return null;
  if (state === "outdated") {
    return {
      label: "outdated",
      className: "bg-warning/15 text-warning",
    };
  }
  return { label: "imported", className: "bg-muted text-muted-foreground" };
}

/**
 * Local-only granular history import: a picker dialog listing every Claude
 * Code / Codex session transcript recorded against the selected project's
 * workspace root. Import exactly the checked ones; outdated sessions get
 * replaced with their fresh history, and up-to-date ones are left alone.
 */
export function AgentSessionImportSettings() {
  const { scope, target } = useSettingsScope();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const listSessions = useAtomCommand(agentSessionListSessions, { reportFailure: false });
  const importSessions = useAtomCommand(agentSessionImportSessions, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<ReadonlyArray<AgentSessionSummary> | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string> | null>(null);
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [query, setQuery] = useState("");
  const [importNote, setImportNote] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  // Re-run auto-load when a fresh dialog opens, not on every keystroke below.
  const openGenerationRef = useRef(0);

  const sessionKey = (session: AgentSessionSummary) =>
    `${session.providerInstanceId}:${session.providerSessionId}`;

  const load = useCallback(async () => {
    if (target?.projectId == null) return;
    setIsLoading(true);
    setLoadError("");
    const result: AtomCommandResult<{ sessions: ReadonlyArray<AgentSessionSummary> }, unknown> =
      await listSessions({
        environmentId: target.environmentId,
        input: { projectId: target.projectId },
      });
    setIsLoading(false);
    if (result._tag === "Success") {
      setSessions(result.value.sessions);
      setSelectedIds(null);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setLoadError(error instanceof Error ? error.message : "Could not load sessions.");
    }
  }, [listSessions, target]);

  // Opening the dialog always shows fresh state: reload and reset filters.
  useEffect(() => {
    if (!open || target?.projectId == null) return;
    openGenerationRef.current += 1;
    setFilter("all");
    setQuery("");
    setImportNote("");
    void load();
  }, [open, load, target?.projectId]);

  const counts = useMemo(() => {
    const list = sessions ?? [];
    const tally: Record<SessionFilter, number> = {
      all: list.length,
      new: 0,
      outdated: 0,
      imported: 0,
    };
    for (const session of list) tally[sessionState(session)] += 1;
    return tally;
  }, [sessions]);

  const filteredSessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (sessions ?? []).filter((session) => {
      if (filter !== "all" && sessionState(session) !== filter) return false;
      if (needle.length === 0) return true;
      return (
        session.title.toLowerCase().includes(needle) ||
        session.providerSessionId.toLowerCase().includes(needle)
      );
    });
  }, [filter, query, sessions]);

  const groupedSessions = useMemo(() => {
    const groups = new Map<string, Array<AgentSessionSummary>>();
    for (const session of filteredSessions) {
      const group = recencyGroup(session.updatedAt);
      const existing = groups.get(group);
      if (existing) {
        existing.push(session);
      } else {
        groups.set(group, [session]);
      }
    }
    return Array.from(groups.entries());
  }, [filteredSessions]);

  // Checked ids; defaults to everything actionable (new + outdated) when the
  // user has not touched the checkboxes yet.
  const selectedKeys = useMemo(
    () =>
      selectedIds ??
      new Set(
        (sessions ?? []).filter((session) => sessionState(session) !== "imported").map(sessionKey),
      ),
    [selectedIds, sessions],
  );
  const selectedSessions = (sessions ?? []).filter((session) =>
    selectedKeys.has(sessionKey(session)),
  );
  const importSummary = useMemo(() => {
    const tally = { fresh: 0, updated: 0, kept: 0 };
    for (const session of selectedSessions) {
      const state = sessionState(session);
      if (state === "new") tally.fresh += 1;
      else if (state === "outdated") tally.updated += 1;
      else tally.kept += 1;
    }
    return tally;
  }, [selectedSessions]);

  const runImport = useCallback(async () => {
    if (target?.projectId == null || selectedSessions.length === 0) return;
    setIsImporting(true);
    setImportNote("");
    const result: AtomCommandResult<
      { importedCount: number; skippedCount: number; updatedCount?: number },
      unknown
    > = await importSessions({
      environmentId: target.environmentId,
      input: {
        projectId: target.projectId,
        sessions: selectedSessions.map((session) => ({
          providerInstanceId: session.providerInstanceId,
          providerSessionId: session.providerSessionId,
        })),
      },
    });
    setIsImporting(false);
    if (result._tag === "Success") {
      const { importedCount, skippedCount, updatedCount } = result.value;
      const notes: Array<string> = [];
      if (updatedCount !== undefined && updatedCount > 0) {
        notes.push(
          `updated ${updatedCount} ${updatedCount === 1 ? "session" : "sessions"} with newer history`,
        );
      }
      if (skippedCount > 0) {
        notes.push(
          `${skippedCount} ${skippedCount === 1 ? "session" : "sessions"} could not be imported`,
        );
      }
      setImportNote(
        importedCount === 0 && skippedCount === 0 && (updatedCount ?? 0) === 0
          ? "Nothing changed."
          : `Imported ${importedCount} ${importedCount === 1 ? "session" : "sessions"}` +
              (notes.length > 0 ? ` · ${notes.join(" · ")}` : ""),
      );
      toastManager.add({
        type: "success",
        title: `Imported ${importedCount} ${importedCount === 1 ? "session" : "sessions"}`,
        ...(notes.length > 0 ? { description: notes.join(" · ") } : {}),
      });
      // Reload so badges reflect the new state.
      void load();
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setImportNote(error instanceof Error ? error.message : "Import failed.");
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not import sessions",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  }, [importSessions, load, selectedSessions, target]);

  const summaryBadge = useMemo(() => {
    if (sessions === null) return null;
    const actionable = counts.new + counts.outdated;
    if (actionable === 0) return null;
    return `${counts.new} new · ${counts.outdated} outdated`;
  }, [counts, sessions]);

  if (!isProjectScope || target?.projectId == null) {
    return (
      <SettingsSection id="import-sessions" title="Import sessions">
        <SettingsRow
          title="Import agent history"
          description="Select a single project to import Claude Code or Codex session history into it."
        />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection id="import-sessions" title="Import sessions">
      <SettingsRow
        title="Import agent history"
        description="Bring Claude Code or Codex session transcripts from this project's directory into t3 Code. Imported threads can continue their original agent session."
        control={
          <div className="flex items-center gap-2">
            {summaryBadge !== null ? (
              <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] text-warning">
                {summaryBadge}
              </span>
            ) : null}
            <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
              <DownloadIcon className="size-3.5" />
              Pick sessions…
            </Button>
          </div>
        }
      />
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
        }}
      >
        <DialogPopup className="flex max-w-2xl flex-col gap-0 p-0">
          <DialogHeader className="px-5 pt-5">
            <DialogTitle>Import agent history</DialogTitle>
            <DialogDescription>
              Sessions Claude Code or Codex recorded in this project's directory. New sessions
              import as history; outdated ones are replaced with their latest transcript.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 px-5 pt-3">
            <div className="relative min-w-0 flex-1">
              <SearchIcon className="pointer-events-none absolute inset-y-0 left-2.5 my-auto size-3.5 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search sessions…"
                aria-label="Search sessions"
                className="pl-8"
              />
            </div>
            <div role="tablist" aria-label="Filter sessions" className="flex items-center gap-1">
              {(Object.keys(FILTER_LABELS) as SessionFilter[]).map((key) => (
                <Button
                  key={key}
                  role="tab"
                  aria-selected={filter === key}
                  size="xs"
                  variant={filter === key ? "secondary" : "ghost"}
                  disabled={counts[key] === 0 && key !== "all"}
                  onClick={() => setFilter(key)}
                >
                  {FILTER_LABELS[key]}
                  {key !== "all" && counts[key] > 0 ? (
                    <span className="ms-1 text-[10px] text-muted-foreground">{counts[key]}</span>
                  ) : null}
                </Button>
              ))}
            </div>
          </div>
          <div className="min-h-[16rem] overflow-y-auto px-5 py-3" style={{ maxHeight: "50vh" }}>
            {isLoading ? (
              <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                Scanning session transcripts…
              </div>
            ) : loadError ? (
              <p className="py-8 text-sm text-warning">{loadError}</p>
            ) : sessions === null ? null : sessions.length === 0 ? (
              <p className="py-8 text-sm text-muted-foreground">
                No Claude Code or Codex sessions were found for this project's directory.
              </p>
            ) : filteredSessions.length === 0 ? (
              <p className="py-8 text-sm text-muted-foreground">No sessions match this filter.</p>
            ) : (
              groupedSessions.map(([group, groupSessions]) => (
                <div key={group} className="mb-3">
                  <div className="sticky top-0 z-10 bg-surface px-1 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {group}
                  </div>
                  <ul>
                    {groupSessions.map((session) => {
                      const key = sessionKey(session);
                      const badge = sessionBadge(session);
                      return (
                        <li
                          key={key}
                          className="flex items-start gap-3 rounded-md px-1 py-1.5 hover:bg-surface-hover"
                        >
                          <Checkbox
                            className="mt-1"
                            checked={selectedKeys.has(key)}
                            onCheckedChange={(checked) => {
                              setSelectedIds((current) => {
                                const next = new Set(current ?? selectedKeys);
                                if (checked) {
                                  next.add(key);
                                } else {
                                  next.delete(key);
                                }
                                return next;
                              });
                            }}
                            aria-label={`Select session ${session.title}`}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">{session.title}</span>
                              {badge !== null ? (
                                <span
                                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${badge.className}`}
                                >
                                  {badge.label}
                                </span>
                              ) : null}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {formatSessionDate(session.updatedAt)} · {session.messageCount}{" "}
                              {session.messageCount === 1 ? "message" : "messages"} ·{" "}
                              {session.provider}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))
            )}
          </div>
          <DialogFooter variant="bare" className="border-t px-5 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {importNote ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {importNote}
                </p>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {importSummary.fresh + importSummary.updated + importSummary.kept > 0
                  ? `${importSummary.fresh + importSummary.updated} of ${
                      counts.all
                    } sessions selected` +
                    (importSummary.updated > 0
                      ? ` · ${importSummary.updated} will be refreshed`
                      : "") +
                    (importSummary.kept > 0 ? ` · ${importSummary.kept} already current` : "")
                  : `${counts.all} sessions · none selected`}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" size="sm" disabled={isImporting} onClick={() => void load()}>
                <RefreshCwIcon className="size-3.5" />
                Reload
              </Button>
              <Button
                size="sm"
                disabled={isImporting || (importSummary.fresh === 0 && importSummary.updated === 0)}
                onClick={() => void runImport()}
              >
                {isImporting ? (
                  <>
                    <Spinner className="size-3.5" />
                    Importing…
                  </>
                ) : importSummary.updated > 0 ? (
                  <>
                    <HistoryIcon className="size-3.5" />
                    Sync {importSummary.fresh + importSummary.updated} selected
                  </>
                ) : (
                  <>
                    <DownloadIcon className="size-3.5" />
                    Import {importSummary.fresh} selected
                  </>
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}
