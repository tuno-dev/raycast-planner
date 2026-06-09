import { execFile, spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Cache, environment, LocalStorage } from "@raycast/api";

import { formatEventTime, getDayRange } from "./date";
import { mergeEventsWithOverlay } from "./planner";
import type {
  AutoOpenExecutionState,
  GoogleCalendarEvent,
  LocalPlannerEvent,
  PlannerOverlay,
  SharedNoteHistoryEntry,
} from "./types";

const AUTO_OPEN_STATE_KEY = "planner.auto-open-state.v1";
const EVENTS_CACHE_KEY = "planner.cached-events.v1";
const EVENTS_CACHE_META_KEY = "planner.cached-events-meta.v1";
const FETCHED_GOOGLE_EVENTS_KEY = "planner.google-events-by-day.v1";
const JOURNAL_COUNTER_KEY = "planner.journal-counter.v1";
const LOCAL_EVENTS_KEY = "planner.local-events.v1";
const LOCAL_EVENTS_FILE = "events.md";
const NOTES_BY_DAY_KEY = "planner.notes-by-day.v1";
const NOTE_SECTION_END = "<!-- planner-note-end -->";
const NOTE_SECTION_START = "<!-- planner-note-start -->";
const OVERLAYS_KEY = "planner.overlays.v1";
const PLANNER_DATA_FILE = "planner.md";
const PLANNER_DATABASE_FILE = "planner.sqlite";
const PLANNER_JOURNAL_FILE = "planner-log.jsonl";
const PLANNER_KV_TABLE = "planner_kv";
const PLANNER_NOTE_HISTORY_TABLE = "planner_note_history";
const SHARED_NOTE_HISTORY_KEY = "planner.shared-note-history.v1";
const SHARED_NOTE_KEY = "planner.shared-note.v1";
const SHARED_NOTES_FILE = "memo.md";
const SNAPSHOT_DIRECTORY = "snapshots";
const SNAPSHOT_INTERVAL = 10;
const SNAPSHOT_KEEP_COUNT = 20;
// sqlite CLI の busy_timeout に加えて、短い再試行で一時的な locked を吸収する。
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_BINARIES = [
  "/usr/bin/sqlite3",
  "/opt/homebrew/bin/sqlite3",
  "/usr/local/bin/sqlite3",
];
const SQLITE_LOCK_RETRY_COUNT = 3;
const SQLITE_LOCK_RETRY_DELAY_MS = 150;
const cache = new Cache();
const execFileAsync = promisify(execFile);

let databasePromise: Promise<void> | undefined;
let migrationPromise: Promise<void> | undefined;
let sqliteQueue: Promise<void> = Promise.resolve();

type CachedEventsMeta = {
  cachedAt: string;
  calendarId: string;
  dayKey: string;
};

type GoogleEventsByDay = Record<string, GoogleCalendarEvent[]>;

type PlannerState = {
  fetchedGoogleEventsByDay: GoogleEventsByDay;
  localEvents: LocalPlannerEvent[];
  notesByDay: Record<string, string>;
  overlayMap: Record<string, PlannerOverlay>;
};

type PlannerJournalEntry = {
  payload: unknown;
  timestamp: string;
  type:
    | "google_events_saved"
    | "local_events_saved"
    | "notes_saved"
    | "overlay_map_saved";
};

type PlannerSnapshot = {
  createdAt: string;
  reason: PlannerJournalEntry["type"];
  state: PlannerState;
  version: 1;
};

const PLANNER_STATE_KEYS = [
  FETCHED_GOOGLE_EVENTS_KEY,
  LOCAL_EVENTS_KEY,
  NOTES_BY_DAY_KEY,
  OVERLAYS_KEY,
] as const;

export const loadOverlayMap = async (): Promise<
  Record<string, PlannerOverlay>
> => {
  await ensurePlannerDataMigrated();
  return await loadSqliteJson(OVERLAYS_KEY, {});
};

export const saveOverlayMap = async (
  overlayMap: Record<string, PlannerOverlay>,
) => {
  await writePlannerState(
    { overlayMap },
    {
      payload: { overlayMap },
      timestamp: new Date().toISOString(),
      type: "overlay_map_saved",
    },
  );
};

export const loadAutoOpenState = async (): Promise<AutoOpenExecutionState> =>
  await loadJson(AUTO_OPEN_STATE_KEY, {});

