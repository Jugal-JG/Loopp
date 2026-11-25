import { AudioTranscriptionConfigMode, Modality } from '@google/genai';

export const liveModel = 'gemini-3.5-transcribe-live';
export const liveConfig = {
  responseModalities: [Modality.TEXT],
  inputAudioTranscription: { languageCodes: ['en-US'], mode: AudioTranscriptionConfigMode.VERBATIM },
};
