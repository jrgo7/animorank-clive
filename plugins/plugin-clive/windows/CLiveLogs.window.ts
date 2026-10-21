import { Window } from '$lib/window';
import type { SessionLogsViewContext } from '../../../src/routes/instructor/analytics/session-logs/context.svelte';
import CLiveLogs from './CLiveLogs.window.svelte';

export class CLiveLogsWindow extends Window<SessionLogsViewContext> {
  static title = 'CLive events';
  static closeable = false;
  constructor(context: SessionLogsViewContext) {
    super({ title: CLiveLogsWindow.title, closable: CLiveLogsWindow.closeable, context }, CLiveLogs);
  }
}