export const saveAutoOpenState = async (state: AutoOpenExecutionState) =>
  await saveJson(AUTO_OPEN_STATE_KEY, state);

export const loadLocalEvents = async (): Promise<LocalPlannerEvent[]> =>
  dedupeLocalEvents((await loadPlannerState()).localEvents);

export const saveLocalEvents = async (events: LocalPlannerEvent[]) => {
  await writePlannerState(
    { localEvents: dedupeLocalEvents(events) },
    {
      payload: { events: dedupeLocalEvents(events) },
      timestamp: new Date().toISOString(),
      type: "local_events_saved",
    },
  );
};

export const loadSharedNote = async (dayKey: string): Promise<string> =>
  (await loadPlannerState()).notesByDay[dayKey] ?? "";

export const saveSharedNote = async (dayKey: string, note: string) => {
  await ensurePlannerDataMigrated();
  const notesByDay = {
    ...(await loadSqliteJson<Record<string, string>>(NOTES_BY_DAY_KEY, {})),
  };
  if (note.trim()) {
    notesByDay[dayKey] = note;
  } else {
    delete notesByDay[dayKey];
  }

  await writePlannerState(
    { notesByDay },
    {
      payload: { dayKey, note: notesByDay[dayKey] ?? "" },
      timestamp: new Date().toISOString(),
      type: "notes_saved",
    },
  );
};

export const loadSharedNoteHistory = async (): Promise<
  SharedNoteHistoryEntry[]
> => {
  await ensurePlannerDataMigrated();
  return await querySqliteJson<SharedNoteHistoryEntry>(
    `SELECT day_key AS dayKey, before_text AS before, after_text AS after, created_at AS timestamp
     FROM ${PLANNER_NOTE_HISTORY_TABLE}
     ORDER BY created_at DESC
     LIMIT 200`,
  );
};

export const appendSharedNoteHistory = async (
  entry: SharedNoteHistoryEntry,
) => {
  await ensurePlannerDataMigrated();
  await runSqlite(`
    INSERT INTO ${PLANNER_NOTE_HISTORY_TABLE} (id, day_key, before_text, after_text, created_at)
    VALUES (
      ${sqlValue(`${entry.timestamp}:${entry.dayKey}:${Math.random().toString(36).slice(2)}`)},
      ${sqlValue(entry.dayKey)},
      ${sqlValue(entry.before)},
      ${sqlValue(entry.after)},
      ${sqlValue(entry.timestamp)}
    );
    DELETE FROM ${PLANNER_NOTE_HISTORY_TABLE}
    WHERE id IN (
      SELECT id
      FROM ${PLANNER_NOTE_HISTORY_TABLE}
      ORDER BY created_at DESC
      LIMIT -1 OFFSET 200
    );
  `);
};

export const loadCachedEvents = (
  calendarId: string,
  dayKey: string,
): { cachedAt?: string; events: GoogleCalendarEvent[] } | undefined => {
  const rawMeta = cache.get(EVENTS_CACHE_META_KEY);
  const rawEvents = cache.get(EVENTS_CACHE_KEY);

  if (!rawMeta || !rawEvents) {
    return undefined;
  }

  const meta = safeParse<CachedEventsMeta | undefined>(rawMeta, undefined);
  if (!meta || meta.calendarId !== calendarId || meta.dayKey !== dayKey) {
    return undefined;
  }

  const events = safeParse<GoogleCalendarEvent[] | undefined>(
    rawEvents,
    undefined,
  );
  if (!events) {
    return undefined;
  }

  return { events, cachedAt: meta.cachedAt };
};

export const saveCachedEvents = (
  calendarId: string,
  dayKey: string,
  events: GoogleCalendarEvent[],
) => {
  cache.set(
    EVENTS_CACHE_META_KEY,
    JSON.stringify({
      cachedAt: new Date().toISOString(),
      calendarId,
      dayKey,
    } satisfies CachedEventsMeta),
  );
  cache.set(EVENTS_CACHE_KEY, JSON.stringify(events));
};

export const clearCachedEvents = () => {
  cache.remove(EVENTS_CACHE_KEY);
  cache.remove(EVENTS_CACHE_META_KEY);
};

