import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { AgentSessionSummary } from "@t3tools/contracts";
import { DownloadIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { agentSessionImportSessions, agentSessionListSessions } from "../../state/agentSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

function formatSessionDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/**
 * Local-only granular history import: list every Claude Code / Codex session
 * transcript recorded against the selected project's workspace root and import
 * exactly the checked ones. Imported threads land as read-only history that
 * can resume the original provider session.
 */
export function AgentSessionImportSettings() {
  const { scope, target } = useSettingsScope();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const listSessions = useAtomCommand(agentSessionListSessions, { reportFailure: false });
  const importSessions = useAtomCommand(agentSessionImportSessions, { reportFailure: false });
  const [sessions, setSessions] = useState<ReadonlyArray<AgentSessionSummary> | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string> | null>(null);
  const [importResult, setImportResult] = useState("");
  const [isImporting, setIsImporting] = useState(false);

  const sessionKey = (session: AgentSessionSummary) =>
    `${session.providerInstanceId}:${session.providerSessionId}`;
  const selectedKeys = useMemo(
    () =>
      selectedIds ??
      new Set((sessions ?? []).filter((session) => !session.alreadyImported).map(sessionKey)),
    [selectedIds, sessions],
  );
  const selectedSessions = (sessions ?? []).filter((session) =>
    selectedKeys.has(sessionKey(session)),
  );
  const importableSelected = selectedSessions.filter((session) => !session.alreadyImported);
  const staleSelected = selectedSessions.filter(
    (session) => session.alreadyImported && session.stale === true,
  );

  const load = useCallback(async () => {
    if (target?.projectId == null) return;
    setIsLoading(true);
    setLoadError("");
    setImportResult("");
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

  const runImport = useCallback(
    async (mode: "fresh" | "update") => {
      const targets =
        mode === "update"
          ? staleSelected
          : importableSelected.filter((session) => session.stale !== true);
      const allTargets =
        mode === "update"
          ? [...importableSelected.filter((session) => session.stale !== true), ...staleSelected]
          : targets;
      if (target?.projectId == null || allTargets.length === 0) return;
      setIsImporting(true);
      setImportResult("");
      const result: AtomCommandResult<
        { importedCount: number; skippedCount: number; updatedCount?: number },
        unknown
      > = await importSessions({
        environmentId: target.environmentId,
        input: {
          projectId: target.projectId,
          sessions: allTargets.map((session) => ({
            providerInstanceId: session.providerInstanceId,
            providerSessionId: session.providerSessionId,
          })),
          ...(mode === "update" ? { mode: "update" as const } : {}),
        },
      });
      setIsImporting(false);
      if (result._tag === "Success") {
        const { importedCount, skippedCount, updatedCount } = result.value;
        const staleNote =
          updatedCount !== undefined && updatedCount > 0
            ? ` Updated ${updatedCount} ${updatedCount === 1 ? "session" : "sessions"} with newer history.`
            : "";
        setImportResult(
          importedCount === 0 && skippedCount === 0
            ? "Nothing to import."
            : `Imported ${importedCount} ${importedCount === 1 ? "session" : "sessions"}.` +
                (skippedCount > 0
                  ? ` ${skippedCount} ${skippedCount === 1 ? "session" : "sessions"} could not be imported.`
                  : "") +
                staleNote,
        );
        toastManager.add({
          type: "success",
          title: `Imported ${importedCount} ${importedCount === 1 ? "session" : "sessions"}`,
        });
        // Reload so freshly imported sessions flip to their imported badge.
        void load();
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setImportResult(error instanceof Error ? error.message : "Import failed.");
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not import sessions",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [importableSelected, importSessions, load, staleSelected, target],
  );

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
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              disabled={isLoading || isImporting}
              onClick={() => void load()}
            >
              <RefreshCwIcon className="size-3.5" />
              {sessions === null ? "Load sessions" : "Reload"}
            </Button>
          </div>
        }
      />
      {isLoading ? (
        <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Scanning session transcripts…
        </div>
      ) : loadError ? (
        <p className="px-4 py-3 text-sm text-warning">{loadError}</p>
      ) : sessions === null ? null : sessions.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No Claude Code or Codex sessions were found for this project's directory.
        </p>
      ) : (
        <>
          <div className="mx-4 mb-2 flex items-center justify-between rounded-md border bg-surface px-3 py-2 text-xs text-muted-foreground">
            <span role="status">
              {selectedSessions.length} of {sessions.length} selected
              {sessions.some((session) => session.alreadyImported) ? " · ✓ = already imported" : ""}
            </span>
            <span className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="xs"
                disabled={isImporting}
                onClick={() => setSelectedIds(new Set(sessions.map(sessionKey)))}
              >
                Select all
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={isImporting}
                onClick={() => setSelectedIds(new Set())}
              >
                Clear
              </Button>
            </span>
          </div>
          <ul className="mx-4 mb-2 max-h-72 overflow-y-auto rounded-md border">
            {sessions.map((session) => {
              const key = sessionKey(session);
              return (
                <li
                  key={key}
                  className="flex items-start gap-3 border-b px-3 py-2 last:border-b-0 hover:bg-surface-hover"
                >
                  <Checkbox
                    className="mt-1"
                    checked={selectedKeys.has(key)}
                    onCheckedChange={(checked) => {
                      const next = new Set(selectedKeys);
                      if (checked) {
                        next.add(key);
                      } else {
                        next.delete(key);
                      }
                      setSelectedIds(next);
                    }}
                    aria-label={`Select session ${session.title}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{session.title}</span>
                      {session.alreadyImported ? (
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                            session.stale
                              ? "bg-warning/15 text-warning"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {session.stale ? "outdated" : "imported"}
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {formatSessionDate(session.updatedAt)} · {session.messageCount}{" "}
                      {session.messageCount === 1 ? "message" : "messages"} · {session.provider}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="px-4 pb-1">
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={isImporting || importableSelected.length === 0}
                onClick={() => void runImport("fresh")}
              >
                <DownloadIcon className="size-3.5" />
                {isImporting
                  ? "Importing…"
                  : `Import ${importableSelected.length} selected ${
                      importableSelected.length === 1 ? "session" : "sessions"
                    }`}
              </Button>
              {staleSelected.length > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isImporting || staleSelected.length === 0}
                  onClick={() => void runImport("update")}
                >
                  <RefreshCwIcon className="size-3.5" />
                  {isImporting
                    ? "Updating…"
                    : `Bring ${staleSelected.length} ${
                        staleSelected.length === 1 ? "session" : "sessions"
                      } up to date`}
                </Button>
              ) : null}
            </div>
            {importResult ? (
              <p role="status" className="mt-2 text-sm text-muted-foreground">
                {importResult}
              </p>
            ) : null}
          </div>
        </>
      )}
    </SettingsSection>
  );
}
