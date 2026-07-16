export class SenderRateLimiter {
  private readonly requests = new Map<number, number[]>();

  constructor(
    private readonly maximumRequests = 20,
    private readonly windowMilliseconds = 60_000,
  ) {}

  allow(senderId: number, now = Date.now()): boolean {
    const threshold = now - this.windowMilliseconds;
    const recent = (this.requests.get(senderId) ?? []).filter(
      (timestamp) => timestamp > threshold,
    );
    if (recent.length >= this.maximumRequests) {
      this.requests.set(senderId, recent);
      return false;
    }
    recent.push(now);
    this.requests.set(senderId, recent);
    return true;
  }
}