export const saveFetchedGoogleEvents = async (
  dayKey: string,
  events: GoogleCalendarEvent[],
) => {
  await ensurePlannerDataMigrated();
  const fetchedGoogleEventsByDay = {
    ...(await loadSqliteJson<GoogleEventsByDay>(FETCHED_GOOGLE_EVENTS_KEY, {})),
  };
  if (events.length) {
    fetchedGoogleEventsByDay[dayKey] = events;
  } else {
    delete fetchedGoogleEventsByDay[dayKey];
  }

  await writePlannerState(
    { fetchedGoogleEventsByDay },
    {
      payload: { dayKey, events },
      timestamp: new Date().toISOString(),
      type: "google_events_saved",
    },
  );
};

export const ensurePlannerDataFile = async (): Promise<string> => {
  await rewritePlannerFile(await loadPlannerState());
  return path.join(environment.supportPath, PLANNER_DATA_FILE);
};

export const ensurePlannerStorageReady = async () => {
  await ensurePlannerDataMigrated();
};

export const getPlannerDatabasePath = (): string =>
  path.join(environment.supportPath, PLANNER_DATABASE_FILE);

const finalizePlannerWrite = async (
  entry: PlannerJournalEntry,
  state: PlannerState,
) => {
  await appendPlannerJournal(entry);
  await maybeWriteSnapshot(entry.type, state);
  await rewritePlannerFile(state);
};

const ensurePlannerDataMigrated = async () => {
  migrationPromise ??= migratePlannerData();
  await migrationPromise;
};

