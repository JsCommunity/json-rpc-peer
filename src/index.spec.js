/* eslint-env mocha */

import expect from 'must'

// ===================================================================

import Peer, {MethodNotFound} from './'

// ===================================================================

describe('Peer', () => {
  let server, client
  const messages = []

  before(() => {
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

    expect(messages.length).to.equal(1)
    expect(messages[0].method).to.equal('foo')
    expect(messages[0].type).to.equal('notification')
  })

  it('#request()', () => {
    const result = client.request('identity', [42])

    expect(messages.length).to.equal(1)
    expect(messages[0].method).to.equal('identity')
    expect(messages[0].type).to.equal('request')

    return result.then(result => {
      expect(result).to.equal(42)
    })
  })

  it('#request() injects method name when MethodNotFound', () => {
    return client.request('foo').then(
      () => {
        expect('should have been rejected').to.be.falsy()
      },
      error => {
        expect(error.code).to.equal(-32601)
        expect(error.data).to.equal('foo')
      }
    )
  })

  it('#request() in parallel', function () {
    this.timeout(30)

    return Promise.all([
      client.request('wait', [20]),
      client.request('wait', [20])
    ])
  })

  describe('#write()', function () {
    it('emits an error event if the response message cannot be formatted', function (done) {
      server.on('error', () => done())

      client.request('circular value')
    })
  })
})
