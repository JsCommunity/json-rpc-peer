import Duplex from 'readable-stream/duplex'
import forEach from 'lodash/forEach'
import isArray from 'lodash/isArray'
import map from 'lodash/map'
import {
  format,
  JsonRpcError,
  MethodNotFound,
  parse
} from 'json-rpc-protocol'

// ===================================================================

// Give access to low level interface.
// export * from 'json-rpc-protocol'
// FIXME: work around for https://fabricator.babeljs.io/T2877
{
  const protocol = require('json-rpc-protocol')
  for (let prop in protocol) {
    if (prop !== 'default' && Object.prototype.hasOwnProperty.call(protocol, prop)) {
      Object.defineProperty(module.exports, prop, {
        configurable: true,
        enumerable: true,
        get: () => protocol[prop]
      })
    }
  }
}

// ===================================================================

function makeAsync (fn) {
  return function () {
    return new Promise(resolve => resolve(fn.apply(this, arguments)))
  }
}

const parseMessage = message => {
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
function defaultOnMessage (message) {
  if (message.type === 'request') {
    throw new MethodNotFound()
  }
}

function noop () {}

// Starts the autoincrement id with the JavaScript minimal safe integer to have
// more room before running out of integers (it's very far fetched but a very
// long running process with a LOT of messages could run out).
let nextRequestId = -9007199254740991

// ===================================================================

export default class Peer extends Duplex {
  constructor (onMessage) {
    super({
      objectMode: true
    })

    this._handle = makeAsync(onMessage || defaultOnMessage)
    this._deferreds = Object.create(null)

    // Forward the end of the stream.
    this.on('finish', function () {
      this.push(null)
    })
  }

  _getDeferred (id) {
    const deferred = this._deferreds[id]
    delete this._deferreds[id]
    return deferred
  }

  // Emit buffered outgoing messages.
  _read () {}

  // Receive and execute incoming messages.
  _write (message, _, next) {
    this.exec(String(message)).then(
      response => {
        if (response !== undefined) {
          this.push(response)
        }
      },
      error => {
        this.emit('error', error)
      }
    )

    next()
  }

  async exec (message) {
    message = parseMessage(message)

    if (isArray(message)) {
      const results = []

      // Only returns non empty results.
      await Promise.all(map(message, message => {
        return this.exec(message).then(result => {
          if (result) {
            results.push(result)
          }
        })
      }))

      return results
    }

    const {type} = message

    if (type === 'error') {
      const {id} = message

      // Some errors do not have an identifier, simply discard them.
      if (id === null) {
        return
      }

      const {error} = message
      this._getDeferred(id).reject(
        // TODO: it would be great if we could return an error with of
        // a more specific type (and custom types with registration).
        new JsonRpcError(error.message, error.code, error.data)
      )
    } else if (type === 'response') {
      this._getDeferred(message.id).resolve(message.result)
    } else if (type === 'notification') {
      this._handle(message).catch(noop)
    } else {
      return this._handle(message).then(
        (result) => format.response(message.id, result === undefined ? null : result),
        (error) => format.error(
          message.id,

          // If the method name is not defined, default to the method passed
          // in the request.
          (error instanceof MethodNotFound && !error.data)
            ? new MethodNotFound(message.method)
            : error
        )
      )
    }
  }

  // Fails all pending requests.
  failPendingRequests (reason) {
    const {_deferreds: deferreds} = this

    forEach(deferreds, ({reject}, id) => {
      reject(reason)
      delete deferreds[id]
    })
  }

  /**
   * This function should be called to send a request to the other end.
   *
   * TODO: handle multi-requests.
   */
  request (method, params) {
    return new Promise((resolve, reject) => {
      const requestId = nextRequestId++

      this.push(format.request(requestId, method, params))

      this._deferreds[requestId] = {resolve, reject}
    })
  }

  /**
   * This function should be called to send a notification to the other end.
   *
   * TODO: handle multi-notifications.
   */
  async notify (method, params) {
    this.push(format.notification(method, params))
  }
}