const ensurePlannerDatabase = async () => {
  databasePromise ??= runSqlite(`
    -- 読み書き競合を緩和するため WAL を有効化する。
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS ${PLANNER_KV_TABLE} (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${PLANNER_NOTE_HISTORY_TABLE} (
      id TEXT PRIMARY KEY,
      day_key TEXT NOT NULL,
      before_text TEXT NOT NULL,
      after_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  await databasePromise;
};

const migratePlannerData = async () => {
  await ensurePlannerDatabase();
  const [sqliteNotesByDay, sqliteLocalEvents, sqliteOverlayMap, sqliteGoogle] =
    await Promise.all([
      loadSqliteJson<Record<string, string>>(NOTES_BY_DAY_KEY, {}),
      loadSqliteJson(LOCAL_EVENTS_KEY, [] as LocalPlannerEvent[]),
      loadSqliteJson<Record<string, PlannerOverlay>>(OVERLAYS_KEY, {}),
      loadSqliteJson<GoogleEventsByDay>(FETCHED_GOOGLE_EVENTS_KEY, {}),
    ]);

  const [notesByDay, localEvents, overlayMap, fetchedGoogleEventsByDay] =
    await Promise.all([
      loadJson<Record<string, string>>(NOTES_BY_DAY_KEY, {}),
      loadJson(LOCAL_EVENTS_KEY, [] as LocalPlannerEvent[]),
      loadJson<Record<string, PlannerOverlay>>(OVERLAYS_KEY, {}),
      loadJson<GoogleEventsByDay>(FETCHED_GOOGLE_EVENTS_KEY, {}),
    ]);
  const plannerData =
    Object.keys(notesByDay).length ||
    localEvents.length ||
    Object.keys(overlayMap).length ||
    Object.keys(fetchedGoogleEventsByDay).length
      ? { events: localEvents, notes: notesByDay }
      : await loadLegacyPlannerData();
  const nextNotesByDay = Object.keys(sqliteNotesByDay).length
    ? sqliteNotesByDay
    : Object.keys(notesByDay).length
      ? notesByDay
      : plannerData.notes;
  const nextLocalEvents = sqliteLocalEvents.length
    ? sqliteLocalEvents
    : localEvents.length
      ? localEvents
      : plannerData.events;
  const nextOverlayMap = Object.keys(sqliteOverlayMap).length
    ? sqliteOverlayMap
    : overlayMap;
  const nextFetchedGoogleEventsByDay = Object.keys(sqliteGoogle).length
    ? sqliteGoogle
    : fetchedGoogleEventsByDay;

  await maybeSaveSqliteJson(NOTES_BY_DAY_KEY, sqliteNotesByDay, nextNotesByDay);
  await maybeSaveSqliteJson(
    LOCAL_EVENTS_KEY,
    sqliteLocalEvents,
    dedupeLocalEvents(nextLocalEvents),
  );
  await maybeSaveSqliteJson(OVERLAYS_KEY, sqliteOverlayMap, nextOverlayMap);
  await maybeSaveSqliteJson(
    FETCHED_GOOGLE_EVENTS_KEY,
    sqliteGoogle,
    nextFetchedGoogleEventsByDay,
  );

  if (!(await hasSqliteNoteHistory())) {
    const history = await loadJson<SharedNoteHistoryEntry[]>(
      SHARED_NOTE_HISTORY_KEY,
      [],
    );
    if (history.length) {
      await runSqlite(
        history
          .map(
            (entry, index) => `
              INSERT OR REPLACE INTO ${PLANNER_NOTE_HISTORY_TABLE} (id, day_key, before_text, after_text, created_at)
              VALUES (
                ${sqlValue(`${entry.timestamp}:${entry.dayKey}:${index}`)},
                ${sqlValue(entry.dayKey)},
                ${sqlValue(entry.before)},
                ${sqlValue(entry.after)},
                ${sqlValue(entry.timestamp)}
              )`,
          )
          .join(";\n"),
      );
    }
  }

  await Promise.all([
    LocalStorage.removeItem(JOURNAL_COUNTER_KEY),
    LocalStorage.removeItem(NOTES_BY_DAY_KEY),
    LocalStorage.removeItem(LOCAL_EVENTS_KEY),
    LocalStorage.removeItem(OVERLAYS_KEY),
    LocalStorage.removeItem(FETCHED_GOOGLE_EVENTS_KEY),
    LocalStorage.removeItem(SHARED_NOTE_HISTORY_KEY),
    LocalStorage.removeItem(SHARED_NOTE_KEY),
    rm(path.join(environment.supportPath, LOCAL_EVENTS_FILE), {
      force: true,
    }),
    rm(path.join(environment.supportPath, SHARED_NOTES_FILE), {
      force: true,
    }),
  ]);
};

const writePlannerState = async (
  partial: Partial<PlannerState>,
  entry: PlannerJournalEntry,
) => {
  await ensurePlannerDataMigrated();
  const state = await loadPlannerState(partial);
  const statements = [
    partial.notesByDay !== undefined
      ? saveSqliteJsonStatement(NOTES_BY_DAY_KEY, state.notesByDay)
      : "",
    partial.localEvents !== undefined
      ? saveSqliteJsonStatement(
          LOCAL_EVENTS_KEY,
          dedupeLocalEvents(state.localEvents),
        )
      : "",
    partial.overlayMap !== undefined
      ? saveSqliteJsonStatement(OVERLAYS_KEY, state.overlayMap)
      : "",
    partial.fetchedGoogleEventsByDay !== undefined
      ? saveSqliteJsonStatement(
          FETCHED_GOOGLE_EVENTS_KEY,
          state.fetchedGoogleEventsByDay,
        )
      : "",
  ].filter(Boolean);

  if (statements.length) {
    await runSqlite(`BEGIN IMMEDIATE;\n${statements.join("\n")}\nCOMMIT;`);
  }
  await finalizePlannerWrite(entry, state);
};

const loadPlannerState = async (
  partial?: Partial<PlannerState>,
): Promise<PlannerState> => {
  await ensurePlannerDataMigrated();
  const missingKeys = PLANNER_STATE_KEYS.filter((key) => {
    if (key === NOTES_BY_DAY_KEY) {
      return partial?.notesByDay === undefined;
    }
    if (key === LOCAL_EVENTS_KEY) {
      return partial?.localEvents === undefined;
    }
    if (key === OVERLAYS_KEY) {
      return partial?.overlayMap === undefined;
    }
    return partial?.fetchedGoogleEventsByDay === undefined;
  });
  const rows = missingKeys.length
    ? await querySqliteJson<{ key: string; value_json: string }>(
        `SELECT key, value_json FROM ${PLANNER_KV_TABLE} WHERE key IN (${missingKeys.map(sqlValue).join(", ")})`,
      )
    : [];
  const values = Object.fromEntries(
    rows.map((row) => [row.key, safeParse(row.value_json, undefined)]),
  ) as Partial<Record<(typeof PLANNER_STATE_KEYS)[number], unknown>>;

  return {
    fetchedGoogleEventsByDay:
      partial?.fetchedGoogleEventsByDay ??
      (values[FETCHED_GOOGLE_EVENTS_KEY] as GoogleEventsByDay | undefined) ??
      {},
    localEvents: dedupeLocalEvents(
      partial?.localEvents ??
        (values[LOCAL_EVENTS_KEY] as LocalPlannerEvent[] | undefined) ??
        [],
    ),
    notesByDay:
      partial?.notesByDay ??
      (values[NOTES_BY_DAY_KEY] as Record<string, string> | undefined) ??
      {},
    overlayMap:
      partial?.overlayMap ??
      (values[OVERLAYS_KEY] as Record<string, PlannerOverlay> | undefined) ??
      {},
  };
};

const appendPlannerJournal = async (entry: PlannerJournalEntry) => {
  await mkdir(environment.supportPath, { recursive: true });
  await appendFile(
    path.join(environment.supportPath, PLANNER_JOURNAL_FILE),
    `${JSON.stringify(entry)}\n`,
    "utf8",
  );
  const nextCounter =
    (await loadSqliteJson<number>(JOURNAL_COUNTER_KEY, 0)) + 1;
  await saveSqliteJson(JOURNAL_COUNTER_KEY, nextCounter);
};

const maybeWriteSnapshot = async (
  reason: PlannerJournalEntry["type"],
  state: PlannerState,
) => {
  const journalCounter = await loadSqliteJson<number>(JOURNAL_COUNTER_KEY, 0);
  if (journalCounter !== 1 && journalCounter % SNAPSHOT_INTERVAL !== 0) {
    return;
  }

  const createdAt = new Date().toISOString();
  const snapshot: PlannerSnapshot = {
    createdAt,
    reason,
    state,
    version: 1,
  };
  const snapshotDirectory = path.join(
    environment.supportPath,
    SNAPSHOT_DIRECTORY,
  );
  await mkdir(snapshotDirectory, { recursive: true });
  await writeFile(
    path.join(snapshotDirectory, `${createdAt.replace(/[:.]/g, "-")}.json`),
    JSON.stringify(snapshot, null, 2),
    "utf8",
  );

  const snapshots = (await readdir(snapshotDirectory))
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();
  const redundantSnapshots = snapshots.slice(
    0,
    Math.max(0, snapshots.length - SNAPSHOT_KEEP_COUNT),
  );
  await Promise.all(
    redundantSnapshots.map((fileName) =>
      rm(path.join(snapshotDirectory, fileName), { force: true }),
    ),
  );
};

const rewritePlannerFile = async (state: PlannerState) => {
  await mkdir(environment.supportPath, { recursive: true });
  await writeFile(
    path.join(environment.supportPath, PLANNER_DATA_FILE),
    renderPlannerMarkdown(state),
    "utf8",
  );
};

const maybeSaveSqliteJson = async (
  key: string,
  currentValue: unknown,
  nextValue: unknown,
) => {
  if (!isSameJson(currentValue, nextValue)) {
    await saveSqliteJson(key, nextValue);
  }
};

// Migration
const loadLegacyPlannerData = async () => {
  return (
    (await loadLegacySupportData(PLANNER_DATA_FILE, parsePlannerMarkdown)) ?? {
      events: await loadLegacyLocalEvents(),
      notes: await loadLegacyNotes(),
    }
  );
};

const loadLegacyNotes = async (): Promise<Record<string, string>> => {
  const legacyNote = await LocalStorage.getItem<string>(SHARED_NOTE_KEY);
  return (
    (await loadLegacySupportData(SHARED_NOTES_FILE, parseSharedNotes)) ??
    (legacyNote?.trim()
      ? {
          [getDayRange(new Date()).dayKey]: legacyNote,
        }
      : {})
  );
};

const loadLegacyLocalEvents = async (): Promise<LocalPlannerEvent[]> => {
  return (
    (await loadLegacySupportData(
      LOCAL_EVENTS_FILE,
      parseLocalEventsMarkdown,
    )) ?? (await loadJson(LOCAL_EVENTS_KEY, [] as LocalPlannerEvent[]))
  );
};

const readSupportFile = async (fileName: string) =>
  await readFile(path.join(environment.supportPath, fileName), "utf8");

const loadLegacySupportData = async <T>(
  fileName: string,
  parse: (content: string) => T,
) => {
  try {
    return parse(await readSupportFile(fileName));
  } catch {
    return undefined;
  }
};

const parsePlannerMarkdown = (markdown: string) => {
  const normalized = normalizeNewlines(markdown);
  const notes = Object.fromEntries(
    Array.from(normalized.matchAll(DAY_SECTION_PATTERN)).flatMap(
      ([, dayKey, section]) => {
        const note = section.match(NOTE_SECTION_PATTERN)?.[1]?.trim();
        return note ? [[dayKey, note]] : [];
      },
    ),
  );
  const events = Array.from(
    normalized.matchAll(LOCAL_EVENT_COMMENT_PATTERN),
    ([, payload]) => {
      try {
        return JSON.parse(decodeURIComponent(payload)) as LocalPlannerEvent;
      } catch {
        return undefined;
      }
    },
  ).filter((event): event is LocalPlannerEvent => Boolean(event?.id));

  return { events: dedupeLocalEvents(events), notes };
};

const parseSharedNotes = (markdown: string): Record<string, string> => {
  const notes: Record<string, string> = {};
  let currentDayKey = "";
  let buffer: string[] = [];

  for (const line of normalizeNewlines(markdown).split("\n")) {
    const matchedDayKey = line.match(/^## (\d{4}-\d{2}-\d{2})$/)?.[1];
    if (matchedDayKey) {
      if (currentDayKey) {
        notes[currentDayKey] = buffer.join("\n").trim();
      }

      currentDayKey = matchedDayKey;
      buffer = [];
      continue;
    }

    if (currentDayKey) {
      buffer.push(line);
    }
  }

  if (currentDayKey) {
    notes[currentDayKey] = buffer.join("\n").trim();
  }

  return notes;
};

const parseLocalEventsMarkdown = (markdown: string): LocalPlannerEvent[] => {
  const events: LocalPlannerEvent[] = [];
  const blocks = normalizeNewlines(markdown).matchAll(
    /^## (local:[^\n]+)\n```json\n([\s\S]*?)\n```\n?/gm,
  );

  for (const [, id, rawEvent] of blocks) {
    try {
      const event = JSON.parse(rawEvent) as LocalPlannerEvent;
      if (event.id === id) {
        events.push(event);
      }
    } catch {
      // Ignore broken blocks and keep loading the rest.
    }
  }

  return dedupeLocalEvents(events);
};

const renderPlannerMarkdown = ({
  fetchedGoogleEventsByDay,
  localEvents,
  notesByDay,
  overlayMap,
}: PlannerState): string => {
  const sections = collectPlannerDayKeys(
    localEvents,
    notesByDay,
    fetchedGoogleEventsByDay,
    overlayMap,
  )
    .map((dayKey) =>
      renderDaySection(
        dayKey,
        notesByDay[dayKey] ?? "",
        fetchedGoogleEventsByDay[dayKey] ?? [],
        localEvents,
        overlayMap,
      ),
    )
    .filter(Boolean);
  const body = sections.length
    ? sections.join("\n\n")
    : "予定やメモはまだありません。";

  return [
    "# Planner",
    "",
    "このファイルは Planner が自動生成します。",
    "手で編集してもアプリには戻りません。",
    "",
    body,
    "",
  ].join("\n");
};

const collectPlannerDayKeys = (
  localEvents: LocalPlannerEvent[],
  notes: Record<string, string>,
  googleEventsByDay: GoogleEventsByDay,
  overlayMap: Record<string, PlannerOverlay>,
): string[] => {
  const dayKeys = new Set<string>([
    ...Object.keys(notes),
    ...Object.keys(googleEventsByDay),
  ]);

  for (const event of localEvents) {
    const completedDayKey = overlayMap[event.id]?.completedAt
      ? getDayRange(new Date(overlayMap[event.id].completedAt as string)).dayKey
      : undefined;
    const startDayKey = getDayRange(new Date(event.start)).dayKey;
    const endDayKey = event.anytime
      ? (completedDayKey ?? startDayKey)
      : completedDayKey &&
          completedDayKey < getDayRange(new Date(event.end)).dayKey
        ? completedDayKey
        : getDayRange(new Date(event.end)).dayKey;

    for (const dayKey of enumerateDayKeys(startDayKey, endDayKey)) {
      dayKeys.add(dayKey);
    }
  }

  return [...dayKeys].sort();
};

const renderDaySection = (
  dayKey: string,
  note: string,
  googleEvents: GoogleCalendarEvent[],
  localEvents: LocalPlannerEvent[],
  overlayMap: Record<string, PlannerOverlay>,
): string => {
  const visibleLocalEvents = localEvents.filter((event) =>
    isLocalEventVisibleOnDay(event, dayKey),
  );
  const events = mergeEventsWithOverlay(
    googleEvents,
    overlayMap,
    visibleLocalEvents,
    parseDayKey(dayKey),
  );
  const googleSection = events
    .filter((event) => event.source === "google")
    .map((event) => renderEventBlock(event, false))
    .join("\n\n");
  const localSection = events
    .filter((event) => event.source === "local")
    .map((event) => renderEventBlock(event, true))
    .join("\n\n");
  const sections = [
    note.trim()
      ? `### メモ\n${NOTE_SECTION_START}\n${note.trim()}\n${NOTE_SECTION_END}`
      : "",
    googleSection ? `### Google予定\n${googleSection}` : "",
    localSection ? `### ローカル予定\n${localSection}` : "",
  ].filter(Boolean);

  if (!sections.length) {
    return "";
  }

  return `## ${dayKey}\n\n${sections.join("\n\n")}`;
};

