#!/usr/bin/env python3
"""Detect where the FULL-shlok chant starts in each Satsang Diksha video.

Mechanism: the videos highlight one line in yellow while it's being repeated;
when the closing full-shlok chant begins, the ENTIRE Gujarati block turns
yellow — the yellow-pixel count jumps ~2.5x and stays there to the end.
We sample frames at 4fps, count warm-yellow pixels in the text zone, and find
the first sustained jump past 1.6x the pre-jump maximum.

Usage:
  python3 scripts/build-sd-meta.py <file.mp4> [more.mp4 ...]   # local files
  python3 scripts/build-sd-meta.py --all                        # download all 315 from Drive

Videos must be named "Shloka #N.mp4" (or sN.mp4 / shlokaN.mp4) so N can be
parsed. Results merge into sd-meta.js (window.SD_META = { "N": seconds }).
Failures (no sustained jump) are reported and left out — the app falls back
to playing the whole video for those.
"""
import json, os, re, subprocess, sys, tempfile, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
META_JS = os.path.join(ROOT, 'sd-meta.js')
FOLDER_ID = '1YIqwJab0LgL17yaYFKtUzE4GlVpP7EQj'
FPS = 4
LEAD = 0.25            # start a beat before the detected jump frame
THRESH = 1.6           # jump multiplier vs pre-jump max
SUSTAIN = 0.8          # fraction of remaining frames that must stay elevated

def api_key():
    with open(os.path.join(ROOT, 'config.js')) as f:
        m = re.search(r"apiKey:\s*'([^']+)'", f.read())
    return m.group(1)

def yellow_counts(path):
    from PIL import Image
    import glob
    with tempfile.TemporaryDirectory() as td:
        subprocess.run(['ffmpeg', '-y', '-v', 'quiet', '-i', path,
                        '-vf', f'fps={FPS},scale=270:480', os.path.join(td, 'f_%04d.png')],
                       check=True)
        counts = []
        for fp in sorted(glob.glob(os.path.join(td, 'f_*.png'))):
            im = Image.open(fp).convert('RGB')
            w, h = im.size
            px = im.load()
            n = 0
            for y in range(int(h * 0.25), int(h * 0.75)):
                for x in range(0, w, 2):
                    r, g, b = px[x, y]
                    if r > 200 and 150 < g < 220 and b < 110:
                        n += 1
            counts.append(n)
        return counts

def rms_envelope(path, hz=16000, win_ms=50):
    """Mono RMS envelope, one value per win_ms."""
    import array, math
    raw = subprocess.run(['ffmpeg', '-v', 'quiet', '-i', path, '-ac', '1',
                          '-ar', str(hz), '-f', 's16le', '-'],
                         capture_output=True).stdout
    a = array.array('h'); a.frombytes(raw)
    W = hz * win_ms // 1000
    env = []
    for i in range(0, len(a) - W, W):
        t = 0
        for j in range(i, i + W, 4):
            t += a[j] * a[j]
        env.append(math.sqrt(t / (W / 4)))
    return env, 1000 / win_ms   # env, windows-per-second

def audio_refine(path, t_v):
    """The visual jump is frame-quantized and lags/leads the voice. Find the
    energy valley nearest t_v (the pause between the last line-repeat and the
    full chant), then the onset that follows it; start 0.25s of white space
    before that onset."""
    env, wps = rms_envelope(path)
    if not env:
        return None
    lo = max(0, int((t_v - 3) * wps)); hi = min(len(env), int((t_v + 3) * wps))
    region = sorted(env[lo:hi])
    if len(region) < 20:
        return None
    ref = region[int(len(region) * 0.8)]           # typical chant level
    dip_th, onset_th = ref * 0.45, ref * 0.8
    runs = []                                       # (mid_t, end_idx) of dips
    i = max(0, int((t_v - 1.5) * wps)); end = min(len(env), int((t_v + 2.5) * wps))
    while i < end:
        if env[i] < dip_th:
            j = i
            while j < end and env[j] < dip_th:
                j += 1
            if j - i >= 3:                          # >=150ms of hush
                runs.append((((i + j) / 2) / wps, j))
            i = j
        else:
            i += 1
    best = None
    for mid_t, j in runs:
        for k in range(j, min(j + int(0.6 * wps), len(env))):
            if env[k] >= onset_th:                  # the chant's first syllable
                cand = k / wps
                d = abs(mid_t - t_v)
                if best is None or d < best[0]:
                    best = (d, cand)
                break
    if best is None:
        return None
    return round(max(0, best[1] - 0.25), 2)         # 0.25s of white space

