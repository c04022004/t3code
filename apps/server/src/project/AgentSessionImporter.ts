import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionSource,
  AgentSessionScanError,
  isImportedAgentSessionMessageId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type AgentSessionImportInput,
  type AgentSessionImportResult,
  type AgentSessionImportSessionsInput,
  type AgentSessionThreadSyncInput,
  type AgentSessionThreadSyncResult,
  type AgentSessionImportSource,
  type OrchestrationThread,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class AgentSessionUnresumableSessionError extends Schema.TaggedError<AgentSessionUnresumableSessionError>()(
  "AgentSessionUnresumableSessionError",
  {
    source: AgentSessionSource,
    providerSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `Session '${this.providerSessionId}' from '${this.source}' cannot be resumed.`;
  }
}

class AgentSessionThreadProjectConflictError extends Schema.TaggedError<AgentSessionThreadProjectConflictError>()(
  "AgentSessionThreadProjectConflictError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' belongs to project '${this.actualProjectId}', not '${this.expectedProjectId}'.`;
  }
}

class AgentSessionThreadModifiedError extends Schema.TaggedError<AgentSessionThreadModifiedError>()(
  "AgentSessionThreadModifiedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Imported thread '${this.threadId}' changed before its history import completed.`;
  }
}

function hasImportedHistory(thread: OrchestrationThread): boolean {
  return thread.messages.some((message) => isImportedAgentSessionMessageId(message.id));
}

/** Minimal shape the import core needs from a parsed transcript. */
interface ImportableTranscript {
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
  readonly title: string;
  readonly model: string | null;
  readonly createdAt: string;
  readonly messages: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly createdAt: string;
  }>;
}

/**
 * Import one parsed transcript into a project: create the read-only thread,
 * replay its messages as a history import, and install the resume cursor so
 * the thread can continue the provider session. Shared by the recent-threads
 * importer and the per-session picker importer.
 */
