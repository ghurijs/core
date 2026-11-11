export type Receiver<A> = (args: A & { sender: unknown }) => void | Promise<void>

interface Connection<A> {
  receiver: Receiver<A>
  sender?: unknown
  uid?: string
}

/** Django-style signal. Receivers run sequentially and are awaited. */
export class Signal<A extends object = Record<string, unknown>> {
  private receivers: Connection<A>[] = []

  constructor(readonly name = 'signal') {}

  connect(receiver: Receiver<A>, opts: { sender?: unknown; uid?: string } = {}): void {
    if (opts.uid && this.receivers.some((r) => r.uid === opts.uid)) return
    if (this.receivers.some((r) => r.receiver === receiver && r.sender === opts.sender)) return
    this.receivers.push({ receiver, sender: opts.sender, uid: opts.uid })
  }

  disconnect(receiverOrUid: Receiver<A> | string, sender?: unknown): boolean {
    const before = this.receivers.length
    this.receivers = this.receivers.filter((r) =>
      typeof receiverOrUid === 'string'
        ? r.uid !== receiverOrUid
        : !(r.receiver === receiverOrUid && (sender === undefined || r.sender === sender)),
    )
    return this.receivers.length !== before
  }

  hasListeners(sender?: unknown): boolean {
    return this.receivers.some((r) => r.sender === undefined || r.sender === sender)
  }

  async send(sender: unknown, args: A): Promise<void> {
    for (const r of [...this.receivers]) {
      if (r.sender !== undefined && r.sender !== sender) continue
      await r.receiver({ ...args, sender })
    }
  }
}

/** Decorator-free helper: `receiver(postSave, { sender: Post })(fn)`. */
export function receiver<A extends object>(signal: Signal<A>, opts: { sender?: unknown; uid?: string } = {}) {
  return (fn: Receiver<A>): Receiver<A> => {
    signal.connect(fn, opts)
    return fn
  }
}

export const requestStarted = new Signal<{ request: Request }>('requestStarted')
export const requestFinished = new Signal<{ request: Request; response?: Response }>('requestFinished')
