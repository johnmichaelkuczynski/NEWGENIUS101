const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1";

const VOICE_POOL: { id: string; name: string }[] = [
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam (deep male)" },
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel (calm female)" },
  { id: "ErXwobaYiN019PkySvjV", name: "Antoni (warm male)" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah (soft female)" },
  { id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh (young male)" },
  { id: "AZnzlk1XvdvUeBnXmlld", name: "Domi (strong female)" },
  { id: "VR6AewLTigWG4xSOukaG", name: "Arnold (crisp male)" },
  { id: "MF3mGyEYCl7XYWbV9V6O", name: "Elli (emotional female)" },
];

const MAX_CHARS_PER_REQUEST = 4500;
const PCM_SAMPLE_RATE = 44100;

export interface SpeakerSegment {
  speaker: string;
  text: string;
}

export function parseSpeakerSegments(rawText: string): SpeakerSegment[] {
  if (!rawText) return [];

  let t = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/\*([^*\n]+)\*/g, "$1");
  t = t.replace(/__([^_]+)__/g, "$1");
  t = t.replace(/_([^_\n]+)_/g, "$1");

  const explicitSpeakerRegex = /^\s*Speaker\s+(\d+)\s*:\s*(.+)$/i;
  const labelRegex = /^\s*(?:[#>\-]+\s*)?([A-Za-z][A-Za-z0-9 .'\-]{0,40}?)\s*:\s*(.+)$/;

  const segments: SpeakerSegment[] = [];

  for (const rawLine of t.split("\n")) {
    let line = rawLine.trim();
    if (!line) continue;
    if (/^[\(\[\*][^\)\]\*]*[\)\]\*]\s*$/.test(line)) continue;
    if (/^[\-=_*]{3,}\s*$/.test(line)) continue;

    line = line.replace(/\([^)]*\)/g, "");
    line = line.replace(/\[[^\]]*\]/g, "");
    line = line.replace(/\*+/g, "");
    line = line.replace(/\s{2,}/g, " ").trim();
    if (!line) continue;

    let speaker: string | null = null;
    let content: string | null = null;

    const ex = line.match(explicitSpeakerRegex);
    if (ex) {
      speaker = `Speaker ${ex[1]}`;
      content = ex[2].trim();
    } else {
      const m = line.match(labelRegex);
      if (m) {
        const rawLabel = m[1].trim();
        if (rawLabel.length <= 40 && !rawLabel.includes(".")) {
          speaker = rawLabel.toUpperCase();
          content = m[2].trim();
        }
      }
    }

    if (!speaker || !content) {
      // Continuation of the previous speaker's paragraph
      if (segments.length > 0) {
        segments[segments.length - 1].text += " " + line;
      }
      continue;
    }

    const last = segments[segments.length - 1];
    if (last && last.speaker === speaker) {
      last.text += " " + content;
    } else {
      segments.push({ speaker, text: content });
    }
  }

  return segments.filter((s) => s.text.trim().length > 0);
}

export function assignVoices(segments: SpeakerSegment[]): Map<string, { id: string; name: string }> {
  const map = new Map<string, { id: string; name: string }>();
  for (const seg of segments) {
    if (!map.has(seg.speaker)) {
      map.set(seg.speaker, VOICE_POOL[map.size % VOICE_POOL.length]);
    }
  }
  return map;
}

function splitLongText(text: string): string[] {
  if (text.length <= MAX_CHARS_PER_REQUEST) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_CHARS_PER_REQUEST) {
    let cut = remaining.lastIndexOf(". ", MAX_CHARS_PER_REQUEST);
    if (cut < MAX_CHARS_PER_REQUEST * 0.5) {
      cut = remaining.lastIndexOf(" ", MAX_CHARS_PER_REQUEST);
    }
    if (cut <= 0) cut = MAX_CHARS_PER_REQUEST;
    chunks.push(remaining.slice(0, cut + 1).trim());
    remaining = remaining.slice(cut + 1).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function ttsRequest(
  apiKey: string,
  voiceId: string,
  text: string,
): Promise<Buffer> {
  const res = await fetch(
    `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    },
  );

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`ElevenLabs API error ${res.status}: ${errBody.slice(0, 500)}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

async function mp3ToWav(mp3: Buffer): Promise<Buffer> {
  const { spawn } = await import("node:child_process");
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = await mkdtemp(join(tmpdir(), "tts-"));
  const inPath = join(dir, "in.mp3");
  const outPath = join(dir, "out.wav");
  try {
    await writeFile(inPath, mp3);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-y",
        "-i", inPath,
        "-acodec", "pcm_s16le",
        "-ar", "44100",
        "-ac", "1",
        outPath,
      ]);
      let stderr = "";
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      });
    });
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface TtsResult {
  audio: Buffer;
  contentType: string;
  extension: string;
  voiceMap: Record<string, string>;
  segmentCount: number;
}

export async function convertDialogueToAudio(
  rawText: string,
  format: "mp3" | "wav",
): Promise<TtsResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is not set");
  }

  const segments = parseSpeakerSegments(rawText);
  if (segments.length === 0) {
    throw new Error(
      "No speaker lines found. Expected lines like 'SOCRATES: ...' or 'Speaker 1: ...'",
    );
  }

  const voices = assignVoices(segments);

  // Always fetch MP3 from ElevenLabs (PCM output requires Pro tier);
  // WAV is produced locally via ffmpeg transcode.
  const buffers: Buffer[] = [];
  for (const seg of segments) {
    const voice = voices.get(seg.speaker)!;
    for (const chunk of splitLongText(seg.text)) {
      const audio = await ttsRequest(apiKey, voice.id, chunk);
      buffers.push(audio);
    }
  }

  const voiceMap: Record<string, string> = {};
  voices.forEach((v, speaker) => {
    voiceMap[speaker] = v.name;
  });

  const mp3 = Buffer.concat(buffers);

  if (format === "wav") {
    return {
      audio: await mp3ToWav(mp3),
      contentType: "audio/wav",
      extension: "wav",
      voiceMap,
      segmentCount: segments.length,
    };
  }

  return {
    audio: mp3,
    contentType: "audio/mpeg",
    extension: "mp3",
    voiceMap,
    segmentCount: segments.length,
  };
}
