/* eslint-disable camelcase */
const { sodium_malloc, sodium_memzero, sodium_free } = require('sodium-universal/memory')
const assert = require('nanoassert')
const clone = require('clone')

function createHandshake ({ dh, hash, cipher, symmetricState, cipherState }) {
  const DhResult = sodium_malloc(dh.DHLEN)

  function HandshakeState () {
    this.symmetricState = sodium_malloc(symmetricState.STATELEN)

    this.initiator = null

    this.spk = null
    this.ssk = null

    this.epk = null
    this.esk = null

    this.rs = null
    this.re = null

    this.psks = []
    this.messagePatterns = null
  }

  function getPatternAndPskModifier (handshakePattern) {
    const match = handshakePattern.match(/^([A-Z]*)(.*)?$/)
    const pattern = match[1];
    const modifiers = match[2];
    return { pattern, modifiers: modifiers ? modifiers.split('+') : [] }
  }

  function initialize (handshakePattern, initiator, prologue, s, e, rs, re) {
    const patternModifier = getPatternAndPskModifier(handshakePattern)
    assert(Object.keys(PATTERNS).includes(patternModifier.pattern), 'Unsupported handshake pattern')
    assert(typeof initiator === 'boolean', 'Initiator must be a boolean')
    assert(prologue.byteLength != null, 'prolouge must be a Buffer')

    assert(e == null ? true : e.publicKey.byteLength === dh.PKLEN, `e.publicKey must be ${dh.PKLEN} bytes`)
    assert(e == null ? true : e.secretKey.byteLength === dh.SKLEN, `e.secretKey must be ${dh.SKLEN} bytes`)

    assert(rs == null ? true : rs.byteLength === dh.PKLEN, `rs must be ${dh.PKLEN} bytes`)
    assert(re == null ? true : re.byteLength === dh.PKLEN, `re must be ${dh.PKLEN} bytes`)

    const state = new HandshakeState()

    const protocolName = Uint8Array.from(`Noise_${handshakePattern}_${dh.ALG}_${cipher.ALG}_${hash.ALG}`, toCharCode)

    symmetricState.initializeSymmetric(state.symmetricState, protocolName)
    symmetricState.mixHash(state.symmetricState, prologue)

    state.role = initiator === true ? INITIATOR : RESPONDER

    if (s != null) {
      assert(s.publicKey.byteLength === dh.PKLEN, `s.publicKey must be ${dh.PKLEN} bytes`)
      assert(s.secretKey.byteLength === dh.SKLEN, `s.secretKey must be ${dh.SKLEN} bytes`)

      state.spk = sodiumBufferCopy(s.publicKey)
      state.ssk = sodiumBufferCopy(s.secretKey)
    }

    if (e != null) {
      assert(e.publicKey.byteLength === dh.PKLEN)
      assert(e.secretKey.byteLength === dh.SKLEN)

      state.epk = sodiumBufferCopy(e.publicKey)
      state.esk = sodiumBufferCopy(e.secretKey)
    }

    if (rs != null) {
      assert(rs.byteLength === dh.PKLEN)
      state.rs = sodiumBufferCopy(rs)
    }
    if (re != null) {
      assert(re.byteLength === dh.PKLEN)
      state.re = sodiumBufferCopy(re)
    }

    // hashing
    const pat = PATTERNS[patternModifier.pattern]

    for (const pattern of clone(pat.premessages)) {
      const patternRole = pattern.shift()

      for (const token of pattern) {
        switch (token) {
          case TOK_E:
            assert(state.role === patternRole ? state.epk.byteLength != null : state.re.byteLength != null)
            symmetricState.mixHash(state.symmetricState, state.role === patternRole ? state.epk : state.re)
            break
          case TOK_S:
            assert(state.role === patternRole ? state.spk.byteLength != null : state.rs.byteLength != null)
            symmetricState.mixHash(state.symmetricState, state.role === patternRole ? state.spk : state.rs)
            break
          default:
            throw new Error('Invalid premessage pattern')
        }
      }
    }

    state.messagePatterns = clone(pat.messagePatterns)

    for(const modifier of patternModifier.modifiers) {
      const match = modifier.match(/^psk(\d)$/);
      assert(match !== null, `Only psk# modifiers supported, found ${modifier}`);
      const psk = match[1] * 1
      assert(state.messagePatterns.length >= Math.floor(psk / 2), 'Bad psk modifier')
      if (psk === 0) {
        const value = state.messagePatterns[0][0]
        state.messagePatterns[0].unshift(value)
        state.messagePatterns[0][1] = TOK_PSK
      } else state.messagePatterns[psk - 1].push(TOK_PSK)
      state.pskCount = (state.pskCount || 0) + 1
    }

    assert(state.messagePatterns.filter(p => p[0] === INITIATOR).some(p => p.includes(TOK_S))
      ? (state.spk !== null && state.ssk !== null)
      : true, // Default if none is found
    'This handshake pattern requires a static keypair')

    return state
  }

  function setPsks (state, ...psks) {
    assert(
      psks.length === state.pskCount,
      'Cannot specify more psks that required'
    )
    assert(
      psks.every((psk) => psk.byteLength != null),
      'PSKs must be Buffers'
    )
    state.psks = psks
  }

  function writeMessage (state, payload, messageBuffer) {
    assert(state instanceof HandshakeState)
    assert(payload.byteLength != null)
    assert(messageBuffer.byteLength != null)

    const mpat = state.messagePatterns.shift()
    let moffset = 0

    assert(mpat != null)

    assert(state.role === mpat.shift())

    for (const token of mpat) {
      switch (token) {
        case TOK_E:
          assert(state.epk == null)
          assert(state.esk == null)

          state.epk = sodium_malloc(dh.PKLEN)
          state.esk = sodium_malloc(dh.SKLEN)

          dh.generateKeypair(state.epk, state.esk)

          messageBuffer.set(state.epk, moffset)
          moffset += state.epk.byteLength

          symmetricState.mixHash(state.symmetricState, state.epk)
          if(state.pskCount > 0) symmetricState.mixKey(state.symmetricState, state.epk)

          break

        case TOK_S:
          assert(state.spk.byteLength === dh.PKLEN)

          symmetricState.encryptAndHash(state.symmetricState, messageBuffer.subarray(moffset), state.spk)
          moffset += symmetricState.encryptAndHash.bytesWritten

          break

        case TOK_EE:
          dh.dh(DhResult, state.esk, state.re)
          symmetricState.mixKey(state.symmetricState, DhResult)
          sodium_memzero(DhResult)
          break
        case TOK_ES:
          if (state.role === INITIATOR) dh.dh(DhResult, state.esk, state.rs)
          else dh.dh(DhResult, state.ssk, state.re)

          symmetricState.mixKey(state.symmetricState, DhResult)
          sodium_memzero(DhResult)
          break
        case TOK_SE:
          if (state.role === INITIATOR) dh.dh(DhResult, state.ssk, state.re)
          else dh.dh(DhResult, state.esk, state.rs)

          symmetricState.mixKey(state.symmetricState, DhResult)
          sodium_memzero(DhResult)
          break
        case TOK_SS:
          dh.dh(DhResult, state.ssk, state.rs)

          symmetricState.mixKey(state.symmetricState, DhResult)
          sodium_memzero(DhResult)
          break
        case TOK_PSK:
          symmetricState.mixKeyAndHash(
            state.symmetricState,
            state.psks.shift()
          )
          break

        default:
          throw new Error('Invalid message pattern')
      }
    }

    symmetricState.encryptAndHash(state.symmetricState, messageBuffer.subarray(moffset), payload)
    moffset += symmetricState.encryptAndHash.bytesWritten

    writeMessage.bytes = moffset

    if (state.messagePatterns.length === 0) {
      const tx = sodium_malloc(cipherState.STATELEN)
      const rx = sodium_malloc(cipherState.STATELEN)
      symmetricState.split(state.symmetricState, tx, rx, dh.DHLEN, dh.PKLEN)

      return { tx, rx }
    }
  }
  writeMessage.bytes = 0

  function readMessage (state, message, payloadBuffer) {
    assert(state instanceof HandshakeState)
    assert(message.byteLength != null)
    assert(payloadBuffer.byteLength != null)

    const mpat = state.messagePatterns.shift()
    let moffset = 0

    assert(mpat != null)
    assert(mpat.shift() !== state.role)

    for (const token of mpat) {
      switch (token) {
        case TOK_E:
          assert(state.re == null)
          assert(message.byteLength - moffset >= dh.PKLEN)

          // PKLEN instead of DHLEN since they are different in out case
          state.re = sodium_malloc(dh.PKLEN)
          state.re.set(message.subarray(moffset, moffset + dh.PKLEN))
          moffset += dh.PKLEN

          symmetricState.mixHash(state.symmetricState, state.re)
          if(state.pskCount > 0) symmetricState.mixKey(state.symmetricState, state.re)

          break

        case TOK_S: {
          assert(state.rs == null)
          state.rs = sodium_malloc(dh.PKLEN)

          let bytes = 0
          if (symmetricState._hasKey(state.symmetricState)) {
            bytes = dh.PKLEN + 16
          } else {
            bytes = dh.PKLEN
          }

          assert(message.byteLength - moffset >= bytes)

          symmetricState.decryptAndHash(
            state.symmetricState,
            state.rs,
            message.subarray(moffset, moffset + bytes) // <- called temp in noise spec
          )

          moffset += symmetricState.decryptAndHash.bytesRead

          break
        }
        case TOK_EE:
          dh.dh(DhResult, state.esk, state.re)
          symmetricState.mixKey(state.symmetricState, DhResult)
          sodium_memzero(DhResult)
          break
        case TOK_ES:
          if (state.role === INITIATOR) dh.dh(DhResult, state.esk, state.rs)
          else dh.dh(DhResult, state.ssk, state.re)

          symmetricState.mixKey(state.symmetricState, DhResult)
          sodium_memzero(DhResult)
          break
        case TOK_SE:
          if (state.role === INITIATOR) dh.dh(DhResult, state.ssk, state.re)
          else dh.dh(DhResult, state.esk, state.rs)

          symmetricState.mixKey(state.symmetricState, DhResult)
          sodium_memzero(DhResult)
          break
        case TOK_SS:
          dh.dh(DhResult, state.ssk, state.rs)

          symmetricState.mixKey(state.symmetricState, DhResult)
          sodium_memzero(DhResult)
          break
        case TOK_PSK:
          symmetricState.mixKeyAndHash(
            state.symmetricState,
            state.psks.shift()
          )
          break

        default:
          throw new Error('Invalid message pattern')
      }
    }

    symmetricState.decryptAndHash(state.symmetricState, payloadBuffer, message.subarray(moffset))

    // How many bytes were written to payload (minus the TAG/MAC)
    readMessage.bytes = symmetricState.decryptAndHash.bytesWritten

    if (state.messagePatterns.length === 0) {
      const tx = sodium_malloc(cipherState.STATELEN)
      const rx = sodium_malloc(cipherState.STATELEN)
      symmetricState.split(state.symmetricState, rx, tx, dh.DHLEN, dh.PKLEN)

      return { tx, rx }
    }
  }
  readMessage.bytes = 0

  function keygen (obj, sk) {
    if (!obj) {
      obj = { publicKey: sodium_malloc(dh.PKLEN), secretKey: sodium_malloc(dh.SKLEN) }
      return keygen(obj)
    }

    if (obj.publicKey) {
      dh.generateKeypair(obj.publicKey, obj.secretKey)
      return obj
    }

    if (obj.byteLength != null) dh.generateKeypair(null, obj)
  }

  function seedKeygen (seed) {
    const obj = { publicKey: sodium_malloc(dh.PKLEN), secretKey: sodium_malloc(dh.SKLEN) }
    dh.generateSeedKeypair(obj.publicKey, obj.secretKey, seed)
    return obj
  }

  return Object.freeze({
    initialize,
    writeMessage,
    readMessage,
    destroy,
    keygen,
    seedKeygen,
    createHandshake,
    setPsks,
    SKLEN: dh.SKLEN,
    PKLEN: dh.PKLEN
  })
}

