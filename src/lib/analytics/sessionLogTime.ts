/**
 * One timestamp format for every log view: UTC on both sides, so the
 * server-rendered timestamps match the hydrated ones and an instructor reading
 * logs from different machines sees the same instant.
 */
const timestampFormat = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'UTC'
});

const timeFormat = new Intl.DateTimeFormat('en-US', {
  timeStyle: 'medium',
  timeZone: 'UTC'
});

/** A log entry's timestamp (`ISO` string) as it is shown in the log views. */
export function formatLogTimestamp(timestamp: string): string {
  return timestampFormat.format(new Date(timestamp));
}

/** The time of day only, for a timeline where one date runs through every entry. */
export function formatLogTime(timestamp: string): string {
  return timeFormat.format(new Date(timestamp));
}
