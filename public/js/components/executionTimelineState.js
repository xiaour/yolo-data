export function applyExecutionTimelineEvent(state, event) {
  if (event.type === 'execution_reset') {
    state.executionTimeline = [];
  } else if (event.type === 'execution_complete') {
    state.executionTimeline = state.executionTimeline
      .filter((item) => item.status !== 'pending')
      .map((item) => (item.status === 'running'
        ? { ...item, status: event.status === 'failed' ? 'error' : 'done' }
        : item));
  } else if (event.type === 'execution_progress' || event.type === 'assistant_progress') {
    const timeline = state.executionTimeline ?? state.progress ?? [];
    const id = event.id ?? `progress-${timeline.length}`;
    const index = timeline.findIndex((item) => item.id === id);
    const item = {
      ...event,
      id,
      title: event.title ?? event.text ?? '',
      at: index >= 0 ? timeline[index].at : Date.now(),
    };
    if (index >= 0) timeline.splice(index, 1, item);
    else timeline.push(item);
    if (timeline.length > 40) timeline.splice(0, timeline.length - 40);
    state.executionTimeline = timeline;
  } else {
    return false;
  }
  state.progress = state.executionTimeline;
  return true;
}