const renderEventBlock = (
  event: Awaited<ReturnType<typeof mergeEventsWithOverlay>>[number],
  includeLocalPayload: boolean,
): string => {
  const lines = [
    `#### ${event.title.replace(/\n+/g, " ")}`,
    `- 時間: ${formatEventTime(
      event.start,
      event.end,
      event.isAllDay,
      event.isAnytime,
    )}`,
    `- 種別: ${event.source === "local" ? "ローカル予定" : "Google予定"}`,
    `- 状態: ${event.completed ? "完了" : "予定"}`,
  ];

  if (event.location) {
    lines.push(`- 場所: ${event.location}`);
  }

  const links = event.links
    .map((link) => {
      const label =
        link.type === "ovice"
          ? "ovice"
          : link.type === "meet"
            ? "Google Meet"
            : link.type === "calendar"
              ? "Google Calendar"
              : link.label;
      return `[${label}](${link.url})`;
    })
    .join(" / ");
  if (links) {
    lines.push(`- リンク: ${links}`);
  }

  if (event.description?.trim()) {
    lines.push("- 説明:");
    lines.push(
      event.description
        .trim()
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    );
  }

  if (includeLocalPayload && event.source === "local") {
    lines.push(`<!-- planner-local-event: ${encodeLocalEvent(event)} -->`);
  }

  return lines.join("\n");
};

