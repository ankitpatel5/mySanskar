#!/usr/bin/env python3
"""Upload Satsang Diksha videos to R2 from the LOCAL folder (~/Desktop/Satsang
Diksha) and compute full-chant timestamps in the same pass. Supersedes the
Drive-download path in migrate-sd-r2.py — no Drive, no rate limits.
Resumable: R2 listing + sd-meta.js are the state."""
import importlib.util, json, os, re, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.expanduser('~/Desktop/Satsang Diksha')
spec = importlib.util.spec_from_file_location('mig', os.path.join(ROOT, 'scripts', 'migrate-sd-r2.py'))
mig = importlib.util.module_from_spec(spec)
src = open(os.path.join(ROOT, 'scripts', 'migrate-sd-r2.py')).read().replace(
    "if __name__ == '__main__':\n    main()", '')
exec(compile(src, 'mig', 'exec'), mig.__dict__)

def local_files():
    out = {}
    for f in os.listdir(SRC):
        m = re.search(r'(\d+)', f)
        if m and f.endswith('.mp4'):
            n = str(int(m.group(1)))
            if n not in out or '(' not in f:
                out[n] = os.path.join(SRC, f)
    return out

def main():
    files = local_files()
    meta = mig.bsm.load_meta()
    done = mig.r2_existing()
    todo = sorted(files, key=int)
    print(f'{len(todo)} local videos | in R2: {len(done)} | timestamps: {len(meta)}', flush=True)
    fails = []
    for idx, n in enumerate(todo, 1):
        r2key = f'satsang-diksha/shloka-{n}.mp4'
        need_upload = r2key not in done
        need_meta = n not in meta
        if not need_upload and not need_meta:
            continue
        path = files[n]
        size = os.path.getsize(path)
        if need_meta:
            t = mig.bsm.detect(path)
            if t is None:
                fails.append(n)
                print(f'[{idx}/{len(todo)}] #{n}: NO TIMESTAMP (uploads anyway)', flush=True)
            else:
                meta[n] = t
        if need_upload:
            stored = mig.r2_put(r2key, path)
            if stored != size:
                raise RuntimeError(f'{r2key}: local {size} but R2 stored {stored}')
        print(f'[{idx}/{len(todo)}] #{n}: {"t="+str(meta[n])+"s " if n in meta else ""}'
              f'{"uploaded ok" if need_upload else "meta only"}', flush=True)
        if idx % 10 == 0:
            mig.bsm.save_meta(meta)
        time.sleep(1)
    mig.bsm.save_meta(meta)
    print(f'done. meta: {len(meta)} entries, no-timestamp: {fails}', flush=True)

if __name__ == '__main__':
    main()
