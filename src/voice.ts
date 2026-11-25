import { GoogleGenAI, Modality } from '@google/genai';

export type VoiceCallbacks = {
  partial: (text: string) => void;
  final: (text: string, speechEnd: number) => void;
  failure: (message: string) => void;
  notice: (message: string) => void;
  phase: (state: string) => void;
  wave: (level: number) => void;
  usage: (metadata: unknown) => void;
};

function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

export async function startVoice(callbacks: VoiceCallbacks, signal: AbortSignal) {
  const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  const context = new AudioContext();
  let session: Awaited<ReturnType<GoogleGenAI['live']['connect']>> | undefined;
  const players = new Set<AudioBufferSourceNode>();
  let playbackCursor = 0;
  let frame = 0;
  let epoch = 0;
  let closed = false;
  let muted = false;
  let speechEnd = performance.now();
  let lastLoud = 0;
  let loudFrames = 0;
  let level = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finalizationTimer: ReturnType<typeof setTimeout> | undefined;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  let interim = '';
  let awaitingFinal = false;
  let usedInterim = false;
  const analyser = context.createAnalyser();
  const waveform = new Float32Array(analyser.fftSize);
  analyser.connect(context.destination);
  function interrupt() {
    epoch++;
    if (fallback) {
      fallback = undefined;
      window.speechSynthesis.cancel();
      callbacks.phase('Listening');
    }
    if (players.size) {
      for (const source of players) source.stop();
      players.clear();
      playbackCursor = 0;
      callbacks.phase('Listening');
    }
  }
  let fallback: SpeechSynthesisUtterance | undefined;
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearTimeout(finalizationTimer);
    clearTimeout(silenceTimer);
    signal.removeEventListener('abort', close);
    interrupt();
    if (session) session.close();
    media.getTracks().forEach(track => track.stop());
    cancelAnimationFrame(frame);
    void context.close();
  }
  signal.addEventListener('abort', close, { once: true });
  try {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    await context.resume();
    const response = await fetch('/api/support?action=voice', { method: 'POST', signal });
    const token = await response.json();
    if (!response.ok) throw new Error(token.message || 'Voice is unavailable');
    await context.audioWorklet.addModule('/mic-worklet.js');
    const ai = new GoogleGenAI({ apiKey: token.token, httpOptions: { apiVersion: 'v1alpha' } });
    let ready!: () => void;
    let rejectReady!: (error: Error) => void;
    const setup = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
    void setup.catch(() => {});
    function fail(message: string) {
      if (closed) return;
      rejectReady(new Error(message));
      close();
      callbacks.failure(message);
    }
    const connecting = ai.live.connect({
      model: 'gemini-3.5-transcribe-live',
      config: { responseModalities: [Modality.TEXT], inputAudioTranscription: { languageCodes: [] } },
      callbacks: {
        onmessage: message => {
          if (closed) return;
          if (message.setupComplete) ready();
          if (message.usageMetadata) callbacks.usage(message.usageMetadata);
          if (muted) return;
          const content = message.serverContent;
          const preview = content?.interimInputTranscription?.text?.trim();
          if (preview && !usedInterim) {
            interim = preview;
            callbacks.partial(preview);
            if (!awaitingFinal) {
              clearTimeout(silenceTimer);
              silenceTimer = setTimeout(finishSpeech, 900);
            }
          }
          const text = content?.inputTranscription?.text?.trim();
          if (text && !usedInterim) submitTranscript(text);
        },
        onerror: () => fail('Live transcription disconnected. Turn voice back on to retry.'),
        onclose: () => fail('Voice session ended. Turn voice back on to reconnect.'),
      },
    });
    timer = setTimeout(() => fail('Live transcription did not start. Try voice again.'), 10_000);
    void connecting.then(connection => { if (closed) connection.close(); }).catch(() => {});
    await Promise.race([setup.then(() => connecting), connecting]);
    session = await connecting;
    if (closed) throw new Error('Voice session ended during setup.');
    clearTimeout(timer);
    timer = setTimeout(() => fail('Voice session expired. Turn voice back on to continue.'), 4.5 * 60_000);
    const mic = context.createMediaStreamSource(media);
    const worklet = new AudioWorkletNode(context, 'loopp-mic');
    const silent = context.createGain();
    silent.gain.value = 0;
    worklet.connect(silent).connect(context.destination);
    mic.connect(worklet);
    let audioFrames: Int16Array[] = [];
    let buffered = 0;
    function submitTranscript(text: string) {
      clearTimeout(finalizationTimer);
      clearTimeout(silenceTimer);
      awaitingFinal = false;
      interim = '';
      speechEnd = lastLoud || performance.now();
      interrupt();
      callbacks.partial('');
      callbacks.phase('Listening');
      callbacks.final(text, speechEnd);
    }
    function finishSpeech() {
      if (closed || muted || !session || awaitingFinal || usedInterim) return;
      clearTimeout(silenceTimer);
      try {
        for (const frame of audioFrames) session.sendRealtimeInput({ audio: { data: encode(new Uint8Array(frame.buffer)), mimeType: 'audio/pcm;rate=16000' } });
        audioFrames = [];
        buffered = 0;
        session.sendRealtimeInput({ audioStreamEnd: true });
        awaitingFinal = true;
        callbacks.phase('Transcribing…');
        finalizationTimer = setTimeout(() => {
          if (interim) {
            usedInterim = true;
            submitTranscript(interim);
          } else {
            awaitingFinal = false;
            callbacks.phase('Listening');
            callbacks.partial('');
            callbacks.notice('No speech was transcribed. Try speaking again or use chat.');
          }
        }, 1800);
      } catch { fail('Live transcription disconnected. Reconnect voice or use chat.'); }
    }
    worklet.port.onmessage = event => {
      if (closed || muted || !session) return;
      const pcm = event.data as Int16Array;
      level = Math.sqrt(pcm.reduce((sum, sample) => sum + (sample / 32768) ** 2, 0) / pcm.length);
      loudFrames = level > 0.033 ? loudFrames + 1 : 0;
      if (loudFrames >= 2) {
        lastLoud = performance.now();
        if (loudFrames === 2) {
          usedInterim = false;
          interrupt();
        }
        if (!awaitingFinal && interim) {
          clearTimeout(silenceTimer);
          silenceTimer = setTimeout(finishSpeech, 900);
        }
      }
      if (awaitingFinal) return;
      audioFrames.push(pcm);
      buffered += pcm.length;
      if (buffered < 1600) return;
      const packet = new Int16Array(buffered);
      let offset = 0;
      for (const frame of audioFrames) { packet.set(frame, offset); offset += frame.length; }
      audioFrames = [];
      buffered = 0;
      try {
        session.sendRealtimeInput({ audio: { data: encode(new Uint8Array(packet.buffer)), mimeType: 'audio/pcm;rate=16000' } });
      } catch { fail('Could not send microphone audio. Reconnect voice or use chat.'); }
    };
    function draw() {
      if (closed) return;
      analyser.getFloatTimeDomainData(waveform);
      const outgoing = players.size ? Math.sqrt(waveform.reduce((sum, value) => sum + value * value, 0) / waveform.length) : 0;
      callbacks.wave(Math.min(1, Math.max(level, outgoing) * 6));
      frame = requestAnimationFrame(draw);
    }
    frame = requestAnimationFrame(draw);
    callbacks.phase('Listening');
    return {
      close,
      setMuted(value: boolean) {
        muted = value;
        media.getAudioTracks().forEach(track => { track.enabled = !value; });
        level = loudFrames = lastLoud = buffered = 0;
        audioFrames = [];
        clearTimeout(finalizationTimer);
        clearTimeout(silenceTimer);
        awaitingFinal = false;
        interim = '';
        usedInterim = value;
        callbacks.partial('');
        if (value) {
          try { session?.sendRealtimeInput({ audioStreamEnd: true }); } catch { fail('Live transcription disconnected. Reconnect voice to retry.'); }
        }
      },
      currentEpoch: () => epoch,
      finishSpeech,
      speakLocally(text: string, expectedEpoch: number, onStart: () => void, onError: () => void) {
        if (closed || epoch !== expectedEpoch || !('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return false;
        const utterance = new SpeechSynthesisUtterance(text);
        const englishVoices = window.speechSynthesis.getVoices().filter(voice => /^en\b/i.test(voice.lang));
        const female = /\b(zira|jenny|aria|samantha|karen|moira|tessa|veena|victoria|female)\b/i;
        const preferred = englishVoices.find(voice => voice.localService && female.test(voice.name))
          ?? englishVoices.find(voice => female.test(voice.name));
        if (preferred) utterance.voice = preferred;
        fallback = utterance;
        const finish = () => {
          if (fallback !== utterance) return;
          fallback = undefined;
          callbacks.phase('Listening');
        };
        utterance.onstart = () => {
          if (fallback !== utterance) return;
          callbacks.phase('Speaking');
          onStart();
        };
        utterance.onend = finish;
        utterance.onerror = () => {
          if (fallback !== utterance) return;
          finish();
          onError();
        };
        window.speechSynthesis.speak(utterance);
        return true;
      },
      async play(base64: string, mime: string, expectedEpoch: number) {
        if (closed || epoch !== expectedEpoch) return false;
        const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
        let audio: AudioBuffer;
        if (/l16|pcm/i.test(mime) && bytes.length >= 2) {
          const samples = new DataView(bytes.buffer);
          audio = context.createBuffer(1, Math.floor(bytes.length / 2), 24000);
          const channel = audio.getChannelData(0);
          for (let index = 0; index < channel.length; index++) channel[index] = samples.getInt16(index * 2, true) / 32768;
        } else audio = await context.decodeAudioData(bytes.buffer);
        if (closed || epoch !== expectedEpoch) return false;
        const source = context.createBufferSource();
        players.add(source);
        source.buffer = audio;
        source.connect(analyser);
        source.onended = () => {
          source.disconnect();
          if (players.delete(source) && !players.size) callbacks.phase('Listening');
        };
        const startAt = Math.max(context.currentTime + 0.025, playbackCursor);
        source.start(startAt);
        playbackCursor = startAt + audio.duration;
        callbacks.phase('Speaking');
        return true;
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