const encodeLocalEvent = (event: LocalPlannerEvent): string =>
  encodeURIComponent(JSON.stringify(event satisfies LocalPlannerEvent));

const isLocalEventVisibleOnDay = (
  event: LocalPlannerEvent,
  dayKey: string,
): boolean => {
  if (event.anytime) {
    return dayKey >= getDayRange(new Date(event.start)).dayKey;
  }

  return (
    dayKey >= getDayRange(new Date(event.start)).dayKey &&
    dayKey <= getDayRange(new Date(event.end)).dayKey
  );
};

const enumerateDayKeys = (startDayKey: string, endDayKey: string): string[] => {
  if (endDayKey < startDayKey) {
    return [startDayKey];
  }

  const dayKeys: string[] = [];
  const cursor = parseDayKey(startDayKey);
  const end = parseDayKey(endDayKey);

  while (cursor.getTime() <= end.getTime()) {
    dayKeys.push(getDayRange(cursor).dayKey);
    cursor.setDate(cursor.getDate() + 1);
  }

  return dayKeys;
};

const parseDayKey = (dayKey: string): Date => {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(year, month - 1, day);
};

const normalizeNewlines = (text: string): string =>
  text.replace(/\r\n?/g, "\n");

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const DAY_SECTION_PATTERN =
  /^## (\d{4}-\d{2}-\d{2})(?: \([^)]+\))?\n([\s\S]*?)(?=^## \d{4}-\d{2}-\d{2}(?: \([^)]+\))?\n|(?![\s\S]))/gm;
