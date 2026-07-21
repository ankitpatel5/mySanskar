#!/usr/bin/env python3
"""Migrate Satsang Diksha videos from Google Drive to Cloudflare R2, and
compute full-chant timestamps (sd-meta.js) in the same pass.

For each shlok 1..315:
  1. skip if already uploaded (checked against R2 object listing)
  2. download from Drive (long backoff on 403 — never poke an IP block)
  3. run the refined visual+audio detector if the shlok lacks a timestamp
  4. upload to R2 as shloka-N.mp4 via the Cloudflare REST API
     (the S3 endpoint is TLS-blocked on this network; api.cloudflare.com works)
  5. verify the public URL serves the exact byte size

Resumable: state = R2 listing (uploads) + sd-meta.js (timestamps).
Credentials: .r2-creds.json (gitignored).
"""
import importlib.util, json, os, subprocess, sys, tempfile, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CREDS = json.load(open(os.path.join(ROOT, '.r2-creds.json')))
API = f"https://api.cloudflare.com/client/v4/accounts/{CREDS['accountId']}/r2/buckets/{CREDS['bucket']}"
AUTH = ['-H', f"Authorization: Bearer {CREDS['restToken']}"]
PACE_S = 20

spec = importlib.util.spec_from_file_location('bsm', os.path.join(ROOT, 'scripts', 'build-sd-meta.py'))
bsm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bsm)

def r2_existing():
    keys, cursor = set(), ''
    while True:
        url = f"{API}/objects?per_page=1000" + (f"&cursor={cursor}" if cursor else '')
        out = subprocess.run(['curl', '-s', url, *AUTH], capture_output=True, text=True).stdout
        d = json.loads(out)
        for o in d.get('result', []) or []:
            keys.add(o['key'])
        info = d.get('result_info') or {}
        cursor = info.get('cursor') or ''
        if not cursor or not d.get('result'):
            break
    return keys

def r2_put(key, path):
    last = ''
    for attempt in range(4):   # empty/garbled responses = transient network blips
        out = subprocess.run(['curl', '-s', '-X', 'PUT', f"{API}/objects/{key}", *AUTH,
                              '-H', 'Content-Type: video/mp4', '--data-binary', f'@{path}'],
                             capture_output=True, text=True).stdout
        try:
            d = json.loads(out)
        except ValueError:
            last = out[:120]
            time.sleep(10 * (attempt + 1))
            continue
        if d.get('success'):
            return int((d.get('result') or {}).get('size') or -1)
        last = str(d.get('errors'))
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"R2 PUT {key} failed after retries: {last}")

def public_size(key):
    # r2.dev rejects HEAD; a 1-byte ranged GET returns the total in Content-Range
    req = urllib.request.Request(f"{CREDS['publicBase']}/{key}", headers={'Range': 'bytes=0-0'})
    with urllib.request.urlopen(req) as r:
        cr = r.headers.get('Content-Range', '')   # e.g. "bytes 0-0/2365605"
        return int(cr.rsplit('/', 1)[-1]) if '/' in cr else -1

def drive_download(url, dest):
    for attempt in range(6):
        try:
            with urllib.request.urlopen(url) as r:
                dest.write(r.read())
            return
        except urllib.error.HTTPError as e:
            if e.code in (403, 429, 500, 503) and attempt < 5:
                wait = 300 * (attempt + 1)
                print(f'  HTTP {e.code}, waiting {wait}s', flush=True)
                time.sleep(wait)
            else:
                raise

def main():
    key = bsm.api_key()
    listing = bsm.drive_list(key)
    meta = bsm.load_meta()
    done = r2_existing()
    todo = sorted(listing, key=int)
    print(f'{len(todo)} shloks | already in R2: {len(done)} | timestamps known: {len(meta)}', flush=True)
    fails = []
    for idx, n in enumerate(todo, 1):
        r2key = f'shloka-{n}.mp4'
        need_upload = r2key not in done
        need_meta = n not in meta
        if not need_upload and not need_meta:
            continue
        with tempfile.NamedTemporaryFile(suffix='.mp4') as tf:
            drive_download(f"https://www.googleapis.com/drive/v3/files/{listing[n]}?alt=media&key={key}", tf)
            tf.flush()
            size = os.path.getsize(tf.name)
            if need_meta:
                t = bsm.detect(tf.name)
                if t is None:
                    fails.append(n)
                    print(f'[{idx}/{len(todo)}] #{n}: NO TIMESTAMP (video uploads anyway)', flush=True)
                else:
                    meta[n] = t
            if need_upload:
                # verify via the PUT response, NOT r2.dev — the dev URL is
                # rate-limited and 403'd per-upload verification probes
                stored = r2_put(r2key, tf.name)
                if stored != size:
                    raise RuntimeError(f'{r2key}: local {size} bytes but R2 stored {stored}')
        print(f'[{idx}/{len(todo)}] #{n}: {"t="+str(meta[n])+"s " if n in meta else ""}'
              f'{"uploaded "+str(size)+"b ok" if need_upload else "meta only"}', flush=True)
        if idx % 10 == 0:
            bsm.save_meta(meta)
        time.sleep(PACE_S)
    bsm.save_meta(meta)
    print(f'done. meta entries: {len(meta)}, no-timestamp: {fails}', flush=True)

if __name__ == '__main__':
    main()
