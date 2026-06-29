export function sanitizeForElevenLabs(text: string): string {
  if (!text) return '';

  let t = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/\*([^*\n]+)\*/g, '$1');
  t = t.replace(/__([^_]+)__/g, '$1');
  t = t.replace(/_([^_\n]+)_/g, '$1');

  const lines = t.split('\n');
  const speakerMap = new Map<string, string>();
  let nextSpeakerNum = 1;
  const cleaned: string[] = [];

  const explicitSpeakerRegex = /^\s*Speaker\s+(\d+)\s*:\s*(.+)$/i;
  const labelRegex = /^\s*(?:[#>\-]+\s*)?([A-Za-z][A-Za-z0-9 .'\-]{0,40}?)\s*:\s*(.+)$/;

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;

    if (/^[\(\[\*][^\)\]\*]*[\)\]\*]\s*$/.test(line)) continue;
    if (/^[\-=_*]{3,}\s*$/.test(line)) continue;

    line = line.replace(/\([^)]*\)/g, '');
    line = line.replace(/\[[^\]]*\]/g, '');
    line = line.replace(/\*+/g, '');
    line = line.replace(/\s{2,}/g, ' ').trim();
    if (!line) continue;

    let speakerLabel: string | null = null;
    let content: string | null = null;

    const ex = line.match(explicitSpeakerRegex);
    if (ex) {
      speakerLabel = `Speaker ${ex[1]}`;
      content = ex[2].trim();
    } else {
      const m = line.match(labelRegex);
      if (m) {
        const rawLabel = m[1].trim();
        if (rawLabel.length <= 40 && !rawLabel.includes('.')) {
          const key = rawLabel.toUpperCase();
          if (!speakerMap.has(key)) {
            speakerMap.set(key, `Speaker ${nextSpeakerNum++}`);
          }
          speakerLabel = speakerMap.get(key)!;
          content = m[2].trim();
        }
      }
    }

    if (!speakerLabel || !content) {
      continue;
    }

    cleaned.push(`${speakerLabel}: ${content}`);
  }

  const finalLines = cleaned.filter(l => /^Speaker \d+: .+$/.test(l));
  return finalLines.length ? finalLines.join('\n\n') + '\n' : '';
}

export function downloadAsUnixTxt(text: string, filename = 'dialogue.txt') {
  const normalized = text.replace(/\r\n/g, '\n');
  const blob = new Blob([normalized], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
