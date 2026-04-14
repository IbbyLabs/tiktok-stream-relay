interface EventRecord {
  action: string;
  timestamp: string;
  reason?: string;
}

export class SecurityEventLog {
  private readonly events: EventRecord[] = [];
  private readonly counters = new Map<string, number>();

  public record(action: string, reason?: string): void {
    this.events.push({ action, timestamp: new Date().toISOString(), reason });
    this.counters.set(action, (this.counters.get(action) ?? 0) + 1);
    if (this.events.length > 5000) {
      this.events.splice(0, this.events.length - 5000);
    }
  }

  public recent(limit = 100): EventRecord[] {
    return this.events.slice(Math.max(0, this.events.length - limit));
  }

  public countersSnapshot(): Record<string, number> {
    return Object.fromEntries(this.counters.entries());
  }
}
