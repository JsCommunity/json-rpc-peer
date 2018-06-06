import { EventEmitter } from 'events'
// import {
//   forEach,
//   isArray,
//   map,
// }                           from 'lodash'
import cuid from 'cuid'

import {
  format,
  JsonRpcError,
  MethodNotFound,
  parse,

  JsonRpcPayload,
  JsonRpcPayloadRequest,
  JsonRpcPayloadError,
  JsonRpcPayloadResponse,
  JsonRpcParamsSchema,
}                                 from 'json-rpc-protocol'

// ===================================================================

// Give access to low level interface.
export * from 'json-rpc-protocol'

// ===================================================================

function makeAsync (fn: Function): (...args: any[]) => Promise<any> {
  return function (this: any, ...args: any[]) {
    return new Promise(resolve => resolve(fn.apply(this, args)))
  }
}

const parseMessage = (message: string | Object) => {
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
// let nextRequestId = -9007199254740991
// use cuid() instead

// ===================================================================

export class Peer extends EventEmitter {
  private _handle: (payload: JsonRpcPayload, data: any) => Promise<any>
  private _deferreds: {
    [idx: string]: {
      resolve: Function,
      reject: Function,
    }
  }

  constructor (onMessage = defaultOnMessage) {
    super()

    this._handle = makeAsync(onMessage)
    this._deferreds = Object.create(null)
  }

  _getDeferred (id: number | string) {
    const deferred = this._deferreds[id]
    delete this._deferreds[id]
    return deferred
  }

  async exec (
    message: string | Object,
    data?: any,
  ): Promise<undefined | string | JsonRpcPayload | JsonRpcPayload[]> {
    const messagePayload = parseMessage(message)

    if (Array.isArray(messagePayload)) {
      // Only returns non empty results.
      const results = (
        await Promise.all(
          messagePayload.map(
            payload => this.exec(payload, data)
          )
        )
      ).filter(result => result !== undefined) as JsonRpcPayload[]

      return results
    }

    const {type} = messagePayload

    if (type === 'error') {
      const {id} = messagePayload as JsonRpcPayloadError

      // Some errors do not have an identifier, simply discard them.
      if (id === undefined || id === null) {
        return
      }

      const {error} = messagePayload as JsonRpcPayloadError
      this._getDeferred(id).reject(
        // TODO: it would be great if we could return an error with of
        // a more specific type (and custom types with registration).
        new JsonRpcError(error.message, error.code, error.data)
      )
      return

    } else if (type === 'response') {
      const responsePayload = messagePayload as JsonRpcPayloadResponse
      this._getDeferred(
        responsePayload.id
      ).resolve(responsePayload.result)
      return

    } else if (type === 'notification') {
      this._handle(messagePayload, data).catch(noop)
      return

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

      // return this._handle(messagePayload, data).then(
      //   (result) => format.response(messagePayload.id, result === undefined ? null : result),
      //   (error) => format.error(
      //     messagePayload.id,

      //     // If the method name is not defined, default to the method passed
      //     // in the request.
      //     (error instanceof MethodNotFound && !error.data)
      //       ? new MethodNotFound(messagePayload.method)
      //       : error
      //   )
      // )
    }
  }

  // Fails all pending requests.
  failPendingRequests (reason?: string) {
    const {_deferreds: deferreds} = this

    for (const id in deferreds) {
      deferreds[id].reject(reason)
      delete deferreds[id]
    }
  }

  /**
   * This function should be called to send a request to the other end.
   *
   * TODO: handle multi-requests.
   */
  request (method: string, params?: JsonRpcParamsSchema): Promise<any> {
    return new Promise((resolve, reject) => {
      const requestId = cuid()

      this._deferreds[requestId] = {resolve, reject}

      this.push(format.request(requestId, method, params))
    })
  }

  /**
   * This function should be called to send a notification to the other end.
   *
   * TODO: handle multi-notifications.
   */
  async notify (method: string, params?: JsonRpcParamsSchema) {
    this.push(format.notification(method, params))
  }

  // minimal stream interface

  pipe<T extends (NodeJS.WritableStream | Peer)>(writable: T): T {
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
        writable.end()
        clean()
      },
    } as {
      [event: string]: any,
    }

    clean = () => {
      // forEach(listeners, (listener, event) => {
      for (const event in listeners) {
        const listener = listeners[event]
        this.removeListener(event, listener)
      }
    }

    for (const event in listeners) {
      const listener = listeners[event]
      this.on(event, listener)
    }
    // forEach(listeners, (listener, event) => {
    //   this.on(event, listener)
    // })

    return writable
  }

  push (data: any) {
    return data === null
      ? this.emit('end')
      : this.emit('data', data)
  }

  async write (message: any) {
    try {
      const response = await this.exec(String(message))
      if (response !== undefined) {
        this.push(response)
      }
    } catch (error) {
      this.emit('error', error)
    }
  }

  // write(message: any): boolean {
  //   this.exec(String(message)).then(
  //     response => {
  //       if (response !== undefined) {
  //         this.push(response)
  //       }
  //     },
  //   ).catch(
  //     error => this.emit('error', error)
  //   )
  //   return true
  // }

  end(): void {
    // if (message) {
    //   this.write(message)
    // }
    // noop. just for pretend I'm a stream...
  }
}

export default Peer