def detect(path):
    counts = yellow_counts(path)
    if len(counts) < FPS * 10:
        return None
    for i in range(FPS * 5, len(counts) - FPS * 3):   # jump can't be in the first 5s
        base = max(counts[:i]) or 1
        if counts[i] > base * THRESH:
            rest = counts[i:]
            elevated = sum(1 for c in rest if c > base * THRESH)
            if elevated >= len(rest) * SUSTAIN:
                t_v = i / FPS
                refined = audio_refine(path, t_v)
                # trust audio only near the visual jump; else visual fallback
                if refined is not None and abs(refined - t_v) <= 2.0:
                    return refined
                return round(max(0, t_v - LEAD), 2)
    return None

def parse_num(name):
    m = re.search(r'(\d+)', os.path.basename(name))
    return str(int(m.group(1))) if m else None

def load_meta():
    if not os.path.exists(META_JS):
        return {}
    m = re.search(r'window\.SD_META\s*=\s*(\{.*?\});', open(META_JS).read(), re.S)
    return json.loads(m.group(1)) if m else {}

# Owner-verified corrections (2026-07-20) for videos whose layout defeats the
# detector: #222 fades to black for the chant, #267 chants over white text,
# #53's threshold was noise-poisoned. #284 (combined 283-284 video) has NO
# separate full-chant section: -1 = "always plays in full" (the app shows a
# gentle notice when line-repeats are toggled off).
MANUAL_OVERRIDES = {'53': 30.5, '222': 32.5, '267': 31.5, '284': -1}  # 0.5s lead per owner

def save_meta(meta):
    meta.update(MANUAL_OVERRIDES)
    ordered = {k: meta[k] for k in sorted(meta, key=int)}
    body = json.dumps(ordered, indent=2)
    with open(META_JS, 'w') as f:
        f.write('// Generated by scripts/build-sd-meta.py — seconds where the full-shlok\n'
                '// chant starts in each Mukhpath video (line-repeats end). Do not hand-edit.\n'
                f'window.SD_META = {body};\n')

def drive_list(key):
    url = (f'https://www.googleapis.com/drive/v3/files?q=%27{FOLDER_ID}%27+in+parents'
           f'+and+trashed=false&key={key}&pageSize=1000&fields=files(id,name)')
    files = json.load(urllib.request.urlopen(url)).get('files', [])
    out = {}
    for f in files:
        n = parse_num(f['name'])
        if n and (n not in out or '(' not in f['name']):
            out[n] = f['id']
    return out

def main():
    meta = load_meta()
    if '--all' in sys.argv:
        key = api_key()
        listing = drive_list(key)
        todo = [n for n in sorted(listing, key=int) if n not in meta]
        print(f'{len(todo)} shloks to analyze')
        fails = []
        for idx, n in enumerate(todo, 1):
            with tempfile.NamedTemporaryFile(suffix='.mp4') as tf:
                url = f'https://www.googleapis.com/drive/v3/files/{listing[n]}?alt=media&key={key}'
                for attempt in range(6):   # Drive rate-limits bursts: back off and retry
                    try:
                        tf.seek(0); tf.truncate()
                        tf.write(urllib.request.urlopen(url).read())
                        break
                    except urllib.error.HTTPError as e:
                        if e.code in (403, 429, 500, 503) and attempt < 5:
                            wait = 300 * (attempt + 1)   # long waits: the block is IP-level, do not poke it
                            print(f'  #{n}: HTTP {e.code}, retrying in {wait}s', flush=True)
                            time.sleep(wait)
                        else:
                            raise
                tf.flush()
                t = detect(tf.name)
            time.sleep(20)  # gentle pace — the app's real users share this key/network path
            if t is None:
                fails.append(n)
                print(f'[{idx}/{len(todo)}] #{n}: NO JUMP FOUND (skipped)', flush=True)
            else:
                meta[n] = t
                print(f'[{idx}/{len(todo)}] #{n}: {t}s', flush=True)
            if idx % 10 == 0:
                save_meta(meta)
        save_meta(meta)
        print(f'done: {len(meta)} entries, {len(fails)} failures: {fails}')
    else:
        for path in sys.argv[1:]:
            n = parse_num(path)
            if not n:
                print(f'{path}: cannot parse shlok number'); continue
            t = detect(path)
            if t is None:
                print(f'#{n}: NO JUMP FOUND')
            else:
                meta[n] = t
                print(f'#{n}: {t}s')
        save_meta(meta)
        print(f'saved {META_JS} ({len(meta)} entries)')

if __name__ == '__main__':
    main()
