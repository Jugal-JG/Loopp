import { AudioTranscriptionConfigMode, GoogleGenAI, Modality } from '@google/genai';

export type VoiceCallbacks = {
  partial: (text: string) => void;
  final: (text: string, speechEnd: number, epoch: number) => void;
  failure: (message: string) => void;
  notice: (message: string) => void;
  phase: (state: string) => void;
  wave: (level: number) => void;
  usage: (metadata: unknown) => void;
};

const silenceMs = 450;
const interimFallbackMs = 650;
const transcriptStallMs = 10_000;
const speechOnsetLevel = 0.025;
const speechContinuationLevel = 0.015;
const playbackSpeechLevel = 0.035;
const playbackSpeechFrames = 6; // The worklet emits about 20 ms per frame.

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
  let lastLoud = 0;
  let loudFrames = 0;
  let level = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finalizationTimer: ReturnType<typeof setTimeout> | undefined;
  let transcriptTimeout: ReturnType<typeof setTimeout> | undefined;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  let interim = '';
  let pending: { speechEnd: number; epoch: number; submitted: boolean } | undefined;
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
    playbackCursor = 0;
    if (players.size) {
      for (const source of players) source.stop();
      players.clear();
      callbacks.phase('Listening');
    }
  }
  let fallback: SpeechSynthesisUtterance | undefined;
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearTimeout(finalizationTimer);
    clearTimeout(transcriptTimeout);
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
      config: { responseModalities: [Modality.TEXT], inputAudioTranscription: { languageCodes: [], mode: AudioTranscriptionConfigMode.VERBATIM } },
      callbacks: {
        onmessage: message => {
          if (closed) return;
          if (message.setupComplete) ready();
          if (message.usageMetadata) callbacks.usage(message.usageMetadata);
          const content = message.serverContent;
          const preview = content?.interimInputTranscription?.text?.trim();
          if (preview && !muted && !pending?.submitted) {
            interim = preview;
            callbacks.partial(preview);
            if (!pending && !lastLoud) {
              clearTimeout(silenceTimer);
              silenceTimer = setTimeout(finishSpeech, silenceMs);
            }
          }
          if (content?.inputTranscription) {
            const text = content.inputTranscription.text?.trim();
            if (pending) {
              const finished = pending;
              clearTimeout(finalizationTimer);
              clearTimeout(transcriptTimeout);
              pending = undefined;
              interim = '';
              if (!muted) {
                if (!finished.submitted) {
                  callbacks.phase('Listening');
                  if (text) submitTranscript(text, finished.speechEnd, finished.epoch);
                  else {
                    callbacks.partial('');
                    callbacks.notice('No speech was transcribed. Try speaking again or use chat.');
                  }
                }
                if (lastLoud) {
                  sendBufferedAudio();
                  clearTimeout(silenceTimer);
                  silenceTimer = setTimeout(finishSpeech, Math.max(0, silenceMs - (performance.now() - lastLoud)));
                }
              }
            } else if (!muted && text && (lastLoud || interim)) {
              clearTimeout(silenceTimer);
              const speechEnd = lastLoud || performance.now();
              lastLoud = 0;
              interim = '';
              submitTranscript(text, speechEnd, epoch);
            }
          }
        },
        onerror: () => fail('Live transcription disconnected. Turn voice back on to retry.'),
        onclose: event => {
          if (!closed) console.warn('Gemini Live socket closed', { code: event.code });
          fail('Voice session ended. Turn voice back on to reconnect.');
        },
      },
    });
    timer = setTimeout(() => fail('Live transcription did not start. Try voice again.'), 10_000);
    void connecting.then(connection => { if (closed) connection.close(); }).catch(() => {});
    [session] = await Promise.all([connecting, setup]);
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
    let playbackPreRoll: Int16Array[] = [];
    let buffered = 0;
    function submitTranscript(text: string, speechEnd: number, speechEpoch: number) {
      callbacks.partial('');
      callbacks.final(text, speechEnd, speechEpoch);
    }
    function sendBufferedAudio() {
      if (!session || !buffered) return;
      const packet = new Int16Array(buffered);
      let offset = 0;
      for (const frame of audioFrames) {
        packet.set(frame, offset);
        offset += frame.length;
      }
      audioFrames = [];
      buffered = 0;
      try {
        for (let start = 0; start < packet.length; start += 1600) {
          const samples = packet.subarray(start, start + 1600);
          const data = encode(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
          session.sendRealtimeInput({ audio: { data, mimeType: 'audio/pcm;rate=16000' } });
        }
      } catch { fail('Could not send microphone audio. Reconnect voice or use chat.'); }
    }
    function finishSpeech() {
      if (closed || muted || !session || pending || (!lastLoud && !interim)) return;
      clearTimeout(silenceTimer);
      sendBufferedAudio();
      if (closed) return;
      const utterance = { speechEnd: lastLoud || performance.now(), epoch, submitted: false };
      pending = utterance;
      lastLoud = 0;
      try {
        session.sendRealtimeInput({ audioStreamEnd: true });
      } catch {
        fail('Live transcription disconnected. Reconnect voice or use chat.');
        return;
      }
      callbacks.phase('Transcribing…');
      finalizationTimer = setTimeout(() => {
        if (!interim || muted) return;
        utterance.submitted = true;
        submitTranscript(interim, utterance.speechEnd, utterance.epoch);
        callbacks.phase('Listening');
      }, interimFallbackMs);
      function checkForStall() {
        if (closed || pending !== utterance) return;
        // Let new speech finish while its audio waits for the previous final.
        const idleFor = performance.now() - Math.max(utterance.speechEnd + silenceMs, lastLoud);
        if (idleFor < transcriptStallMs) {
          transcriptTimeout = setTimeout(checkForStall, transcriptStallMs - idleFor);
          return;
        }
        fail('Live transcription stalled. Reconnect voice or use chat.');
      }
      transcriptTimeout = setTimeout(checkForStall, transcriptStallMs);
    }
    worklet.port.onmessage = event => {
      if (closed || muted || !session) return;
      const pcm = event.data as Int16Array;
      level = Math.sqrt(pcm.reduce((sum, sample) => sum + (sample / 32768) ** 2, 0) / pcm.length);
      const playing = Boolean(fallback || players.size);
      const continuing = lastLoud && performance.now() - lastLoud < silenceMs;
      const threshold = playing ? playbackSpeechLevel : continuing ? speechContinuationLevel : speechOnsetLevel;
      loudFrames = level > threshold ? loudFrames + 1 : 0;
      if (playing) {
        // Keep the start of an interruption without streaming isolated sounds.
        if (!loudFrames) playbackPreRoll = [];
        else playbackPreRoll.push(pcm);
        if (loudFrames < playbackSpeechFrames) return;
        for (const frame of playbackPreRoll.slice(0, -1)) {
          audioFrames.push(frame);
          buffered += frame.length;
        }
        loudFrames = 2;
      }
      playbackPreRoll = [];
      if (loudFrames >= 2) {
        lastLoud = performance.now();
        if (loudFrames === 2) {
          interrupt();
          if (pending) callbacks.phase('Listening');
        }
        clearTimeout(silenceTimer);
        if (!pending) silenceTimer = setTimeout(finishSpeech, silenceMs);
      }
      // Keep capturing while Gemini finalizes the previous utterance. Send this
      // audio once its final arrives so a late final cannot consume new speech.
      audioFrames.push(pcm);
      buffered += pcm.length;
      if (!pending && buffered >= 1600) sendBufferedAudio();
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
        playbackPreRoll = [];
        clearTimeout(silenceTimer);
        interim = '';
        callbacks.partial('');
        if (value) {
          if (pending) pending.submitted = true;
          else {
            try { session?.sendRealtimeInput({ audioStreamEnd: true }); } catch { fail('Live transcription disconnected. Reconnect voice to retry.'); }
          }
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
