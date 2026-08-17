import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nip04 } from 'nostr-tools'

const targetBunkerPubkey = '46cf03dfc20e8b86dd8d49e738f7596114568edcf720ad4bd7fd1e2c7d8437b4'
const relayUrl = 'wss://nos.lol'

const clientSk = generateSecretKey()
const clientPk = getPublicKey(clientSk)

console.log('Client Pubkey:', clientPk)
console.log('Target Bunker Pubkey:', targetBunkerPubkey)

const ws = new globalThis.WebSocket(relayUrl)

ws.onopen = async () => {
  console.log('Connected to relay:', relayUrl)

  // 1. 订阅回应
  ws.send(JSON.stringify([
    'REQ',
    'client-sub',
    { kinds: [24133], '#p': [clientPk] }
  ]))

  // 2. 发送 connect 请求 (使用 NIP-04 加密)
  const reqObj = {
    id: 'test_req_123',
    method: 'connect',
    params: [targetBunkerPubkey, '']
  }
  const encrypted = await nip04.encrypt(clientSk, targetBunkerPubkey, JSON.stringify(reqObj))

  const event = finalizeEvent({
    kind: 24133,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', targetBunkerPubkey]],
    content: encrypted,
  }, clientSk)

  console.log('Publishing NIP-46 connect event to relay...')
  ws.send(JSON.stringify(['EVENT', event]))
}

ws.onmessage = (data) => {
  console.log('>>> Relay Message Raw:', data.data)
  if (data.data.includes('EVENT')) {
    console.log('🎉🎉 SUCCESS! Received response event from Bunker!')
    process.exit(0)
  }
}

setTimeout(() => {
  console.log('Timeout after 10s waiting for Bunker response.')
  process.exit(1)
}, 10000)
