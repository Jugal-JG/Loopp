type AudioSink = (data: string, mime: string) => boolean;
type SpeechAttempt = { name: string; firstAudioMs?: number; speak: (onAudio: AudioSink, signal: AbortSignal) => Promise<void> };

export async function playSpeechWithFallback(
  attempts: SpeechAttempt[], onAudio: AudioSink, onBrowser: () => void,
  onFailure: (provider: string, error: unknown) => void, disconnected: () => boolean,
) {
  for (const attempt of attempts) {
    if (disconnected()) return;
    let started = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const speech = attempt.speak((data, mime) => {
        if (controller.signal.aborted || disconnected()) return false;
        const accepted = onAudio(data, mime);
        started ||= accepted;
        if (started) clearTimeout(timer);
        return accepted;
      }, controller.signal);
      if (attempt.firstAudioMs && !started) {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new DOMException('Speech provider did not produce audio in time', 'TimeoutError'));
            controller.abort();
          }, attempt.firstAudioMs);
        });
        await Promise.race([speech, deadline]);
      } else await speech;
      if (started || disconnected()) return;
      throw new Error('No audio was generated');
    } catch (error) {
      onFailure(attempt.name, error);
      if (started) throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!disconnected()) onBrowser();
}
