/**
 * Event Bus — the kernel's nervous system.
 *
 * Modules never call each other directly. They emit events and subscribe to
 * events. This keeps every capability replaceable: swap the video plugin and
 * nothing else has to change, as long as it emits the same events.
 *
 * Handlers run sequentially (not in parallel) so ordering is deterministic and
 * the Audit Log records a clean, reproducible timeline.
 */
export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<string, Set<EventHandler<unknown>>>();

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as EventHandler<unknown>);
    return () => this.off(event, handler);
  }

  /** Unsubscribe a specific handler. */
  off<T = unknown>(event: string, handler: EventHandler<T>): void {
    this.handlers.get(event)?.delete(handler as EventHandler<unknown>);
  }

  /** Emit an event; awaits every handler in registration order. */
  async emit<T = unknown>(event: string, payload: T): Promise<void> {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      await handler(payload);
    }
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}