const INITIATOR = Symbol('initiator')
const RESPONDER = Symbol('responder')

const TOK_S = Symbol('s')
const TOK_E = Symbol('e')
const TOK_ES = Symbol('es')
const TOK_SE = Symbol('se')
const TOK_EE = Symbol('ee')
const TOK_SS = Symbol('es')
const TOK_PSK = Symbol('psk')

// initiator, ->
// responder, <-
const PATTERNS = Object.freeze({
  N: {
    premessages: [
      [RESPONDER, TOK_S]
    ],
    messagePatterns: [
      [INITIATOR, TOK_E, TOK_ES]
    ]
  },
  K: {
    premessages: [
      [INITIATOR, TOK_S],
      [RESPONDER, TOK_S]
    ],
    messagePatterns: [
      [INITIATOR, TOK_E, TOK_ES, TOK_SS]
    ]
  },
  X: {
    premessages: [
      [RESPONDER, TOK_S]
    ],
    messagePatterns: [
      [INITIATOR, TOK_E, TOK_ES, TOK_S, TOK_SS]
    ]
  },
  NN: {
    premessages: [],
    messagePatterns: [
      [INITIATOR, TOK_E],
      [RESPONDER, TOK_E, TOK_EE]
    ]
  },
  KN: {
    premessages: [
      [INITIATOR, TOK_S]
    ],
    messagePatterns: [
      [INITIATOR, TOK_E],
      [RESPONDER, TOK_E, TOK_EE, TOK_SE]
    ]
  },
  NK: {
    premessages: [
      [RESPONDER, TOK_S]
    ],
    messagePatterns: [
      [INITIATOR, TOK_E, TOK_ES],
      [RESPONDER, TOK_E, TOK_EE]
    ]
  },
  KK: {
    premessages: [
      [INITIATOR, TOK_S],
      [RESPONDER, TOK_S]
    ],
    messagePatterns: [
      [INITIATOR, TOK_E, TOK_ES, TOK_SS],
      [RESPONDER, TOK_E, TOK_EE, TOK_SE]
    ]
  },
  NX: {
    premessages: [],
    messagePatterns: [
      [INITIATOR, TOK_E],
      [RESPONDER, TOK_E, TOK_EE, TOK_S, TOK_ES]
    ]
  },
  KX: {
    premessages: [
      [INITIATOR, TOK_S]
    ],
    messagePatterns: [
      [INITIATOR, TOK_E],
      [RESPONDER, TOK_E, TOK_EE, TOK_SE, TOK_S, TOK_ES]
    ]
  },
  XN: {
    premessages: [],
    messagePatterns: [
      [INITIATOR, TOK_E],
      [RESPONDER, TOK_E, TOK_EE],
      [INITIATOR, TOK_S, TOK_SE]
    ]
  },
  IN: {
    premessages: [],
    messagePatterns: [
      [INITIATOR, TOK_E, TOK_S],
      [RESPONDER, TOK_E, TOK_EE, TOK_SE]
    ]
  },
  XK: {
    premessages: [
      [RESPONDER, TOK_S]
    ],
    messagePatterns: [
      [INITIATOR, TOK_E, TOK_ES],
      [RESPONDER, TOK_E, TOK_EE],
      [INITIATOR, TOK_S, TOK_SE]
    ]
  },
  IK: {
    premessages: [
      [RESPONDER, TOK_S]
    ],
    messagePatterns: [
      [INITIATOR, TOK_E, TOK_ES, TOK_S, TOK_SS],
      [RESPONDER, TOK_E, TOK_EE, TOK_SE]
    ]
  },
  XX: {
    premessages: [],
    messagePatterns: [
      [INITIATOR, TOK_E],
      [RESPONDER, TOK_E, TOK_EE, TOK_S, TOK_ES],
      [INITIATOR, TOK_S, TOK_SE]
    ]
  },
  IX: {
    premessages: [],
    messagePatterns: [
      [INITIATOR, TOK_E, TOK_S],
      [RESPONDER, TOK_E, TOK_EE, TOK_SE, TOK_S, TOK_ES]
    ]
  }
})

function sodiumBufferCopy (src) {
  const buf = sodium_malloc(src.byteLength)
  buf.set(src)
  return buf
}

function destroy (state) {
  if (state.symmetricState != null) {
    sodium_free(state.symmetricState)
    state.symmetricState = null
  }

  state.role = null

  if (state.spk != null) {
    sodium_free(state.spk)
    state.spk = null
  }

  if (state.ssk != null) {
    sodium_free(state.ssk)
    state.ssk = null
  }

  if (state.epk != null) {
    sodium_free(state.epk)
    state.epk = null
  }

  if (state.esk != null) {
    sodium_free(state.esk)
    state.esk = null
  }

  if (state.rs != null) {
    sodium_free(state.rs)
    state.rs = null
  }

  if (state.re != null) {
    sodium_free(state.re)
    state.re = null
  }

  state.messagePatterns = null
}

function toCharCode (s) {
  return s.charCodeAt(0)
}

module.exports = createHandshake
