import { randomUUID } from "node:crypto";

import {
  Action,
  ActionPanel,
  Form,
  getPreferenceValues,
  Icon,
  List,
  open,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useSQL } from "@raycast/utils";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import {
  formatDateOnlyLabel,
  formatDateTimeLabel,
  formatEventTime,
  getDayRange,
  getRoundedFutureTime,
  isToday,
  shiftDate,
} from "./date";
import { fetchCalendarEvents } from "./gws";
import { buildManualJoinLinks } from "./links";
import { normalizeMemoForSave, renderMemoMarkdown } from "./memo-markdown";
import { mergeEventsWithOverlay } from "./planner";
import {
  appendSharedNoteHistory,
  clearCachedEvents,
  ensurePlannerDataFile,
  ensurePlannerStorageReady,
  getPlannerDatabasePath,
  loadAutoOpenState,
  loadLocalEvents,
  saveAutoOpenState,
  saveFetchedGoogleEvents,
  saveLocalEvents,
  saveOverlayMap,
  saveSharedNote,
} from "./storage";
import type {
  FetchResult,
  LocalPlannerEvent,
  PlannerEventViewModel,
  PlannerOverlay,
  PlannerPreferences,
  SharedNoteHistoryEntry,
} from "./types";

type SqliteKeyValueRow = {
  key: string;
  value_json: string;
};

type SqliteHistoryRow = SharedNoteHistoryEntry;
type PlannerSqlMutate = ReturnType<typeof useSQL<SqliteKeyValueRow>>["mutate"];

const PLANNER_KV_QUERY = `SELECT key, value_json FROM planner_kv WHERE key IN ('planner.notes-by-day.v1', 'planner.local-events.v1', 'planner.overlays.v1')`;
const PLANNER_NOTE_HISTORY_QUERY = `SELECT day_key AS dayKey, before_text AS before, after_text AS after, created_at AS timestamp FROM planner_note_history ORDER BY created_at DESC LIMIT 200`;

