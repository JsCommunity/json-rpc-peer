import { EventEmitter } from 'events'

import {
  format,
  JsonRpcError,
  JsonRpcParamsSchema,
  JsonRpcPayload,
  JsonRpcPayloadError,
  JsonRpcPayloadRequest,
  JsonRpcPayloadResponse,
  MethodNotFound,
  parse
} from 'json-rpc-protocol'

// ===================================================================

// Give access to low level interface.
export * from 'json-rpc-protocol'

// ===================================================================

export type AnyFunction = (...args: any[]) => any

function makeAsync (fn: AnyFunction): AnyFunction {
  return function (this: any, ...args: any[]) {
    return new Promise(
      (resolve) => resolve(
        fn.apply(this, args)
      )
    )
  }
}

const parseMessage = (message: string | object) => {
  try {
    return parse(message)
  } catch (error) {
    throw format.error(null, error)
  }
}

// Default onMessage implementation:
//
// - ignores notifications
// - throw MethodNotFound for all requests
function defaultOnMessage (message: JsonRpcPayload) {
  if (message.type === 'request') {
    throw new MethodNotFound((message as JsonRpcPayloadRequest).method)
  }
}

function noop () {
  // noop
}

// Starts the autoincrement id with the JavaScript minimal safe integer to have
// more room before running out of integers (it's very far fetched but a very
// long running process with a LOT of messages could run out).
let nextRequestId = -9007199254740991

// ===================================================================

export class Peer extends EventEmitter implements NodeJS.WritableStream {
  public writable = true

  private _asyncEmitError: (error: Error) => void
  private _handle: (payload: JsonRpcPayload, data: any) => Promise<any>
  private _deferreds: {
    [idx: string]: {
      resolve: (...args: any[]) => any,
      reject: (...args: any[]) => any
    }
  }

  constructor (onMessage = defaultOnMessage) {
    super()

    this._asyncEmitError = process.nextTick.bind(process, this.emit.bind(this), 'error')

    this._handle = makeAsync(onMessage)
    this._deferreds = Object.create(null)
  }

  public async exec (
    message: string | object,
    data?: any
  ): Promise<undefined | string | JsonRpcPayload | JsonRpcPayload[]> {
    const messagePayload = parseMessage(message)

    if (Array.isArray(messagePayload)) {
      // Only returns non empty results.
      const results = (
        await Promise.all(
          messagePayload.map(
            (payload) => this.exec(payload, data)
          )
        )
      ).filter((result) => result !== undefined) as JsonRpcPayload[]

      return results
    }

    const { type } = messagePayload

    if (type === 'error') {
      const { id } = messagePayload as JsonRpcPayloadError

      // Some errors do not have an identifier, simply discard them.
      if (id === undefined || id === null) {
        return undefined
      }

      const { error } = messagePayload as JsonRpcPayloadError
      this._getDeferred(id).reject(
        // TODO: it would be great if we could return an error with of
        // a more specific type (and custom types with registration).
        new JsonRpcError(error.message, error.code, error.data)
      )
      return undefined

    } else if (type === 'response') {
      const responsePayload = messagePayload as JsonRpcPayloadResponse
      this._getDeferred(
        responsePayload.id
      ).resolve(responsePayload.result)
      return undefined

    } else if (type === 'notification') {
      this._handle(messagePayload, data).catch(noop)
      return undefined

    } else {  // type === 'request'
      const requestPayload = messagePayload as JsonRpcPayloadRequest
      let result
      try {
        result = await this._handle(messagePayload, data)
      } catch (error) {
        return format.error(
          requestPayload.id,
          // If the method name is not defined, default to the method passed
          // in the request.
          (error instanceof MethodNotFound && !error.data)
            ? new MethodNotFound(requestPayload.method)
            : error
        )
      }
      return format.response(requestPayload.id, result === undefined ? null : result)
    }
  }

  // Fails all pending requests.
  public failPendingRequests (reason?: string) {
    const { _deferreds: deferreds } = this

    // https://stackoverflow.com/a/45959874/1123955
    for (const id of Object.keys(deferreds)) {
      deferreds[id].reject(reason)
      delete deferreds[id]
    }
  }

  /**
   * This function should be called to send a request to the other end.
   *
   * TODO: handle multi-requests.
   */
  public request (method: string, params?: JsonRpcParamsSchema): Promise<any> {
    return new Promise((resolve, reject) => {
      const requestId = nextRequestId++

      this._deferreds[requestId] = { resolve, reject }

      this.push(format.request(requestId, method, params))
    })
  }

  /**
   * This function should be called to send a notification to the other end.
   *
   * TODO: handle multi-notifications.
   */
  public notify (method: string, params?: JsonRpcParamsSchema) {
    this.push(format.notification(method, params))
  }

  // minimal stream interface

  public pipe<T extends (NodeJS.WritableStream)> (writable: T): T {
    let clean: () => void

    const listeners = {
      data: (data: any) => {
        if (writable instanceof Peer) {
          writable.write(data)
        } else {
          // TypeScript bug? can not identify type at here, have to do a casting.
          (writable as NodeJS.WritableStream).write(data)
        }
      },
      end: () => {
        clean()
        writable.end()
      }
    } as {
      [event: string]: any
    }

    clean = () => {
      // forEach(listeners, (listener, event) => {
      for (const event of Object.keys(listeners)) {
        const listener = listeners[event]
        this.removeListener(event, listener)
      }
    }

    for (const event of Object.keys(listeners)) {
      const listener = listeners[event]
      this.on(event, listener)
    }

    return writable
  }

  public push (chunk: any, encoding?: string) {
    // TODO: does convert the chunk to a JsonRpcPayload is better?
    return chunk === null
      ? this.emit('end')
      : this.emit('data', chunk, encoding)
  }

  public write (buffer: string | Buffer, cb?: AnyFunction): boolean
  public write (str: string, encoding?: string, cb?: AnyFunction): boolean

  public write (...args: any[]): boolean {
    let cb
    const n = args.length
    if (n > 1 && typeof (cb = args[n - 1]) === 'function') {
      process.nextTick(cb)
    }

    this.exec(String(args[0])).then(
      (response) => {
        if (response !== undefined) {
          this.push(response)
        }
      },
      this._asyncEmitError
    )

    // indicates that other calls to `write` are allowed
    return true
  }

  public end (cb?: (...args: any[]) => any): void
  public end (buffer: string | Buffer, cb?: AnyFunction): void
  public end (str: string, encoding?: string, cb?: AnyFunction): void

  // end (data, encoding, cb) {
  public end (...args: any[]): void {
    if (typeof args[0] === 'function') {
      process.nextTick(args[0])
    } else {
      if (typeof args[1] === 'function') {
        process.nextTick(args[1])
      } else if (typeof args[2] === 'function') {
        process.nextTick(args[2])
      }

      if (args[0] !== undefined) {
        this.write(args[0])
      }
    }
  }

  private _getDeferred (id: number | string) {
    const deferred = this._deferreds[id]
    delete this._deferreds[id]
    return deferred
  }

}

export default Peer