const importTranscriptCore = Effect.fn("AgentSessionImporter.importTranscriptCore")(
  function* (options: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly transcript: ImportableTranscript;
    /**
     * Replace an existing imported thread with the fresh transcript. Only
     * safe when the thread still holds nothing but imported history — the
     * caller must have checked that.
     */
    readonly replace?: boolean;
  }) {
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
    const crypto = yield* Crypto.Crypto;
    const { projectId, workspaceRoot, transcript, replace = false } = options;
    const threadId = ThreadId.make(
      `import:${transcript.providerInstanceId}:${transcript.providerSessionId}`,
    );
    const provider = ProviderDriverKind.make(transcript.source);
    const model = transcript.model ?? DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
    const existingThread = yield* snapshots.getThreadDetailById(threadId);
    const existingBinding = yield* directory.getBinding(threadId);

    if (
      transcript.source === "claudeAgent" &&
      !CLAUDE_SESSION_ID_PATTERN.test(transcript.providerSessionId)
    ) {
      return yield* new AgentSessionUnresumableSessionError({
        source: transcript.source,
        providerSessionId: transcript.providerSessionId,
      });
    }

    if (Option.isSome(existingThread) && existingThread.value.projectId !== projectId) {
      return yield* new AgentSessionThreadProjectConflictError({
        threadId,
        expectedProjectId: projectId,
        actualProjectId: existingThread.value.projectId,
      });
    }

    const importedHistoryPresent = Option.isSome(existingThread)
      ? hasImportedHistory(existingThread.value)
      : false;
    if (
      !replace &&
      Option.isSome(existingThread) &&
      importedHistoryPresent &&
      Option.isSome(existingBinding)
    ) {
      return true;
    }

    if (
      Option.isSome(existingThread) &&
      hasImportBlockingActivity(existingThread.value, importedHistoryPresent)
    ) {
      return yield* new AgentSessionThreadModifiedError({ threadId });
    }

    // A replace tears down the old incarnation first. Deletion is a soft
    // delete and every projector resets its rows when the id is created
    // again, so re-creating the same thread id is the supported path.
    let replacing = false;
    if (replace && Option.isSome(existingThread)) {
      yield* engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        threadId,
      });
      // The snapshot above predates the delete; the fresh incarnation is
      // empty, so both create and history import must proceed.
      replacing = true;
    }

    if (
      Option.isSome(existingBinding) &&
      (existingBinding.value.provider !== provider ||
        existingBinding.value.providerInstanceId !== transcript.providerInstanceId ||
        existingBinding.value.status !== "stopped")
    ) {
      return yield* new AgentSessionThreadModifiedError({ threadId });
    }

    // Install the cursor before the thread becomes visible. A concurrent
    // real session can replace it, while insert-ignore keeps this import
    // from replacing that newer binding.
    if (Option.isNone(existingBinding)) {
      yield* directory.upsert(
        {
          threadId,
          provider,
          providerInstanceId: transcript.providerInstanceId,
          status: "stopped",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          resumeCursor:
            transcript.source === "codex"
              ? { threadId: transcript.providerSessionId }
              : { threadId, resume: transcript.providerSessionId },
          runtimePayload: { cwd: workspaceRoot },
        },
        { onConflict: "ignore" },
      );
    }

    if (replacing || Option.isNone(existingThread)) {
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        threadId,
        projectId,
        title: transcript.title,
        modelSelection: { instanceId: transcript.providerInstanceId, model },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: transcript.createdAt,
        historyImport: true,
      });
    }

    if (replacing || !importedHistoryPresent) {
      yield* engine.dispatch({
        type: "thread.history.import",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        threadId,
        messages: transcript.messages.map((message, index) => ({
          messageId: MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`),
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
        })),
      });
    }

    return true;
  },
);

function hasImportBlockingActivity(
  thread: OrchestrationThread,
  importedHistoryPresent: boolean,
): boolean {
  // Settle state is organizational, not content: an un-settled imported
  // thread (e.g. the user re-opened it after a history import) must still
  // accept a transcript refresh, so an already-imported thread ignores the
  // whole settle group. A first import of a thread the user already
  // interacted with still respects it.
  if (importedHistoryPresent) {
    return (
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      thread.latestTurn !== null ||
      thread.session !== null ||
      thread.messages.some((message) => !isImportedAgentSessionMessageId(message.id)) ||
      thread.proposedPlans.length > 0 ||
      thread.activities.length > 0 ||
      thread.checkpoints.length > 0 ||
      thread.snoozedUntil != null ||
      thread.snoozedAt != null ||
      thread.pinnedAt != null ||
      thread.pinOrderKey != null ||
      thread.titleRegeneration != null ||
      thread.linkedPullRequest != null
    );
  }
  return (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.latestTurn !== null ||
    thread.session !== null ||
    thread.messages.some((message) => !isImportedAgentSessionMessageId(message.id)) ||
    thread.proposedPlans.length > 0 ||
    thread.activities.length > 0 ||
    thread.checkpoints.length > 0 ||
    thread.snoozedUntil != null ||
    thread.snoozedAt != null ||
    thread.pinnedAt != null ||
    thread.pinOrderKey != null ||
    thread.titleRegeneration != null ||
    thread.linkedPullRequest != null ||
    thread.unsettledAt != null ||
    thread.settledOverride !== null ||
    thread.settledAt !== null
  );
}

/** Import recent transcript text and persist the cursor needed to resume its provider session. */
export const importRecentAgentThreads = Effect.fn("importRecentAgentThreads")(function* (
  input: AgentSessionImportInput,
) {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const crypto = yield* Crypto.Crypto;
  const project = yield* snapshots.getProjectShellById(input.projectId).pipe(
    Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
        onSome: Effect.succeed,
      }),
    ),
  );
  const workspaceRoot = project.workspaceRoot;
  if (
    input.expectedWorkspaceRoot !== undefined &&
    normalizeProjectPathForComparison(workspaceRoot) !==
      normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
  ) {
    return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
  }
  const completedSources = yield* snapshots
    .getImportedAgentSessionSources(input.projectId)
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
  const threads = scanner.recentThreads(
    workspaceRoot,
    completedSources.map((entry) => entry.source),
  );
  const importedThreadIds = new Set<ThreadId>();
  let importedCount = 0;
  let skippedCount = 0;

  yield* Stream.runForEach(threads, (outcome) =>
    Effect.gen(function* () {
      if (outcome._tag === "Skipped") {
        skippedCount += 1;
        return;
      }
      if (outcome._tag === "AlreadyImported" || outcome._tag === "Duplicate") {
        const threadId = ThreadId.make(
          `import:${outcome.source.providerInstanceId}:${outcome.source.providerSessionId}`,
        );
        if (outcome._tag === "AlreadyImported") {
          importedThreadIds.add(threadId);
          importedCount += 1;
        } else if (importedThreadIds.has(threadId)) {
          const recorded = yield* directory
            .recordImportedTranscript({ threadId, source: outcome.source })
            .pipe(Effect.result);
          if (recorded._tag === "Failure") {
            skippedCount += 1;
            yield* Effect.logWarning("Could not record an imported transcript copy", {
              threadId,
              cause: recorded.failure,
            });
          }
        }
        return;
      }
      const thread = outcome.thread;
      const threadId = ThreadId.make(
        `import:${thread.providerInstanceId}:${thread.providerSessionId}`,
      );
      const imported = yield* importTranscriptCore({
        projectId: input.projectId,
        workspaceRoot,
        transcript: thread,
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not import an agent session", {
            provider: thread.source,
            sessionId: thread.providerSessionId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );

      if (imported) {
        yield* directory
          .recordImportedTranscript({ threadId, source: outcome.source })
          .pipe(Effect.ignore);
        importedThreadIds.add(threadId);
        importedCount += 1;
      } else {
        skippedCount += 1;
      }
    }),
  );

  return { importedCount, skippedCount } satisfies AgentSessionImportResult;
});

/**
 * Import exactly the agent sessions the user picked in the per-session picker.
 * Resolves each requested (providerInstanceId, providerSessionId) pair against
 * the parsed transcripts of the project's workspace root, then runs the same
 * create/replay/cursor core as the recent-threads importer. Unknown sessions
 * count as skipped; already-imported ones count as imported.
 */
export const importAgentSessionsById = Effect.fn("importAgentSessionsById")(function* (
  input: AgentSessionImportSessionsInput,
) {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const crypto = yield* Crypto.Crypto;
  const project = yield* snapshots.getProjectShellById(input.projectId).pipe(
    Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new AgentSessionImportProjectNotFoundError({ projectId: input.projectId })),
        onSome: Effect.succeed,
      }),
    ),
  );
  const workspaceRoot = project.workspaceRoot;
  if (
    input.expectedWorkspaceRoot !== undefined &&
    normalizeProjectPathForComparison(workspaceRoot) !==
      normalizeProjectPathForComparison(input.expectedWorkspaceRoot)
  ) {
    return yield* new AgentSessionImportProjectChangedError({ projectId: input.projectId });
  }
  const completedSources = yield* snapshots
    .getImportedAgentSessionSources(input.projectId)
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );

  const requested = new Map<string, AgentSessionImportSessionsInput["sessions"][number]>();
  for (const session of input.sessions) {
    requested.set(`${session.providerInstanceId}\0${session.providerSessionId}`, session);
  }

  const listed = yield* scanner.listSessionThreads(
    workspaceRoot,
    completedSources.map((entry) => entry.source),
  );

  const importedThreadIds = new Set<ThreadId>();
  const updatedThreadIds = new Set<ThreadId>();
  let importedCount = 0;
  let skippedCount = 0;
  for (const entry of listed) {
    const key = `${entry.thread.providerInstanceId}\0${entry.thread.providerSessionId}`;
    if (!requested.has(key)) continue;
    requested.delete(key);
    const isUpdate = input.mode !== "fresh" && entry.alreadyImported && entry.stale;
    const imported = yield* importTranscriptCore({
      projectId: input.projectId,
      workspaceRoot,
      transcript: entry.thread,
      replace: isUpdate,
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not import an agent session", {
          provider: entry.thread.source,
          sessionId: entry.thread.providerSessionId,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );
    const threadId = ThreadId.make(
      `import:${entry.thread.providerInstanceId}:${entry.thread.providerSessionId}`,
    );
    if (imported) {
      yield* directory
        .recordImportedTranscript({ threadId, source: entry.source })
        .pipe(Effect.ignore);
      importedThreadIds.add(threadId);
      importedCount += 1;
      if (isUpdate) updatedThreadIds.add(threadId);
    } else {
      skippedCount += 1;
    }
  }

  // Sessions the scanner could not resolve (deleted transcript, excluded
  // root, parse failure) read as skipped rather than silently vanishing.
  skippedCount += requested.size;

  return {
    importedCount,
    skippedCount,
    ...(updatedThreadIds.size > 0 ? { updatedCount: updatedThreadIds.size } : {}),
  } satisfies AgentSessionImportResult;
});

/**
 * Whether an imported thread's transcript moved on disk since the import.
 * Compares the recorded source file identities against fresh stats, so a
 * right-click menu can gate the "bring up to date" action without reparsing
 * any transcript.
 */
export const getImportedThreadSyncState = Effect.fn("getImportedThreadSyncState")(function* (
  input: AgentSessionThreadSyncInput,
) {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const fileSystem = yield* FileSystem.FileSystem;
  const threadId = input.threadId;
  if (!threadId.startsWith("import:")) {
    return { imported: false, stale: false } satisfies AgentSessionThreadSyncResult;
  }
  const threadShell = yield* snapshots
    .getThreadShellById(threadId)
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
  if (Option.isNone(threadShell)) {
    // The thread may have been deleted by the user; nothing to sync.
    return { imported: false, stale: false } satisfies AgentSessionThreadSyncResult;
  }
  const recorded = yield* snapshots
    .getImportedAgentSessionSources(threadShell.value.projectId)
    .pipe(
      Effect.mapError((cause) => new AgentSessionScanError({ operation: "read-projects", cause })),
    );
  const sources = recorded
    .filter((entry) => entry.threadId === threadId)
    .map((entry) => entry.source);
  if (sources.length === 0) {
    return { imported: true, stale: false } satisfies AgentSessionThreadSyncResult;
  }
  const stale = yield* Effect.forEach(sources, (source) =>
    fileSystem.stat(source.filePath).pipe(
      Effect.option,
      Effect.map(
        (statsOption) =>
          Option.isSome(statsOption) && !sameRecordedIdentity(source, statsOption.value),
      ),
    ),
  ).pipe(Effect.map((results) => results.some(Boolean)));
  return { imported: true, stale } satisfies AgentSessionThreadSyncResult;
});

/** Identity fields a recorded import source must match against the live file. */
function sameRecordedIdentity(
  source: AgentSessionImportSource,
  stats: FileSystem.File.Info,
): boolean {
  const mtimeMs = Option.getOrNull(stats.mtime);
  const inode = Option.getOrNull(stats.ino);
  return Number(stats.size) === source.size && mtimeMs === source.mtimeMs && inode === source.inode;
}
