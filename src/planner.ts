import { getDayRange, isEventPast, isLocalAllDayEvent } from "./date";
import { getPreferredJoinLink } from "./links";
import type {
  LocalPlannerEvent,
  PlannerEvent,
  PlannerEventViewModel,
  PlannerOverlay,
} from "./types";

export const mergeEventsWithOverlay = (
  googleEvents: PlannerEvent[],
  overlayMap: Record<string, PlannerOverlay>,
  localEvents: LocalPlannerEvent[],
  targetDate: Date,
): PlannerEventViewModel[] => {
  const targetDayKey = getDayRange(targetDate).dayKey;
  return [...googleEvents, ...localEvents]
    .map((event) => {
      const overlay = overlayMap[event.id] ?? {};
      const joinLink = getPreferredJoinLink(event.links);
      const isAnytime = event.anytime ?? false;
      const completed =
        overlay.completed ?? (isAnytime ? false : isEventPast(event));
      const isAllDay = event.isAllDay || isLocalAllDayEvent(event);
      return {
        ...event,
        autoOpenJoin:
          overlay.autoOpenJoin ??
          (joinLink?.type === "meet" || joinLink?.type === "ovice"),
        completed,
        hidden: overlay.hidden ?? false,
        isAllDay,
        isAnytime,
        isPast: isEventPast(event),
        joinLink,
        title: overlay.titleOverride?.trim() || event.summary || "(No title)",
      } satisfies PlannerEventViewModel;
    })
    .filter((event) => {
      if (event.hidden) {
        return false;
      }

      if (
        event.source === "local" &&
        event.isAnytime &&
        targetDayKey < getDayRange(new Date(event.start)).dayKey
      ) {
        return false;
      }

      const completedDayKey = overlayMap[event.id]?.completedAt
        ? getDayRange(new Date(overlayMap[event.id].completedAt as string))
            .dayKey
        : undefined;

      return !(
        completedDayKey &&
        overlayMap[event.id]?.completed &&
        targetDayKey > completedDayKey
      );
    })
    .sort(
      (left, right) =>
        Number(left.completed) - Number(right.completed) ||
        getLaneRank(left) - getLaneRank(right) ||
        Date.parse(left.start) - Date.parse(right.start),
    );
};

const getLaneRank = (
  event: Pick<
    PlannerEventViewModel,
    "end" | "isAllDay" | "isAnytime" | "start"
  >,
): number => {
  if (
    event.isAnytime ||
    event.isAllDay ||
    getDayRange(new Date(event.start)).dayKey !==
      getDayRange(new Date(event.end)).dayKey
  ) {
    return 1;
  }

  return 0;
};
