---
name: ElevenLabs TTS conversion
description: How dialogue-to-audio works and the account-tier constraint that shaped it
---
- POST /api/tts/convert turns speaker-labeled text (NAME: or Speaker N:) into MP3/WAV; each distinct speaker gets a voice from a hardcoded pool of 8 premade ElevenLabs voice IDs.
- **Constraint:** the user's ElevenLabs key is NOT Pro tier — `pcm_*` output formats return 403 subscription_required. Only mp3 formats work.
- **How to apply:** never request PCM from ElevenLabs here; WAV is produced by transcoding concatenated MP3 with ffmpeg (available in the Nix runtime path).
- tsx dev server does NOT hot-reload dynamically-imported server modules — restart the workflow after editing them or you'll test stale code.
