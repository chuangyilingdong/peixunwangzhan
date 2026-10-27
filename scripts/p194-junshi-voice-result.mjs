import assert from 'node:assert/strict';
import { extractSpeakerId, parseAudioTaskResult } from '../apps/server/src/services/junshiAvatar.js';

const minimax = {
  code: 'success',
  message: '',
  data: {
    status: 'SUCCESS',
    task_id: 'task_test',
    data: {
      status: 'succeeded',
      content: { audio_url: 'https://cdn.example/output/voice-sample.mp3' },
      upstream: { response: { results: [{ outputType: 'mp3', url: 'https://cdn.example/output/voice-sample.mp3' }] } },
    },
    request_data: JSON.stringify({ metadata: { custom_voice_id: 'voiceFake12345' } }),
  },
};
const minimaxResult = parseAudioTaskResult(minimax);
assert.equal(minimaxResult.url, 'https://cdn.example/output/voice-sample.mp3');
assert.equal(minimaxResult.resultText, '');
assert.equal(extractSpeakerId(minimax), '');

assert.equal(parseAudioTaskResult({ result_text: 'success' }).resultText, '');
assert.equal(parseAudioTaskResult({ result_text: 'spk_abc12345' }).resultText, 'spk_abc12345');
assert.equal(parseAudioTaskResult({ result_text: '{"speaker_id":"spk_json12345"}' }).resultText, 'spk_json12345');
assert.equal(parseAudioTaskResult({ data: { upstream: { response: { results: [{ outputType: 'text', text: '{"speaker_id":"spk_nested12345"}' }] } } } }).resultText, 'spk_nested12345');
assert.equal(parseAudioTaskResult({ data: { request_data: JSON.stringify({ metadata: { custom_voice_id: 'voiceFake12345' } }), upstream: { response: { results: [{ outputType: 'mp3', url: 'https://cdn.example/output.mp3' }] } } } }).resultText, '');

console.log(JSON.stringify({ name: 'junshi-voice-result-parser', pass: true, minimaxResult, speakerId: extractSpeakerId({ data: { speaker_id: 'spk_final12345' } }) }));
