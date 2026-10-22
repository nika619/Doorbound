"""The film's timeline and its sound, from the voice lines: when each line and word is said (timeline.json,
which drives the picture) and the whole mix (mix.wav): voices, a synthesized score that ducks under them,
a clock tick for the time pressure, flap clatter and whooshes on the cuts. No samples, no third-party music.
  ~/.claude/venvs/motion-audio/Scripts/python video/mix.py
"""
import json
import numpy as np
import librosa
import soundfile as sf

SR = 48000
FPS = 60
OUT = 'video/out'
script = json.load(open('video/script.json', encoding='utf-8'))

# ---------- timeline: each line after the last, with its pause; words from ElevenLabs' character timings
t = script['lead']
lines, clips = [], []
for line in script['lines']:
    meta = json.load(open(f"{OUT}/voice/{line['id']}.json", encoding='utf-8'))
    y, _ = librosa.load(f"{OUT}/voice/{line['id']}.mp3", sr=SR, mono=True)
    a = meta['alignment']
    words, cur = [], None
    for ch, s, e in zip(a['characters'], a['character_start_times_seconds'], a['character_end_times_seconds']):
        if ch.isspace():
            cur = None
            continue
        if cur is None:
            cur = {'w': '', 't0': round(t + s, 3)}
            words.append(cur)
        cur['w'] += ch
        cur['t1'] = round(t + e, 3)
    hop = SR // FPS  # loudness per film frame, 0..1, for the light bar and the speaker's pulse
    rms = np.sqrt(np.convolve(y ** 2, np.ones(hop) / hop, 'same'))[::hop]
    env = np.clip(rms / (np.percentile(rms, 98) + 1e-9), 0, 1)
    lines.append({'id': line['id'], 'who': line['who'], 'text': line['text'], 'start': round(t, 3), 'end': round(t + len(y) / SR, 3), 'words': words, 'env': [round(float(v), 2) for v in env]})
    clips.append((t, y))
    t += len(y) / SR + line['pause']
total = round(t, 3)
at = {l['id']: l for l in lines}
json.dump({'fps': FPS, 'total': total, 'lines': lines}, open(f'{OUT}/timeline.json', 'w', encoding='utf-8'))
# The same for the film page: a browser will not fetch a local JSON file, but it will run a local script.
open(f'{OUT}/timeline.js', 'w', encoding='utf-8').write('window.TL = ' + json.dumps({'fps': FPS, 'total': total, 'lines': lines}) + ';\n')

# ---------- the score
n = int(total * SR)
time = np.arange(n) / SR
rng = np.random.default_rng(7)  # seeded: the same film every time
voice = np.zeros(n)
for start, y in clips:
    i = int(start * SR)
    voice[i:i + len(y)] += y[: n - i]

def tone(f, dur, env_a=0.02, env_r=0.4):
    tt = np.arange(int(dur * SR)) / SR
    return np.sin(2 * np.pi * f * tt) * np.minimum(1, tt / env_a) * np.exp(-tt / env_r)

def place(buf, sig, sec, gain=1.0):
    i = int(sec * SR)
    if i < n:
        buf[i:i + len(sig)] += gain * sig[: n - i]

# A warm pad: Dmaj9 / Bm9 / Gmaj7 / A6sus, four seconds a chord, slow swells, partials kept above 150 Hz.
CHORDS = [[146.8, 220.0, 277.2, 329.6, 440.0], [123.5, 185.0, 220.0, 293.7, 370.0], [196.0, 246.9, 293.7, 370.0, 493.9], [220.0, 277.2, 329.6, 370.0, 493.9]]
pad = np.zeros(n)
for k in range(int(total / 4) + 1):
    seg = np.arange(int(4.6 * SR)) / SR
    swell = np.sin(np.pi * np.clip(seg / 4.6, 0, 1)) ** 1.5
    chord = sum(np.sin(2 * np.pi * f * 2 * seg + i) * 0.5 + np.sin(2 * np.pi * f * 1.003 * 2 * seg) * 0.5 for i, f in enumerate(CHORDS[k % 4])) / 5
    place(pad, chord * swell, k * 4)
