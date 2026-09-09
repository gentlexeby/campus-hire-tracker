import type {
  ApplicationSummary,
  EventDto,
  TimelineEntryDto,
} from "@/lib/services";
import type {
  ApplicationView,
  EventView,
  TimelineView,
} from "@/components/domain";

export function scheduleStart(event: EventDto) {
  return event.schedule.kind === "TIMED" ? event.schedule.startsAtMs : null;
}

export function scheduleDate(event: EventDto) {
  return event.schedule.kind === "ALL_DAY" ? event.schedule.startDate : null;
}

export function toApplicationView(application: ApplicationSummary): ApplicationView {
  return {
    id: application.id,
    companyName: application.companyName,
    positionTitle: application.positionTitle,
    cycleLabel: application.cycleLabel,
    stage: application.stage,
    priority: application.priority,
    attentionMode: application.attentionMode,
    nextActionTitle: application.nextActionTitle,
    waitingFor: application.waitingFor,
    reviewAtMs: application.attentionAtMs,
    reviewDate: application.attentionDate,
    nextEventTitle: application.nextEvent?.title,
    nextEventAtMs: application.nextEvent ? scheduleStart(application.nextEvent) : null,
    updatedAtMs: application.updatedAtMs,
  };
}

export function toEventView(
  event: EventDto,
  context?: { applicationLabel?: string; isConflict?: boolean },
): EventView {
  return {
    id: event.id,
    applicationId: event.applicationId,
    applicationLabel: context?.applicationLabel,
    type: event.type,
    title: event.title,
    status: event.status,
    isAllDay: event.schedule.kind === "ALL_DAY",
    startsAtMs: event.schedule.kind === "TIMED" ? event.schedule.startsAtMs : null,
    endsAtMs: event.schedule.kind === "TIMED" ? event.schedule.endsAtMs : null,
    allDayStartDate: event.schedule.kind === "ALL_DAY" ? event.schedule.startDate : null,
    allDayEndDateExclusive: event.schedule.kind === "ALL_DAY" ? event.schedule.endDateExclusive : null,
    timezone: event.timezone,
    location: event.location,
    meetingUrl: event.meetingUrl,
    isHardDeadline: event.isHardDeadline,
    isConflict: context?.isConflict,
  };
}

export function toTimelineView(entry: TimelineEntryDto): TimelineView {
  return {
    id: entry.id,
    entryType: entry.entryType,
    summary: entry.summary,
    happenedAtMs: entry.happenedAtMs,
  };
}
