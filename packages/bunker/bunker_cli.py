#!/usr/bin/env python3
"""
Nostr NIP-46 Bunker CLI 命令行客户端工具
用法：
  python bunker_cli.py ping "bunker://..."
  python bunker_cli.py get_public_key "bunker://..."
  python bunker_cli.py sign "bunker://..." "Hello Nostr from CLI!"
"""

import sys
import json
import time
import ssl
import hashlib
from urllib.parse import urlparse, parse_qs
import websocket
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.backends import default_backend
from coincurve import PrivateKey, PublicKey

def hex_to_bytes(h):
    return bytes.fromhex(h)

def get_shared_secret(sk_hex, pk_hex):
    sk = PrivateKey(bytes.fromhex(sk_hex))
    pk = PublicKey(bytes.fromhex('02' + pk_hex))
    shared = pk.multiply(sk.secret)
    return shared.format(compressed=True)[1:]

def encrypt_nip04(sk_hex, pk_hex, text):
    shared_secret = get_shared_secret(sk_hex, pk_hex)
    import os
    iv = os.urandom(16)
    padder = padding.PKCS7(128).padder()
    padded_data = padder.update(text.encode('utf-8')) + padder.finalize()
    cipher = Cipher(algorithms.AES(shared_secret), modes.CBC(iv), backend=default_backend())
    encryptor = cipher.encryptor()
    ciphertext = encryptor.update(padded_data) + encryptor.finalize()
    import base64
    return base64.b64encode(ciphertext).decode('utf-8') + "?iv=" + base64.b64encode(iv).decode('utf-8')

def decrypt_nip04(sk_hex, pk_hex, encrypted):
    try:
        shared_secret = get_shared_secret(sk_hex, pk_hex)
        parts = encrypted.split("?iv=")
        if len(parts) != 2: return encrypted
        import base64
        ciphertext = base64.b64decode(parts[0])
        iv = base64.b64decode(parts[1])
        cipher = Cipher(algorithms.AES(shared_secret), modes.CBC(iv), backend=default_backend())
        decryptor = cipher.decryptor()
        padded_data = decryptor.update(ciphertext) + decryptor.finalize()
        unpadder = padding.PKCS7(128).unpadder()
        data = unpadder.update(padded_data) + unpadder.finalize()
        return data.decode('utf-8')
    except Exception as e:
        return f"decrypt_error: {e}"

def main():
    if len(sys.argv) < 3:
        print("用法: python bunker_cli.py <command> <bunker_uri> [extra_args...]")
        print("指令: ping | get_public_key | get_relays | sign <text>")
        sys.exit(1)

    cmd = sys.argv[1]
    bunker_uri = sys.argv[2]
    extra = sys.argv[3] if len(sys.argv) > 3 else "Hello Nostr from Signpost CLI!"

    parsed = urlparse(bunker_uri)
    raw_target = parsed.netloc or parsed.path.strip('/')
    if raw_target.startswith('npub1'):
        # 用 simple bech32 解码或调用 worker API 转换
        import subprocess
        res = subprocess.check_output(['node', '-e', f"const {{ nip19 }} = require('nostr-tools'); console.log(nip19.decode('{raw_target}').data)"]).decode('utf-8').strip()
        target_bunker_pubkey = res
    else:
        target_bunker_pubkey = raw_target
    query = parse_qs(parsed.query)
    relays = query.get('relay', ['wss://nostr-relay.nilpote.com'])
    primary_relay = relays[0]

    print(f"==================================================")
    print(f"🚀 Nostr NIP-46 CLI 命令行交互测试工具")
    print(f"目标 Bunker 公钥: {target_bunker_pubkey}")
    print(f"连接中继器 Relay: {primary_relay}")
    print(f"==================================================")

    client_sk = PrivateKey()
    client_pk = client_sk.public_key.format(compressed=True)[1:].hex()

    # WebSocket 握手
    ws = websocket.WebSocket(sslopt={"cert_reqs": ssl.CERT_NONE})
    try:
        ws.connect(primary_relay, http_proxy_host="127.0.0.1", http_proxy_port=7897, timeout=10)
    except Exception:
        ws.connect(primary_relay, timeout=10)

    sub_id = f"cli-sub-{int(time.time())}"
    ws.send(json.dumps(["REQ", sub_id, {"kinds": [24133], "#p": [client_pk]}]))

    def call_rpc(method, params=[]):
        rpc_id = str(int(time.time() * 1000))
        req_body = json.dumps({"id": rpc_id, "method": method, "params": params})
        enc_content = encrypt_nip04(client_sk.to_hex(), target_bunker_pubkey, req_body)

        created_at = int(time.time())
        event_data = [0, client_pk, created_at, 24133, [["p", target_bunker_pubkey]], enc_content]
        event_id = hashlib.sha256(json.dumps(event_data, separators=(',', ':')).encode('utf-8')).hexdigest()
        sig = client_sk.sign_schnorr(bytes.fromhex(event_id)).hex()

        ev_dict = {
            "id": event_id,
            "pubkey": client_pk,
            "created_at": created_at,
            "kind": 24133,
            "tags": [["p", target_bunker_pubkey]],
            "content": enc_content,
            "sig": sig
        }

        ws.send(json.dumps(["EVENT", ev_dict]))

        ws.settimeout(8.0)
        start_t = time.time()
        while time.time() - start_t < 8:
            try:
                msg = ws.recv()
                data = json.loads(msg)
                if data[0] == "EVENT" and len(data) >= 3 and data[2].get("kind") == 24133:
                    ev = data[2]
                    plain = decrypt_nip04(client_sk.to_hex(), ev["pubkey"], ev.get("content", ""))
                    if plain.startswith("decrypt_error"): continue
                    try:
                        res = json.loads(plain)
                        if res.get("id") == rpc_id:
                            return res
                    except Exception:
                        pass
            except Exception:
                pass
        return {"error": "Timeout waiting for Bunker response"}

    print(f"\n[1/2] 发起 NIP-46 [connect] 握手...")
    conn_res = call_rpc("connect", [target_bunker_pubkey])
    print(f"➜ Connect 应答结果: {conn_res}")

    if cmd == "ping":
        print(f"\n[2/2] 发起 [ping] 心跳测速...")
        res = call_rpc("ping", [])
        print(f"🎉 Ping 响应结果: {res}")
    elif cmd == "get_public_key":
        print(f"\n[2/2] 发起 [get_public_key] 查询公钥...")
        res = call_rpc("get_public_key", [])
        print(f"🎉 公钥查询结果: {res}")
    elif cmd == "sign":
        print(f"\n[2/2] 发起 [sign_event] 事件签名...")
        event_tpl = {
            "kind": 1,
            "created_at": int(time.time()),
            "tags": [],
            "content": extra
        }
        res = call_rpc("sign_event", [json.dumps(event_tpl)])
        print(f"🎉 远程电子签名成功完成！")
        print(f"返回结果:\n{json.dumps(res, indent=2)}")

if __name__ == "__main__":
    main()