const NOTE_SECTION_PATTERN = new RegExp(
  `### メモ\\n${escapeRegExp(NOTE_SECTION_START)}\\n([\\s\\S]*?)\\n${escapeRegExp(NOTE_SECTION_END)}`,
);
const LOCAL_EVENT_COMMENT_PATTERN = /<!-- planner-local-event: ([^\n]+) -->/g;

const loadSqliteJson = async <T>(key: string, fallback: T): Promise<T> => {
  await ensurePlannerDatabase();
  const rows = await querySqliteJson<{ value_json: string }>(
    `SELECT value_json FROM ${PLANNER_KV_TABLE} WHERE key = ${sqlValue(key)} LIMIT 1`,
  );
  return safeParse(rows[0]?.value_json, fallback);
};

const saveSqliteJson = async (key: string, value: unknown) => {
  await ensurePlannerDatabase();
  await runSqlite(saveSqliteJsonStatement(key, value));
};

const saveSqliteJsonStatement = (key: string, value: unknown) => {
  const timestamp = new Date().toISOString();
  return `
    INSERT INTO ${PLANNER_KV_TABLE} (key, value_json, updated_at)
    VALUES (
      ${sqlValue(key)},
      ${sqlValue(JSON.stringify(value))},
      ${sqlValue(timestamp)}
    )
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at;
  `;
};