const Command = () => {
  const preferences = getPreferenceValues<PlannerPreferences>();
  const gwsPath = preferences.gwsPath.trim();
  const calendarId = preferences.calendarId.trim();
  const { push } = useNavigation();
  const [events, setEvents] = useState<PlannerEventViewModel[]>([]);
  const [targetDate, setTargetDate] = useState(new Date());
  const [isStorageReady, setIsStorageReady] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [lastSource, setLastSource] = useState<"cache" | "local" | "remote">(
    gwsPath && calendarId ? "remote" : "local",
  );
  const canSyncCalendar = gwsPath && calendarId;
  const plannerSql = useSQL<SqliteKeyValueRow>(
    getPlannerDatabasePath(),
    PLANNER_KV_QUERY,
    { execute: isStorageReady },
  );

  const plannerState = useMemo(() => {
    const values = Object.fromEntries(
      (plannerSql.data ?? []).map((row) => {
        try {
          return [row.key, JSON.parse(row.value_json)];
        } catch {
          return [row.key, undefined];
        }
      }),
    ) as {
      "planner.local-events.v1"?: LocalPlannerEvent[];
      "planner.notes-by-day.v1"?: Record<string, string>;
      "planner.overlays.v1"?: Record<string, PlannerOverlay>;
    };

    return {
      localEvents: values["planner.local-events.v1"] ?? [],
      notesByDay: values["planner.notes-by-day.v1"] ?? {},
      overlayMap: values["planner.overlays.v1"] ?? {},
    };
  }, [plannerSql.data]);

  const load = async (forceRefresh = false, date = targetDate) => {
    setIsLoading(true);
    setError(undefined);
    const { dayKey } = getDayRange(date);

    try {
      const result = canSyncCalendar
        ? await fetchCalendarEvents(preferences, date, { forceRefresh })
        : ({
            events: [],
            source: "local",
          } satisfies FetchResult);
      const visibleLocalEvents = plannerState.localEvents.filter((event) => {
        const startDayKey = getDayRange(new Date(event.start)).dayKey;
        const endDayKey = getDayRange(new Date(event.end)).dayKey;
        return event.anytime
          ? dayKey >= startDayKey
          : dayKey >= startDayKey && dayKey <= endDayKey;
      });
      if (canSyncCalendar) {
        await saveFetchedGoogleEvents(dayKey, result.events);
      }

      const nextEvents = mergeEventsWithOverlay(
        result.events,
        plannerState.overlayMap,
        visibleLocalEvents,
        date,
      );

      setEvents(nextEvents);
      setLastSource(result.source);
    } catch (loadError) {
      setError(toErrorMessage(loadError));
      setEvents([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void ensurePlannerStorageReady().then(() => {
      setIsStorageReady(true);
    });
  }, []);

  useEffect(() => {
    if (!isStorageReady || plannerSql.isLoading) {
      return;
    }

    void load(false, targetDate);
  }, [isStorageReady, plannerSql.isLoading, plannerState, targetDate]);

  useEffect(() => {
    const timer = setInterval(() => {
      void maybeAutoOpenJoin(events);
    }, 30_000);

    void maybeAutoOpenJoin(events);
    return () => clearInterval(timer);
  }, [events]);

  const { dayKey, label } = useMemo(
    () => getDayRange(targetDate),
    [targetDate],
  );
  const sharedNote = plannerState.notesByDay[dayKey] ?? "";
  const { completedEvents, floatingEvents, timedEvents } = useMemo(() => {
    const grouped = {
      completedEvents: [] as PlannerEventViewModel[],
      floatingEvents: [] as PlannerEventViewModel[],
      timedEvents: [] as PlannerEventViewModel[],
    };

    for (const event of events) {
      if (event.completed) {
        grouped.completedEvents.push(event);
        continue;
      }

      if (
        event.isAnytime ||
        event.isAllDay ||
        getDayRange(new Date(event.start)).dayKey !==
          getDayRange(new Date(event.end)).dayKey
      ) {
        grouped.floatingEvents.push(event);
        continue;
      }

      grouped.timedEvents.push(event);
    }

    return grouped;
  }, [events]);
  const navigationTitle = useMemo(() => {
    const suffix =
      lastSource === "cache"
        ? "cached"
        : lastSource === "local"
          ? "local"
          : "live";
    return `${label} (${suffix})`;
  }, [label, lastSource]);
  const reload = () => void load(true, targetDate);
  const sync = () =>
    canSyncCalendar
      ? void handleSync(preferences, targetDate, (forceRefresh, date) =>
          load(forceRefresh, date),
        )
      : undefined;
  const movePreviousDay = () =>
    setTargetDate((current) => shiftDate(current, -1));
  const moveNextDay = () => setTargetDate((current) => shiftDate(current, 1));
  const moveToday = () => setTargetDate(new Date());
  const openPlannerFile = () => void ensurePlannerDataFile().then(open);
  const openSharedNoteHistory = () => push(<SharedNoteHistoryList />);
  const openCreateForm = () =>
    push(
      <LocalEventForm
        mode="create"
        mutate={plannerSql.mutate}
        selectedDate={targetDate}
      />,
    );
  const openSharedNoteForm = () =>
    push(
      <TextValueForm
        fieldTitle="メモ"
        initialValue={sharedNote}
        multiline
        navigationTitle={`${label} のメモ`}
        onSubmit={(text) =>
          saveCommonNote(
            plannerSql.mutate,
            plannerState.notesByDay,
            dayKey,
            sharedNote,
            text,
          )
        }
      />,
    );
  const showTodayAction = !isToday(targetDate);
  const addScheduleAction = (
    <Action
      title="予定を追加"
      icon={Icon.Plus}
      shortcut={{ modifiers: ["cmd"], key: "n" }}
      onAction={openCreateForm}
    />
  );
  const dateMoveActions = (
    <>
      <Action
        title="前日へ"
        icon={Icon.ArrowLeft}
        shortcut={{ modifiers: ["cmd"], key: "arrowLeft" }}
        onAction={movePreviousDay}
      />
      <Action
        title="翌日へ"
        icon={Icon.ArrowRight}
        shortcut={{ modifiers: ["cmd"], key: "arrowRight" }}
        onAction={moveNextDay}
      />
      {showTodayAction ? (
        <Action
          title="今日へ戻る"
          icon={Icon.Calendar}
          shortcut={{ modifiers: ["cmd"], key: "arrowUp" }}
          onAction={moveToday}
        />
      ) : null}
    </>
  );
  const globalActionSection = (
    <ActionPanel.Section title="全体">
      {addScheduleAction}
      {canSyncCalendar ? (
        <Action
          title="カレンダーと同期"
          icon={Icon.ArrowClockwise}
          shortcut={{ modifiers: ["cmd"], key: "r" }}
          onAction={sync}
        />
      ) : null}
      {dateMoveActions}
    </ActionPanel.Section>
  );
  const sharedActionSections = (
    <>
      <ActionPanel.Section title="メモ">
        <Action
          title="メモを編集"
          icon={Icon.Document}
          shortcut={{ modifiers: ["cmd"], key: "m" }}
          onAction={openSharedNoteForm}
        />
        <Action
          title="メモ更新履歴"
          icon={Icon.Clock}
          onAction={openSharedNoteHistory}
        />
        <Action
          title="planner.md を開く"
          icon={Icon.Finder}
          onAction={openPlannerFile}
        />
      </ActionPanel.Section>
      {globalActionSection}
    </>
  );
  const rootActions = <ActionPanel>{sharedActionSections}</ActionPanel>;
  const listProps = {
    actions: rootActions,
    isShowingDetail: true,
    navigationTitle,
    searchBarPlaceholder:
      "⌘← 前日, ⌘→ 翌日, ⌘↑ 今日, ⌘N 追加, ⌘D 完了, ⌘M メモ編集, ⌘R 同期, ⌘⌫ 削除",
  } as const;
  const eventSections = [
    { events: timedEvents, title: label },
    { events: floatingEvents, title: "日跨ぎ・日時指定なし" },
    { events: completedEvents, title: "完了" },
  ].filter(({ events, title }) => title === label || events.length);

  if (plannerSql.permissionView) {
    return plannerSql.permissionView;
  }

  if (!isLoading && error) {
    return (
      <List {...listProps}>
        <List.EmptyView
          title="カレンダー取得に失敗しました"
          description={error}
          actions={
            <ActionPanel>
              <Action
                title="再読み込み"
                icon={Icon.ArrowClockwise}
                onAction={reload}
              />
              {addScheduleAction}
            </ActionPanel>
          }
        />
      </List>
    );
  }

  return (
    <List {...listProps} isLoading={isLoading}>
      {eventSections.map(({ events: sectionEvents, title: sectionTitle }) => (
        <List.Section key={sectionTitle} title={sectionTitle}>
          {sectionTitle === label ? (
            <List.Item
              icon={Icon.Document}
              title="メモ"
              subtitle={sharedNote ? "保存済み" : "未入力"}
              accessories={
                sharedNote ? [{ icon: Icon.Document, tooltip: "メモあり" }] : []
              }
              detail={
                <List.Item.Detail markdown={renderMemoMarkdown(sharedNote)} />
              }
              actions={rootActions}
            />
          ) : null}
          {sectionEvents.map((event) => (
            <EventListItem
              event={event}
              key={event.id}
              globalActionSection={globalActionSection}
              mutate={plannerSql.mutate}
              overlayMap={plannerState.overlayMap}
            />
          ))}
        </List.Section>
      ))}
    </List>
  );
};

export default Command;

const EventListItem = ({
  event,
  globalActionSection,
  mutate,
  overlayMap,
}: {
  event: PlannerEventViewModel;
  globalActionSection: ReactNode;
  mutate: PlannerSqlMutate;
  overlayMap: Record<string, PlannerOverlay>;
}) => {
  const { push } = useNavigation();
  const dateLabel = formatDateOnlyLabel(event.start);
  const timeLabel = formatEventTime(
    event.start,
    event.end,
    event.isAllDay,
    event.isAnytime,
  );
  const statusLabel = event.completed ? "完了" : "予定";
  const icon =
    event.source === "local"
      ? Icon.Dot
      : event.joinLink?.type === "ovice"
        ? Icon.TwoPeople
        : event.joinLink
          ? Icon.Video
          : Icon.Calendar;
  const openEditForm = () =>
    event.source === "local"
      ? push(
          <LocalEventForm
            event={event}
            mode="edit"
            mutate={mutate}
            selectedDate={new Date(event.start)}
          />,
        )
      : push(
          <TextValueForm
            description={{ text: event.title, title: "予定" }}
            fieldTitle="タイトル"
            initialValue={event.title === event.summary ? "" : event.title}
            navigationTitle="タイトルを編集"
            onSubmit={(text) =>
              updateOverlay(mutate, overlayMap, event.id, {
                titleOverride: text,
              })
            }
          />,
        );
  const toggleCompleted = () =>
    void updateOverlay(
      mutate,
      overlayMap,
      event.id,
      event.completed
        ? { completed: false, completedAt: undefined }
        : {
            completed: true,
            completedAt: new Date().toISOString(),
          },
    );
  const toggleAutoOpen = () =>
    void updateOverlay(mutate, overlayMap, event.id, {
      autoOpenJoin: !event.autoOpenJoin,
    });
  const deleteEvent = () =>
    void (event.source === "local"
      ? deleteLocalEvent(mutate, event.id)
      : updateOverlay(mutate, overlayMap, event.id, { hidden: true }));

  return (
    <List.Item
      icon={icon}
      title={event.title}
      subtitle={timeLabel}
      detail={
        <List.Item.Detail
          markdown={buildMarkdown(event, dateLabel, timeLabel)}
          metadata={
            <Metadata
              dateLabel={dateLabel}
              event={event}
              statusLabel={statusLabel}
              timeLabel={timeLabel}
            />
          }
        />
      }
      actions={
        <ActionPanel>
          <ActionPanel.Section title="この予定">
            {event.joinLink ? (
              <Action.OpenInBrowser
                title={
                  event.joinLink.type === "ovice"
                    ? "ovice を開く"
                    : "参加リンクを開く"
                }
                url={event.joinLink.url}
                icon={
                  event.joinLink.type === "ovice" ? Icon.TwoPeople : Icon.Video
                }
              />
            ) : null}
            <Action
              title={event.completed ? "未完了に戻す" : "完了にする"}
              icon={Icon.CheckCircle}
              shortcut={{ modifiers: ["cmd"], key: "d" }}
              onAction={toggleCompleted}
            />
            {event.joinLink ? (
              <Action
                title={
                  event.autoOpenJoin
                    ? "参加リンク自動オープンを無効化"
                    : "参加リンク自動オープンを有効化"
                }
                icon={Icon.Alarm}
                shortcut={{ modifiers: ["cmd"], key: "o" }}
                onAction={toggleAutoOpen}
              />
            ) : null}
            <Action
              title={event.source === "local" ? "予定を編集" : "タイトルを編集"}
              icon={Icon.Pencil}
              shortcut={{ modifiers: ["cmd"], key: "t" }}
              onAction={openEditForm}
            />
            <Action
              title="削除"
              icon={Icon.Trash}
              shortcut={{ modifiers: ["cmd"], key: "backspace" }}
              style={Action.Style.Destructive}
              onAction={deleteEvent}
            />
          </ActionPanel.Section>
          {globalActionSection}
        </ActionPanel>
      }
    />
  );
};

const Metadata = ({
  dateLabel,
  event,
  statusLabel,
  timeLabel,
}: {
  dateLabel: string;
  event: PlannerEventViewModel;
  statusLabel: string;
  timeLabel: string;
}) => {
  return (
    <List.Item.Detail.Metadata>
      <List.Item.Detail.Metadata.Label
        title="種別"
        text={event.source === "local" ? "ローカル予定" : "Google Calendar"}
      />
      <List.Item.Detail.Metadata.Label title="日付" text={dateLabel} />
      <List.Item.Detail.Metadata.Label title="時間" text={timeLabel} />
      <List.Item.Detail.Metadata.Label
        title="開始"
        text={formatDateTimeLabel(event.start, event.isAllDay)}
      />
      <List.Item.Detail.Metadata.Label
        title="終了"
        text={formatDateTimeLabel(event.end, event.isAllDay)}
      />
      <List.Item.Detail.Metadata.Label title="状態" text={statusLabel} />
      <List.Item.Detail.Metadata.Label
        title="日時"
        text={event.isAnytime ? "日時指定なし" : "指定あり"}
      />
      {event.location ? (
        <List.Item.Detail.Metadata.Label title="場所" text={event.location} />
      ) : null}
      {event.attendees.length ? (
        <List.Item.Detail.Metadata.TagList title="参加者">
          {event.attendees.map((attendee) => (
            <List.Item.Detail.Metadata.TagList.Item
              key={attendee}
              text={attendee}
            />
          ))}
        </List.Item.Detail.Metadata.TagList>
      ) : null}
      <List.Item.Detail.Metadata.Separator />
      {event.joinLink ? (
        <List.Item.Detail.Metadata.Link
          title="参加リンク"
          text={event.joinLink.label}
          target={event.joinLink.url}
        />
      ) : null}
      {event.htmlLink && event.source === "google" ? (
        <List.Item.Detail.Metadata.Link
          title="Calendar"
          text="Open"
          target={event.htmlLink}
        />
      ) : null}
      <List.Item.Detail.Metadata.Label
        title="自動オープン"
        text={event.autoOpenJoin ? "有効" : "無効"}
      />
    </List.Item.Detail.Metadata>
  );
};

const TextValueForm = ({
  description,
  fieldTitle,
  initialValue,
  multiline = false,
  navigationTitle,
  onSubmit,
}: {
  description?: { text: string; title: string };
  fieldTitle: string;
  initialValue: string;
  multiline?: boolean;
  navigationTitle: string;
  onSubmit: (text: string) => Promise<void>;
}) => {
  const { pop } = useNavigation();
  const [text, setText] = useState(initialValue);
  const submit = () => void onSubmit(text).then(() => pop());

  return (
    <Form
      navigationTitle={navigationTitle}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="保存"
            icon={Icon.Checkmark}
            onSubmit={submit}
          />
        </ActionPanel>
      }
    >
      {description ? (
        <Form.Description title={description.title} text={description.text} />
      ) : null}
      {multiline ? (
        <Form.TextArea
          id="value"
          title={fieldTitle}
          value={text}
          onChange={setText}
        />
      ) : (
        <Form.TextField
          id="value"
          title={fieldTitle}
          value={text}
          onChange={setText}
        />
      )}
    </Form>
  );
};

const LocalEventForm = ({
  event,
  mode,
  mutate,
  selectedDate,
}: {
  event?: PlannerEventViewModel;
  mode: "create" | "edit";
  mutate: PlannerSqlMutate;
  selectedDate: Date;
}) => {
  const { pop } = useNavigation();
  const [title, setTitle] = useState(event?.summary ?? "");
  const [location, setLocation] = useState(event?.location ?? "");
  const [description, setDescription] = useState(event?.description ?? "");
  const [url, setUrl] = useState(event?.joinLink?.url ?? "");
  const [anytime, setAnytime] = useState(event?.isAnytime ?? mode === "create");
  const [start, setStart] = useState<Date>(
    new Date(event?.start ?? defaultStartTime(selectedDate)),
  );
  const [end, setEnd] = useState<Date>(
    new Date(event?.end ?? defaultEndTime(selectedDate)),
  );
  const submit = () =>
    void saveLocalEvent(mutate, {
      anytime,
      description,
      end,
      existingId: event?.id,
      location,
      start,
      title,
      url,
    }).then(() => pop());

  return (
    <Form
      navigationTitle={mode === "create" ? "予定を追加" : "ローカル予定を編集"}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="タイトル"
        value={title}
        onChange={setTitle}
      />
      <Form.Checkbox
        id="anytime"
        label="日時指定なし"
        value={anytime}
        onChange={setAnytime}
      />
      {!anytime ? (
        <>
          <Form.DatePicker
            id="start"
            title="開始"
            type={Form.DatePicker.Type.DateTime}
            value={start}
            onChange={(value) => value && setStart(value)}
          />
          <Form.DatePicker
            id="end"
            title="終了"
            type={Form.DatePicker.Type.DateTime}
            value={end}
            onChange={(value) => value && setEnd(value)}
          />
        </>
      ) : null}
      <Form.TextField
        id="location"
        title="場所"
        value={location}
        onChange={setLocation}
      />
      <Form.TextField id="url" title="参加URL" value={url} onChange={setUrl} />
      <Form.TextArea
        id="description"
        title="説明"
        value={description}
        onChange={setDescription}
      />
    </Form>
  );
};

const SharedNoteHistoryList = () => {
  const [isStorageReady, setIsStorageReady] = useState(false);

  useEffect(() => {
    void ensurePlannerStorageReady().then(() => {
      setIsStorageReady(true);
    });
  }, []);

  if (!isStorageReady) {
    return <List isLoading navigationTitle="メモ更新履歴" />;
  }

  return <SharedNoteHistoryListBody />;
};

const SharedNoteHistoryListBody = () => {
  const historySql = useSQL<SqliteHistoryRow>(
    getPlannerDatabasePath(),
    PLANNER_NOTE_HISTORY_QUERY,
  );

  if (historySql.permissionView) {
    return historySql.permissionView;
  }

  return (
    <List isLoading={historySql.isLoading} navigationTitle="メモ更新履歴">
      {(historySql.data ?? []).map((entry, index) => (
        <List.Item
          key={`${entry.timestamp}-${index}`}
          icon={Icon.Clock}
          title={entry.timestamp}
          subtitle={entry.dayKey}
          detail={
            <List.Item.Detail
              markdown={`# ${entry.timestamp}\n\n## Before\n\n${entry.before || "(empty)"}\n\n## After\n\n${entry.after || "(empty)"}`}
            />
          }
        />
      ))}
    </List>
  );
};

const updatePlannerSqlRows = (
  rows: SqliteKeyValueRow[] | undefined,
  key: string,
  value: unknown,
): SqliteKeyValueRow[] => {
  const nextRow = {
    key,
    value_json: JSON.stringify(value),
  };
  const currentRows = rows ?? [];
  const index = currentRows.findIndex((row) => row.key === key);

  if (index === -1) {
    return [...currentRows, nextRow];
  }

  return currentRows.map((row, currentIndex) =>
    currentIndex === index ? nextRow : row,
  );
};

const dedupeLocalEvents = (
  events: LocalPlannerEvent[],
): LocalPlannerEvent[] => [
  ...new Map(events.map((event) => [event.id, event])).values(),
];

const mutateLocalEvents = async (
  mutate: PlannerSqlMutate,
  nextEvents: LocalPlannerEvent[],
) => {
  const uniqueEvents = dedupeLocalEvents(nextEvents);
  await mutate(saveLocalEvents(uniqueEvents), {
    optimisticUpdate(data) {
      return updatePlannerSqlRows(
        data,
        "planner.local-events.v1",
        uniqueEvents,
      );
    },
  });
};

const saveLocalEvent = async (
  mutate: PlannerSqlMutate,
  input: {
    anytime: boolean;
    description: string;
    end: Date;
    existingId?: string;
    location: string;
    start: Date;
    title: string;
    url: string;
  },
) => {
  const localEvents = await loadLocalEvents();
  const localEvent: LocalPlannerEvent = {
    anytime: input.anytime,
    attendees: [],
    createdAt:
      localEvents.find((event) => event.id === input.existingId)?.createdAt ??
      (input.anytime ? input.start : new Date()).toISOString(),
    description: input.description.trim() || undefined,
    end: (input.anytime ? input.start : input.end).toISOString(),
    htmlLink: undefined,
    id: input.existingId ?? `local:${randomUUID()}`,
    isAllDay:
      !input.anytime &&
      input.start.getHours() === 0 &&
      input.start.getMinutes() === 0 &&
      input.end.getHours() === 0 &&
      input.end.getMinutes() === 0,
    links: buildManualJoinLinks(input.url),
    location: input.location.trim() || undefined,
    source: "local",
    start: input.start.toISOString(),
    summary: input.title.trim() || "(No title)",
  };

  const nextEvents = input.existingId
    ? localEvents.map((event) =>
        event.id === input.existingId ? localEvent : event,
      )
    : [...localEvents, localEvent];
  await mutateLocalEvents(mutate, nextEvents);
};

const deleteLocalEvent = async (mutate: PlannerSqlMutate, eventId: string) => {
  const localEvents = await loadLocalEvents();
  const nextEvents = localEvents.filter((event) => event.id !== eventId);
  await mutateLocalEvents(mutate, nextEvents);
};

const saveCommonNote = async (
  mutate: PlannerSqlMutate,
  notesByDay: Record<string, string>,
  dayKey: string,
  previousNote: string,
  nextNote: string,
) => {
  const normalizedNote = await normalizeMemoForSave(nextNote);
  const nextNotesByDay = { ...notesByDay };
  if (normalizedNote.trim()) {
    nextNotesByDay[dayKey] = normalizedNote;
  } else {
    delete nextNotesByDay[dayKey];
  }
  await mutate(
    (async () => {
      await saveSharedNote(dayKey, normalizedNote);
      await appendSharedNoteHistory({
        after: normalizedNote,
        before: previousNote,
        dayKey,
        timestamp: new Date().toISOString(),
      });
    })(),
    {
      optimisticUpdate(data) {
        return updatePlannerSqlRows(
          data,
          "planner.notes-by-day.v1",
          nextNotesByDay,
        );
      },
    },
  );
};

const updateOverlay = async (
  mutate: PlannerSqlMutate,
  overlayMap: Record<string, PlannerOverlay>,
  eventId: string,
  patch: Partial<PlannerOverlay>,
) => {
  const nextOverlayMap = {
    ...overlayMap,
    [eventId]: {
      ...overlayMap[eventId],
      ...patch,
    },
  };
  await mutate(saveOverlayMap(nextOverlayMap), {
    optimisticUpdate(data) {
      return updatePlannerSqlRows(data, "planner.overlays.v1", nextOverlayMap);
    },
  });
};

const handleSync = async (
  preferences: PlannerPreferences,
  targetDate: Date,
  reload: (forceRefresh?: boolean, date?: Date) => Promise<void>,
) => {
  const { dayKey } = getDayRange(targetDate);
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: "予定を同期中",
  });

  try {
    clearCachedEvents();
    await fetchCalendarEvents(preferences, targetDate, { forceRefresh: true });
    toast.style = Toast.Style.Success;
    toast.title = `${dayKey} を同期しました`;
    await reload(true, targetDate);
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = "同期に失敗しました";
    toast.message = toErrorMessage(error);
  }
};

