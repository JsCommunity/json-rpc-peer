/* eslint-env mocha */

import expect from 'must'

// ===================================================================

import Peer from './'

// ===================================================================

describe('Peer', () => {
  let server, client
  const messages = []

  before(() => {
    server = new Peer(message => {
      messages.push(message)

      if (message.method === 'wait') {
        return new Promise(resolve => {
          setTimeout(resolve, message.params[0])
        })
      }
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
    const result = client.request('foo')

    expect(messages.length).to.equal(1)
    expect(messages[0].method).to.equal('foo')
    expect(messages[0].type).to.equal('request')

    return result
  })

  it('#request() in parallel', function () {
    this.timeout(15)

    return Promise.all([
      client.request('wait', [10]),
      client.request('wait', [10])
    ])
  })
})