const querySqliteJson = async <T>(sql: string): Promise<T[]> => {
  await ensurePlannerDatabase();
  try {
    const stdout = await execSqlite(["-json", getPlannerDatabasePath()], sql);
    return safeParse(stdout.trim(), [] as T[]);
  } catch (error) {
    throw new Error(formatExecError(error));
  }
};

const runSqlite = async (sql: string) => {
  await mkdir(environment.supportPath, { recursive: true });
  try {
    await execSqlite([getPlannerDatabasePath()], sql);
  } catch (error) {
    throw new Error(formatExecError(error));
  }
};

const sqlValue = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const sqliteExecutablePath = async (): Promise<string> => {
  for (const candidate of SQLITE_BINARIES) {
    try {
      await execFileAsync(candidate, ["-version"]);
      return candidate;
    } catch {}
  }

  return "sqlite3";
};

const execSqlite = async (args: string[], sql: string): Promise<string> =>
  await queueSqlite(
    async () =>
      await retryLockedSqlite(
        async () =>
          await new Promise((resolve, reject) => {
            void sqliteExecutablePath().then((sqlitePath) => {
              const child = spawn(sqlitePath, args, {
                stdio: ["pipe", "pipe", "pipe"],
              });
              let stdout = "";
              let stderr = "";

              child.stdout.on("data", (chunk) => {
                stdout += String(chunk);
              });
              child.stderr.on("data", (chunk) => {
                stderr += String(chunk);
              });
              child.on("error", reject);
              child.on("close", (code) => {
                if (code === 0) {
                  resolve(stdout);
                  return;
                }

                reject(
                  new Error(
                    stderr.trim() || `sqlite3 exited with code ${code}`,
                  ),
                );
              });
              child.stdin.end(`.timeout ${SQLITE_BUSY_TIMEOUT_MS}\n${sql}`);
            }, reject);
          }),
      ),
  );

const formatExecError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const retryLockedSqlite = async <T>(run: () => Promise<T>): Promise<T> => {
  let attempt = 0;

  while (true) {
    try {
      return await run();
    } catch (error) {
      if (
        !formatExecError(error).includes("database is locked") ||
        attempt >= SQLITE_LOCK_RETRY_COUNT
      ) {
        throw error;
      }

      attempt += 1;
      await new Promise((resolve) =>
        setTimeout(resolve, SQLITE_LOCK_RETRY_DELAY_MS * attempt),
      );
    }
  }
};

const queueSqlite = async <T>(run: () => Promise<T>): Promise<T> => {
  // sqlite3 CLI を使う自前アクセスは 1 本ずつ流して lock 競合を避ける。
  const task = sqliteQueue.then(run, run);
  sqliteQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return await task;
};

const hasSqliteNoteHistory = async (): Promise<boolean> => {
  const rows = await querySqliteJson<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${PLANNER_NOTE_HISTORY_TABLE}`,
  );
  return Number(rows[0]?.count ?? 0) > 0;
};

const loadJson = async <T>(key: string, fallback: T): Promise<T> => {
  const value = await LocalStorage.getItem<string>(key);
  return safeParse(value, fallback);
};

const saveJson = async (key: string, value: unknown) => {
  await LocalStorage.setItem(key, JSON.stringify(value));
};

const safeParse = <T>(value: string | undefined, fallback: T): T => {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const isSameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const dedupeLocalEvents = (
  events: LocalPlannerEvent[],
): LocalPlannerEvent[] => [
  ...new Map(events.map((event) => [event.id, event])).values(),
];
