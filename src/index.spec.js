/* eslint-env jest */

import Peer, {MethodNotFound} from './'

// ===================================================================

describe('Peer', () => {
  let server, client
  const messages = []

  beforeAll(() => {
    server = new Peer(message => {
      messages.push(message)

      if (message.type === 'notification') {
        return
      }

      const {method} = message

      if (method === 'circular value') {
        const a = []
        a.push(a)

        return a
      }

      if (method === 'identity') {
        return message.params[0]
      }

      if (method === 'wait') {
        return new Promise(resolve => {
          setTimeout(resolve, message.params[0])
        })
      }

      throw new MethodNotFound()
    })

    client = new Peer()

    server.pipe(client).pipe(server)
  })

  afterEach(() => {
    messages.length = 0
  })

  // =================================================================

  it('#notify()', () => {
    client.notify('foo')

    expect(messages.length).toBe(1)
    expect(messages[0].method).toBe('foo')
    expect(messages[0].type).toBe('notification')
  })

  it('#request()', () => {
    const result = client.request('identity', [42])

    expect(messages.length).toBe(1)
    expect(messages[0].method).toBe('identity')
    expect(messages[0].type).toBe('request')

    return result.then(result => {
      expect(result).toBe(42)
    })
  })

  it('#request() injects method name when MethodNotFound', () => {
    return client.request('foo').then(
      () => {
        expect('should have been rejected').toBeFalsy()
      },
      error => {
        expect(error.code).toBe(-32601)
        expect(error.data).toBe('foo')
      }
    )
  })

  it('#request() in parallel', function () {
    const start = Date.now()

    return Promise.all([
      client.request('wait', [25]),
      client.request('wait', [25]),
    ]).then(() => {
      expect(Date.now() - start).toBeLessThan(40)
    })
  })

  describe('#write()', function () {
    it('emits an error event if the response message cannot be formatted', function (done) {
      server.on('error', () => done())

      client.request('circular value')
    })
  })
})
