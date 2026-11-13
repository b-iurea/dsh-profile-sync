/**
 * Boot check for the client bundle: the module loader contract only needs
 * window.__ModuleLoader__.load({ id, factory }), a factory that returns
 * { apply, inject }, and a slots service to register the overlay into.
 * React is never rendered here, so a minimal stub is enough.
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const registered = []
const React = {
  Fragment: Symbol('Fragment'),
  createElement: (...args) => ({ args }),
  useState: () => [null, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      assert.equal(id, 'dsh-profile-sync')
      const exports = factory((name) => {
        assert.equal(name, 'react')
        return React
      })
      assert.equal(typeof exports.apply, 'function')
      assert.deepEqual(exports.inject, ['slots'])
      const ctx = {
        slots: {
          inject(name, callback) {
            assert.equal(name, 'shell.overlay')
            return callback()
          },
          register(options, Component) {
            registered.push({ options, Component })
            return () => {}
          },
        },
      }
      exports.apply(ctx)
    },
  },
}

await import(pathToFileURL(resolve('lib/client.js')).href)

assert.equal(registered.length, 1)
const [{ options, Component }] = registered
assert.equal(options.name, 'shell.overlay')
assert.equal(options.id, 'dsh-profile-sync:panel')
assert.equal(typeof Component, 'function')
console.log('client bundle registers the overlay panel: ok')
