/// <reference types="json-rpc-protocol" />
/// <reference types="node" />

import { EventEmitter } from "events";
import { JsonRpcPayload, JsonRpcParamsSchema } from "json-rpc-protocol";

export as namespace JsonRpcPeer;

export * from "json-rpc-protocol";

export class Peer extends EventEmitter implements NodeJS.WritableStream {
  constructor(onmessage?: (message: JsonRpcPayload, data: any) => Promise<any>);

  public exec(
    message: string | object,
    data?: any
  ): Promise<undefined | string | JsonRpcPayload | JsonRpcPayload[]>;

  /**
   * Fails all pending requests.
   */
  public failPendingRequests(reason?: string);

  /**
   * This function should be called to send a request to the other end.
   */
  public request(method: string, params?: JsonRpcParamsSchema): Promise<any>;

  /**
   * This function should be called to send a notification to the other end.
   */
  public notify(method: string, params?: JsonRpcParamsSchema);

  public push(chunk: any, encoding?: string);

  public pipe<T extends NodeJS.WritableStream>(writable: T): T;

  // NodeJS.WritableStream

  writable: boolean;
  write(
    buffer: Uint8Array | string,
    cb?: (err?: Error | null) => void
  ): boolean;
  write(
    str: string,
    encoding?: string,
    cb?: (err?: Error | null) => void
  ): boolean;
  end(cb?: () => void): void;
  end(data: string | Uint8Array, cb?: () => void): void;
  end(str: string, encoding?: string, cb?: () => void): void;
}
export default Peer;
