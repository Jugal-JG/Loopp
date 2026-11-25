type AudioSink = (data: string, mime: string) => boolean;
type SpeechAttempt = { name: string; speak: (onAudio: AudioSink) => Promise<void> };

export async function playSpeechWithFallback(
  attempts: SpeechAttempt[], onAudio: AudioSink, onBrowser: () => void,
  onFailure: (provider: string, error: unknown) => void, disconnected: () => boolean,
) {
  for (const attempt of attempts) {
    if (disconnected()) return;
    let started = false;
    try {
      await attempt.speak((data, mime) => {
        const accepted = onAudio(data, mime);
        started ||= accepted;
        return accepted;
      });
      if (started || disconnected()) return;
      throw new Error('No audio was generated');
    } catch (error) {
      onFailure(attempt.name, error);
      if (started) throw error;
    }
  }
  if (!disconnected()) onBrowser();
}
