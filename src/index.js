import Duplex from 'readable-stream/duplex'
import forEach from 'lodash.foreach'
import isArray from 'lodash.isarray'
import map from 'lodash.map'
import {
  format,
  JsonRpcError,
  MethodNotFound,
  parse
} from 'json-rpc-protocol'

// ===================================================================

function makeAsync (fn) {
  return async function () {
    return fn.apply(this, arguments)
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

let nextRequestId = 0

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
    return this._deferreds[id]
  }

  // Emit buffered outgoing messages.
  _read () {}

  // Receive and execute incoming messages.
  _write (message, _, next) {
    this.exec(String(message)).then(response => {
      if (response !== undefined) {
        this.push(response)
      }
    }).catch(error => {
      this.emit('error', error)
    })

    next()
  }

  async exec (message) {
    try {
      message = parse(message)
    } catch (error) {
      return format.error(message.id, error)
    }

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
      return this._handle(message).catch(function (error) {
        // If the method name is not defined, default to the method passed
        // in the request.
        if (error instanceof MethodNotFound && !error.data) {
          throw new MethodNotFound(message.method)
        }

        throw error
      }).then(
        (result) => format.response(message.id, result === undefined ? null : result),
        (error) => format.error(message.id, error)
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
  async request (method, params) {
    const requestId = nextRequestId++

    this.push(format.request(requestId, method, params))

    // https://github.com/petkaantonov/bluebird/blob/master/API.md#deferred-migration
    return new Promise((resolve, reject) => {
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
