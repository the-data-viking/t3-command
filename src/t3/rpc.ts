// Minimal Effect RPC (JSON serialization) client, as spoken by T3 Code's /ws endpoint.
// Wire format: docs/PROTOCOL.md §1.2. Every Chunk of a stream must be Acked before the server sends the next.
import { protocolRequest, protocolStreamDecoder, protocolStreamPayload } from "../../shared/t3-protocol";

type Cause =
  | { _tag: "Fail"; error: { _tag: string; message?: string } }
  | { _tag: "Die"; defect: unknown }
  | { _tag: "Interrupt" };

type ServerMessage =
  | { _tag: "Chunk"; requestId: string; values: unknown[] }
  | { _tag: "Exit"; requestId: string; exit: { _tag: "Success"; value?: unknown } | { _tag: "Failure"; cause: Cause[] } }
  | { _tag: "Pong" }
  | { _tag: "Defect"; defect: unknown };

export class RpcError extends Error {
  readonly tag: string;
  constructor(tag: string, message: string) {
    super(message);
    this.tag = tag;
  }
}

function causeToError(cause: Cause[]): RpcError {
  for (const c of cause) {
    if (c._tag === "Fail") return new RpcError(c.error._tag, c.error.message ?? c.error._tag);
    if (c._tag === "Die") return new RpcError("Defect", typeof c.defect === "string" ? c.defect : JSON.stringify(c.defect));
  }
  return new RpcError("Interrupted", "Request was interrupted");
}

interface Call {
  onChunk?: (values: unknown[]) => void;
  onExit: (value: unknown, error?: RpcError) => void;
}

export interface RpcConnectionHandlers {
  onOpen: () => void;
  onClose: (code: number, reason: string) => void;
}

const PING_INTERVAL_MS = 20_000;

export class RpcConnection {
  private ws: WebSocket;
  private nextId = 1;
  private calls = new Map<string, Call>();
  private ping?: ReturnType<typeof setInterval>;
  private closed = false;
  private ready = false;
  private handshake?: ReturnType<typeof setTimeout>;
  private protocolVersion: number;

  constructor(url: string, handlers: RpcConnectionHandlers, protocolVersion = 1) {
    this.protocolVersion = protocolVersion;
    this.ws = new WebSocket(url);
    this.ws.addEventListener("open", () => {
      // Opening the local relay does not prove that upstream T3 is reachable.
      this.send({ _tag: "Ping" });
      this.handshake = setTimeout(() => this.ws.close(4502, "T3 handshake timed out"), 15_000);
      this.ping = setInterval(() => this.send({ _tag: "Ping" }), PING_INTERVAL_MS);
    });
    this.ws.addEventListener("message", (e) => {
      const message = JSON.parse(e.data as string) as ServerMessage;
      if (message._tag === "Pong" && !this.ready && !this.closed) {
        this.ready = true;
        clearTimeout(this.handshake);
        handlers.onOpen();
      }
      this.receive(message);
    });
    this.ws.addEventListener("close", (e) => {
      this.closed = true;
      clearInterval(this.ping);
      clearTimeout(this.handshake);
      const err = new RpcError("Disconnected", "Connection closed");
      for (const call of this.calls.values()) call.onExit(undefined, err);
      this.calls.clear();
      handlers.onClose(e.code, e.reason);
    });
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.ws.close();
  }

  private send(message: object): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private receive(msg: ServerMessage): void {
    switch (msg._tag) {
      case "Chunk": {
        const call = this.calls.get(msg.requestId);
        // Ack first so the server can prepare the next chunk while we process this one.
        this.send({ _tag: "Ack", requestId: msg.requestId });
        call?.onChunk?.(msg.values);
        return;
      }
      case "Exit": {
        const call = this.calls.get(msg.requestId);
        this.calls.delete(msg.requestId);
        if (!call) return;
        if (msg.exit._tag === "Success") call.onExit(msg.exit.value);
        else call.onExit(undefined, causeToError(msg.exit.cause));
        return;
      }
      case "Defect":
        console.error("T3 protocol defect", msg.defect);
        return;
    }
  }

  private start(tag: string, payload: unknown, call: Call): string {
    if (this.closed) {
      call.onExit(undefined, new RpcError("Disconnected", "Connection closed"));
      return "";
    }
    const id = String(this.nextId++);
    this.calls.set(id, call);
    this.send({ _tag: "Request", id, tag, payload, headers: [] });
    return id;
  }

  request<T>(tag: string, payload: unknown = {}, timeoutMs?: number): Promise<T> {
    return protocolRequest(this.protocolVersion, tag, payload, (nextTag, nextPayload) => this.rawRequest(nextTag, nextPayload, timeoutMs)) as Promise<T>;
  }

  private rawRequest<T>(tag: string, payload: unknown, timeoutMs?: number): Promise<T> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const id = this.start(tag, payload, { onExit: (value, err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value as T);
      } });
      if (timeoutMs && this.calls.has(id)) timer = setTimeout(() => {
        this.calls.delete(id);
        this.send({ _tag: "Interrupt", requestId: id });
        reject(new RpcError("Timeout", `${tag} timed out`));
      }, timeoutMs);
    });
  }

  /** Start a streaming RPC. Returns a function that cancels it. */
  stream<T>(tag: string, payload: unknown, onItems: (items: T[]) => void, onEnd: (err?: RpcError) => void): () => void {
    const decode = protocolStreamDecoder(this.protocolVersion, tag);
    return this.rawStream(tag, protocolStreamPayload(this.protocolVersion, tag, payload),
      (values) => onItems(decode(values) as T[]), onEnd);
  }

  /** Raw v2 events can resume from an HTTP snapshot decoded by the caller. */
  rawStream(tag: string, payload: unknown, onItems: (items: unknown[]) => void, onEnd: (err?: RpcError) => void): () => void {
    const id = this.start(tag, payload, {
      onChunk: onItems,
      onExit: (_value, err) => onEnd(err),
    });
    return () => {
      if (!id || !this.calls.has(id)) return;
      this.calls.delete(id);
      this.send({ _tag: "Interrupt", requestId: id });
    };
  }
}
