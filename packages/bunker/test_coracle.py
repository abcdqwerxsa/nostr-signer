import json
import time
import ssl
import base64
import os
import websocket
from urllib.parse import urlparse, parse_qs
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding
from coincurve import PrivateKey, PublicKey

def get_shared_secret(sk_hex, pk_hex):
    sk = PrivateKey.from_hex(sk_hex)
    pk = PublicKey(bytes.fromhex("02" + pk_hex)) # compressed point
    shared = pk.multiply(sk.secret)
    return shared.format(compressed=True)[1:] # 32 bytes x-coord

def encrypt_nip04(sk_hex, pk_hex, text):
    shared_secret = get_shared_secret(sk_hex, pk_hex)
    iv = os.urandom(16)
    padder = padding.PKCS7(128).padder()
    padded_data = padder.update(text.encode('utf-8')) + padder.finalize()
    cipher = Cipher(algorithms.AES(shared_secret), modes.CBC(iv))
    encryptor = cipher.encryptor()
    ciphertext = encryptor.update(padded_data) + encryptor.finalize()
    return base64.b64encode(ciphertext).decode('utf-8') + "?iv=" + base64.b64encode(iv).decode('utf-8')

def decrypt_nip04(sk_hex, pk_hex, encrypted):
    shared_secret = get_shared_secret(sk_hex, pk_hex)
    parts = encrypted.split("?iv=")
    ciphertext = base64.b64decode(parts[0])
    iv = base64.b64decode(parts[1])
    cipher = Cipher(algorithms.AES(shared_secret), modes.CBC(iv))
    decryptor = cipher.decryptor()
    padded_data = decryptor.update(ciphertext) + decryptor.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    data = unpadder.update(padded_data) + unpadder.finalize()
    return data.decode('utf-8')

bunker_uri = "bunker://77141f82272a10de69eeda3a243bfda281f68c283c4e65ec16c2689d2f80702c?relay=wss://nos.lol&relay=wss://relay.primal.net"
parsed = urlparse(bunker_uri)
target_bunker_pubkey = parsed.netloc or parsed.path.strip('/')

client_sk = PrivateKey()
client_pk = client_sk.public_key.format(compressed=True)[1:].hex()

print(f"Target Bunker Pubkey: {target_bunker_pubkey}")
print(f"Client Pubkey: {client_pk}")

ws = websocket.WebSocket(sslopt={"cert_reqs": ssl.CERT_NONE})
ws.connect("wss://nos.lol", http_proxy_host="127.0.0.1", http_proxy_port=7897)
print("WebSocket connected successfully!")

sub_id = "coracle-sub-1"
ws.send(json.dumps(["REQ", sub_id, {"kinds": [24133], "#p": [client_pk]}]))

def send_rpc(method, params=[]):
    rpc_id = str(int(time.time() * 1000))
    req_body = json.dumps({"id": rpc_id, "method": method, "params": params})
    print(f"\n---> Sending RPC [{method}] id={rpc_id} params={params}")
    
    enc_content = encrypt_nip04(client_sk.to_hex(), target_bunker_pubkey, req_body)
    
    # sign event
    created_at = int(time.time())
    event_data = [0, client_pk, created_at, 24133, [["p", target_bunker_pubkey]], enc_content]
    import hashlib
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
    
    start_t = time.time()
    while time.time() - start_t < 10:
        res = ws.recv()
        data = json.loads(res)
        if data[0] == "EVENT" and data[2]["kind"] == 24133:
            ev = data[2]
            dec = decrypt_nip04(client_sk.to_hex(), ev["pubkey"], ev["content"])
            rpc_res = json.loads(dec)
            if rpc_res.get("id") == rpc_id:
                print(f"<--- Received RPC [{method}] Response:", rpc_res)
                return rpc_res
    raise TimeoutError(f"RPC [{method}] timed out")

try:
    print("\n--- Step 1: connect ---")
    send_rpc("connect", [target_bunker_pubkey])

    print("\n--- Step 2: get_public_key ---")
    send_rpc("get_public_key", [])

    print("\n--- Step 3: get_relays ---")
    send_rpc("get_relays", [])

    print("\n--- Step 4: ping ---")
    send_rpc("ping", [])

    print("\n🎉🎉 ALL CORACLE LOGIN STEPS COMPLETED!")
except Exception as e:
    print("\n❌ FAILED:", e)

ws.close()
