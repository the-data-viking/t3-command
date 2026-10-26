import { subagentRecord, subagentSnapshot, type BoundedThreadSnapshot, type Projection } from "../shared/thread-history.ts";

/** Private Command relay option: lifecycle followers never receive transcripts or tool output. */
export class SubagentRelay {
  private requests = new Set<string>();
  request(message: Projection): Projection {
    const payload = message.payload as Projection | undefined;
    if (message._tag === "Request" && message.tag === "orchestration.subscribeThread" && payload?.commandSubagentsOnly === true) {
      this.requests.add(String(message.id));
      const rest = { ...payload };
      delete rest.commandSubagentsOnly;
      return { ...message, payload: rest };
    }
    if (message._tag === "Interrupt") this.requests.delete(String(message.requestId));
    return message;
  }
  response(message: Projection): Projection {
    const id = String(message.requestId);
    if (!this.requests.has(id)) return message;
    if (message._tag === "Exit") this.requests.delete(id);
    if (message._tag !== "Chunk") return message;
    const values = (message.values as Projection[]).flatMap((item) => {
      if (item.kind === "snapshot") return [{ kind: "snapshot", ...subagentSnapshot(item as unknown as BoundedThreadSnapshot) }];
      if (item.kind === "synchronized") return [item];
      const event = item.event as Projection | undefined;
      return item.kind === "event" && event?.type === "subagent.updated"
        ? [{ ...item, event: { type: event.type, payload: subagentRecord(event.payload as Projection) } }] : [];
    });
    // Empty chunks still reach the client and are Acked, preserving upstream flow control.
    return { ...message, values };
  }
}
