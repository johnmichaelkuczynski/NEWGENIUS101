export type AudioPopupDescriptor = {
  id: string;
  title: string;
  filename?: string;
};

export function supportsMultiSpeakerAudio(
  popup: AudioPopupDescriptor | null | undefined,
): boolean {
  if (!popup || popup.id.startsWith("paper-")) return false;

  return /dialogue|debate|interview/i.test(
    `${popup.id} ${popup.title} ${popup.filename || ""}`,
  );
}