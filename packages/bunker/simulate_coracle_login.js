import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nip04, nip19 } from 'nostr-tools'

const targetBunkerUri = 'bunker://3881d4492fd70e5d7125fb45d7dd02f2b213e1c1915e66d9eb384d03eea9897f?relay=wss://relay.damus.io&relay=wss://nos.lol'

function parseBunkerUri(uri) {
  const u = new URL(uri)
  const targetPubkey = u.hostname || u.pathname.replace('//', '')
  const relays = u.searchParams.getAll('relay')
  return { targetPubkey, relays }
}

async function runCoracleSimulation() {
  const { targetPubkey, relays } = parseBunkerUri(targetBunkerUri)
  const relayUrl = relays[0] || 'wss://relay.damus.io'
  console.log(`Connecting to Relay: ${relayUrl} ...`)
  console.log(`Target Bunker Pubkey: ${targetPubkey}`)

  const clientSk = generateSecretKey()
  const clientPk = getPublicKey(clientSk)
  console.log(`Ephemeral Client Pubkey: ${clientPk}`)

  const ws = new WebSocket(relayUrl)

  await new Promise((resolve) => {
    ws.onopen = resolve
  })
  console.log('WebSocket open connected.')

  // 订阅响应
  const subId = 'coracle-sub-' + Math.random().toString(36).substring(7)
  ws.send(JSON.stringify([
    'REQ',
    subId,
    { kinds: [24133], '#p': [clientPk] }
  ]))

  const sendRpc = async (method, params = []) => {
    const id = Math.random().toString(36).substring(7)
    const payload = JSON.stringify({ id, method, params })
    console.log(`\n---> [SEND RPC ${method}] id=${id}`, params)

    const encrypted = await nip04.encrypt(clientSk, targetPubkey, payload)
    const event = finalizeEvent({
      kind: 24133,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', targetPubkey]],
      content: encrypted,
    }, clientSk)

    ws.send(JSON.stringify(['EVENT', event]))

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for response to ${method}`))
      }, 12000)

      const handler = async (evt) => {
        try {
          const msg = JSON.parse(evt.data.toString())
          if (msg[0] === 'EVENT' && msg[2] && msg[2].kind === 24133) {
            const ev = msg[2]
            const decrypted = await nip04.decrypt(clientSk, ev.pubkey, ev.content)
            const rpcRes = JSON.parse(decrypted)
            if (rpcRes.id === id) {
              clearTimeout(timer)
              ws.removeEventListener('message', handler)
              console.log(`<--- [RECV RPC ${method}] Result:`, rpcRes)
              resolve(rpcRes)
            }
          }
        } catch (e) {
          // ignore invalid msg
        }
      }

      ws.addEventListener('message', handler)
    })
  }

  try {
    console.log('\n--- Step 1: NIP-46 connect ---')
    const connectRes = await sendRpc('connect', [targetPubkey])
    
    console.log('\n--- Step 2: NIP-46 get_public_key ---')
    const pkRes = await sendRpc('get_public_key', [])

    console.log('\n--- Step 3: NIP-46 get_relays ---')
    const relaysRes = await sendRpc('get_relays', [])

    console.log('\n--- Step 4: NIP-46 ping ---')
    const pingRes = await sendRpc('ping', [])

    console.log('\n🎉🎉 ALL CORACLE LOGIN STEPS COMPLETED SUCCESSFULLY!')
    ws.close()
    process.exit(0)
  } catch (err) {
    console.error('\n❌ LOGIN SIMULATION FAILED:', err.message)
    ws.close()
    process.exit(1)
  }
}

runCoracleSimulation()