# The clock: a soft tick at 90 BPM while the problem is told, then gone.
tick = np.zeros(n)
click = tone(2600, 0.03, 0.001, 0.008) + rng.normal(0, 1, int(0.03 * SR)) * np.exp(-np.arange(int(0.03 * SR)) / SR / 0.004) * 0.3
for b in np.arange(0.4, at['s1']['start'], 60 / 90):
    place(tick, click, b, 0.9 if int(round(b / (60 / 90))) % 2 == 0 else 0.55)
# Flaps: a burst of short clicks; whooshes: shaped noise swelling into a cut.
def clatter(count, spread):
    out = np.zeros(int((spread + 0.05) * SR))
    for c in rng.uniform(0, spread, count):
        i = int(c * SR)
        burst = rng.normal(0, 1, 400) * np.exp(-np.arange(400) / 60)
        out[i:i + 400] += burst[: len(out) - i]
    return out
def whoosh(dur):
    tt = np.arange(int(dur * SR)) / SR
    noise = np.convolve(rng.normal(0, 1, len(tt)), np.ones(24) / 24, 'same')
    return noise * np.sin(np.pi * tt / dur) ** 3
sfx = np.zeros(n)
place(sfx, clatter(60, 1.1), 0.25, 0.25)                          # the 7:52 flaps in
place(sfx, whoosh(1.2), at['s1']['start'] - 0.9, 0.5)               # into the reveal
place(sfx, clatter(40, 0.8), at['s1']['start'] + 0.4, 0.2)          # the wordmark flaps
place(sfx, whoosh(0.9), at['d9']['start'] - 0.6, 0.35)              # the re-route
place(sfx, clatter(50, 0.9), at['d9']['start'] + 0.1, 0.22)
for f, d in ((659.25, 0), (987.77, 0.14)):                          # the board's own chime, at the finale
    place(sfx, tone(f, 1.2, 0.01, 0.5), at['d14']['start'] + d, 0.18)
place(sfx, whoosh(1.4), at['b1']['start'] - 1.0, 0.4)               # into how it is built
place(sfx, whoosh(1.4), at['c1']['start'] - 1.0, 0.45)              # into the close
for f, d in ((440.0, 0), (659.25, 0.18), (880.0, 0.36)):            # the last chord rings out
    place(sfx, tone(f, 2.6, 0.02, 1.2), at['c1']['start'] + 0.2 + d, 0.12)

# Duck the music under any voice: an envelope follower, 60 ms attack, 600 ms release, -9 dB at full voice.
vf = np.abs(voice)
duck = np.zeros(n)
lvl, att, rel = 0.0, np.exp(-1 / (0.06 * SR)), np.exp(-1 / (0.6 * SR))
step = 64
for i in range(0, n, step):
    target = min(1.0, vf[i:i + step].max() * 4)
    lvl = target + (lvl - target) * (att if target > lvl else rel) ** step
    duck[i:i + step] = lvl
music = (pad * 0.11 + tick * 0.05) * (1 - 0.65 * duck)
fade = np.minimum(1, time / 1.5) * np.minimum(1, (total - time) / 2.5)
# Voices and effects centred; the score 5 ms later in the right ear, for width.
wide = np.concatenate([np.zeros(240), music[:-240]])
left = (voice * 0.95 + sfx + music) * fade
right = (voice * 0.95 + sfx + wide) * fade
peak = max(np.abs(left).max(), np.abs(right).max())
sf.write(f'{OUT}/mix.wav', (np.stack([left, right], 1) / peak * 0.89).astype(np.float32), SR, subtype='PCM_24')
print(f'timeline {total:.1f} s, {len(lines)} lines; mix written')