const maybeAutoOpenJoin = async (events: PlannerEventViewModel[]) => {
  const autoOpenState = await loadAutoOpenState();
  const now = Date.now();
  const candidate = events.find((event) => {
    if (!event.autoOpenJoin || !event.joinLink) {
      return false;
    }

    const startTime = Date.parse(event.start);
    return (
      now >= startTime &&
      now < startTime + 60_000 &&
      autoOpenState[event.id] !== event.start
    );
  });

  if (!candidate?.joinLink) {
    return;
  }

  autoOpenState[candidate.id] = candidate.start;
  await saveAutoOpenState(autoOpenState);
  await open(candidate.joinLink.url);
  await showToast({
    style: Toast.Style.Success,
    title: "参加リンクを自動オープンしました",
    message: candidate.title,
  });
};

const buildMarkdown = (
  event: PlannerEventViewModel,
  dateLabel: string,
  timeLabel: string,
): string => {
  const sections = [`# ${event.title}`];
  sections.push(`- 日付: ${dateLabel}`);
  sections.push(`- 時間: ${timeLabel}`);

  if (event.location) {
    sections.push(`- 場所: ${event.location}`);
  }

  if (event.description) {
    sections.push("\n## 詳細\n");
    sections.push(event.description);
  }

  return sections.join("\n");
};

const defaultStartTime = (selectedDate: Date): number => {
  if (isToday(selectedDate)) {
    return getRoundedFutureTime().getTime();
  }

  const start = new Date(selectedDate);
  start.setHours(9, 0, 0, 0);
  return start.getTime();
};

const defaultEndTime = (selectedDate: Date): number => {
  const start = new Date(defaultStartTime(selectedDate));
  start.setMinutes(start.getMinutes() + 60);
  return start.getTime();
};

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
