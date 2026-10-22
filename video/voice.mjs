// Every spoken line of the film, from ElevenLabs, with each character's timing (for the subtitles).
// Cached: a line is fetched again only when its text or voice changes.
//   node video/voice.mjs        (needs ELEVENLABS_API_KEY in .env; about 1,900 characters of credit)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('Put ELEVENLABS_API_KEY=... in .env first.');
const { voices, model, lines } = JSON.parse(readFileSync('video/script.json', 'utf8'));
const dir = 'video/out/voice';
mkdirSync(dir, { recursive: true });

for (const [i, line] of lines.entries()) {
  const voice = voices[line.who];
  const hash = createHash('sha256').update(`${model}|${voice.id}|${line.text}`).digest('hex').slice(0, 12);
  const meta = `${dir}/${line.id}.json`;
  if (existsSync(meta) && JSON.parse(readFileSync(meta, 'utf8')).hash === hash) continue;
  // The narrator's neighbouring lines, so one voice reads the film as one performance.
  const near = (d) => lines.slice(i + d).find((l, j) => j < 3 && l.who === line.who)?.text;
  const body = { text: line.text, model_id: model, ...(line.who === 'narrator' ? { previous_text: [...lines.slice(0, i)].reverse().find((l) => l.who === 'narrator')?.text, next_text: near(1) } : {}) };
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.id}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${line.id}: ElevenLabs ${r.status} ${(await r.text()).slice(0, 200)}`);
  const { audio_base64, alignment } = await r.json();
  writeFileSync(`${dir}/${line.id}.mp3`, Buffer.from(audio_base64, 'base64'));
  writeFileSync(meta, JSON.stringify({ hash, who: line.who, text: line.text, alignment }));
  console.log(`${line.id} (${voice.name})`);
}
